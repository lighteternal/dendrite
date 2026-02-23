import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import {
  handleOpenAiRateLimit,
  isOpenAiRateLimited,
} from "@/server/openai/rate-limit";
import { createTrackedOpenAIClient } from "@/server/openai/client";
import { extractRelationMentionsFast } from "@/server/agent/relation-mention-extractor";
import { getDrugTargetHints, searchDrugCandidates } from "@/server/mcp/chembl";
import {
  searchDiseases,
  searchDrugs,
  searchTargets,
  type DrugHit,
  type TargetHit,
} from "@/server/mcp/opentargets";

type MentionType =
  | "disease"
  | "target"
  | "drug"
  | "intervention"
  | "pathway"
  | "protein"
  | "molecule"
  | "effect"
  | "phenotype"
  | "anatomy"
  | "unknown";

type CandidateEntityType = "disease" | "target" | "drug";

export type QueryPlanAnchor = {
  mention: string;
  requestedType: MentionType;
  entityType: CandidateEntityType;
  id: string;
  name: string;
  description?: string;
  confidence: number;
  source: "opentargets" | "chembl";
};

export type QueryPlanConstraint = {
  text: string;
  polarity: "include" | "avoid" | "optimize";
};

export type QueryPlanFollowup = {
  question: string;
  reason: string;
  seedEntityIds: string[];
};

export type ResolvedQueryPlan = {
  query: string;
  intent: string;
  anchors: QueryPlanAnchor[];
  constraints: QueryPlanConstraint[];
  unresolvedMentions: string[];
  followups: QueryPlanFollowup[];
  rationale: string;
};

type CandidateRow = {
  mention: string;
  requestedType: MentionType;
  entityType: CandidateEntityType;
  id: string;
  name: string;
  description?: string;
  score: number;
  source: "opentargets" | "chembl";
};

type ExtractedMention = {
  mention: string;
  type: MentionType;
};

function getOpenAiClient() {
  return createTrackedOpenAIClient();
}

const planCache = createTTLCache<string, ResolvedQueryPlan>(
  Math.min(appConfig.cache.ttlMs, 3 * 60 * 1000),
  Math.min(appConfig.cache.maxEntries, 500),
);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function alnumCompact(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function tokenInitials(tokens: string[]): string {
  return tokens
    .map((token) => alnumCompact(token))
    .filter((token) => token.length > 0)
    .map((token) => token[0] ?? "")
    .join("");
}

function compact(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mentionHasSurfaceSupport(query: string, mention: string): boolean {
  const mentionDisplay = clean(mention);
  if (!mentionDisplay) return false;

  const queryNorm = normalize(query);
  const mentionNorm = normalize(mentionDisplay);
  if (!queryNorm || !mentionNorm) return false;
  if (queryNorm.includes(mentionNorm)) return true;

  const queryCompact = alnumCompact(query);
  const mentionCompact = alnumCompact(mentionDisplay);
  if (mentionCompact && queryCompact.includes(mentionCompact)) return true;

  const queryTokens = queryNorm.split(/\s+/).filter(Boolean);
  const mentionTokens = mentionNorm.split(/\s+/).filter(Boolean);
  if (mentionTokens.length !== 1) return false;
  const mentionToken = mentionTokens[0] ?? "";
  if (!mentionToken) return false;
  return queryTokens.some(
    (token) =>
      token === mentionToken ||
      token.startsWith(mentionToken) ||
      mentionToken.startsWith(token),
  );
}

function isMeasurementLike(name: string, description?: string): boolean {
  const text = `${name} ${description ?? ""}`.toLowerCase();
  return (
    text.includes("measurement") ||
    text.includes("quantification") ||
    text.includes("metabolite ratio") ||
    text.includes("in a sample") ||
    text.includes("concentration")
  );
}

function isLikelySymbolMention(mention: string): boolean {
  const normalized = mention.trim();
  if (!normalized || normalized.includes(" ")) return false;
  const compactMention = alnumCompact(normalized);
  if (!compactMention) return false;
  if (compactMention.length > 12) return false;
  return /[0-9]/.test(compactMention) || compactMention.length <= 6;
}

function isGenericMechanismMention(mention: string): boolean {
  const normalizedMention = clean(normalize(mention));
  if (!normalizedMention) return false;
  const tokens = normalizedMention.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  if (hasDiseaseCue(normalizedMention)) return false;
  const hasSymbolLikeToken = tokens.some((token) => /^[a-z]{1,6}\d{1,3}[a-z]?$/i.test(token.replace(/-/g, "")));
  if (hasSymbolLikeToken) return false;
  const genericTokens = tokens.filter((token) =>
    /^(?:inflammatory|immune|metabolic|cellular|molecular|inflammation|signaling|signal|pathway|pathways|mechanism|mechanistic|network|cascade|axis|events?)$/i.test(
      token,
    ),
  ).length;
  if (genericTokens === tokens.length) return true;
  return (
    genericTokens >= Math.max(1, tokens.length - 1) &&
    /\b(?:signaling|signal|pathway|pathways|mechanism|mechanistic|network|cascade|axis|events?)\b/i.test(
      normalizedMention,
    )
  );
}

function hasDiseaseCue(mention: string): boolean {
  return /\b(?:disease|disorder|syndrome|cancer|carcinoma|tumou?r|diabetes|obesity|lupus|arthritis|sclerosis|colitis|asthma|fibrosis|infection|infarction|failure|insufficienc(?:y|ies)|nephropathy|neuropathy|pregnancy|mesothelioma)\b/i.test(
    mention,
  );
}

function inferMentionTypeFromLexical(mention: string): MentionType {
  const normalizedMention = clean(mention);
  if (!normalizedMention) return "unknown";
  if (hasDiseaseCue(normalizedMention)) return "disease";
  if (/\b(?:drug|treatment|therapy|compound|inhibitor|agonist|antagonist|antibody)\b/i.test(normalizedMention)) {
    return "intervention";
  }
  if (isLikelySymbolMention(normalizedMention)) return "target";
  return "unknown";
}

function entityPreferenceBoost(
  mention: string,
  requestedType: MentionType,
  entityType: CandidateEntityType,
  name: string,
  description?: string,
): number {
  let boost = 0;

  if (entityType === "disease" && isMeasurementLike(name, description)) {
    boost -= 1.2;
  }

  if (requestedType === "target" || requestedType === "protein" || requestedType === "molecule") {
    if (entityType === "target") boost += 0.35;
    if (entityType === "disease") boost -= 0.45;
  }

  if (requestedType === "drug" || requestedType === "intervention") {
    if (entityType === "drug") boost += 0.3;
    if (entityType === "disease") boost -= 0.3;
  }

  if (requestedType === "unknown" && isLikelySymbolMention(mention)) {
    if (entityType === "target" || entityType === "drug") boost += 0.28;
    if (entityType === "disease") boost -= 0.35;
  }

  if (requestedType === "unknown" && hasDiseaseCue(mention)) {
    if (entityType === "disease") boost += 0.42;
    if (entityType === "target" || entityType === "drug") boost -= 0.24;
  }

  return boost;
}

function similarityScore(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q)) return 0.88;
  if (q.includes(c) || c.includes(q)) return 0.74;

  const qCompact = alnumCompact(q);
  const cCompact = alnumCompact(c);
  if (qCompact && cCompact) {
    if (qCompact === cCompact) return 1;
    if (cCompact.startsWith(qCompact) && qCompact.length >= 3) return 0.9;
  }

  const qTokens = tokenize(q);
  const cTokens = tokenize(c);
  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  if (qTokens.length === 1) {
    const qToken = alnumCompact(qTokens[0] ?? "");
    const cInitials = tokenInitials(cTokens);
    if (qToken && cInitials === qToken) return 0.94;
    if (
      qToken &&
      cTokens.some((token) => {
        const candidateToken = alnumCompact(token);
        return (
          candidateToken === qToken ||
          candidateToken.startsWith(qToken) ||
          qToken.startsWith(candidateToken)
        );
      })
    ) {
      return 0.81;
    }
  } else {
    const qInitials = tokenInitials(qTokens);
    const cInitials = tokenInitials(cTokens);
    if (qInitials && cInitials && qInitials === cInitials) {
      return 0.92;
    }
  }

  const cSet = new Set(cTokens);
  const shared = qTokens.filter((token) => cSet.has(token)).length;
  const precision = shared / Math.max(1, qTokens.length);
  const recall = shared / Math.max(1, cTokens.length);
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function diseaseIdPriority(id: string): number {
  if (/^EFO_/i.test(id)) return 6;
  if (/^MONDO_/i.test(id)) return 5;
  if (/^ORPHANET_/i.test(id)) return 4;
  if (/^DOID_/i.test(id)) return 3;
  if (/^HP_/i.test(id)) return 2;
  return 1;
}

function choosePreferredAnchor(current: QueryPlanAnchor, candidate: QueryPlanAnchor): QueryPlanAnchor {
  if (candidate.confidence > current.confidence) return candidate;
  if (candidate.confidence < current.confidence) return current;
  if (current.entityType === "disease" && candidate.entityType === "disease") {
    const currentPriority = diseaseIdPriority(current.id);
    const candidatePriority = diseaseIdPriority(candidate.id);
    if (candidatePriority > currentPriority) return candidate;
    if (candidatePriority < currentPriority) return current;
  }
  if (candidate.name.length < current.name.length) return candidate;
  return current;
}

function dedupeAnchorsSemantically(anchors: QueryPlanAnchor[]): QueryPlanAnchor[] {
  const bySemanticKey = new Map<string, QueryPlanAnchor>();
  for (const anchor of anchors) {
    const key = `${anchor.entityType}:${normalize(anchor.name)}`;
    const existing = bySemanticKey.get(key);
    if (!existing) {
      bySemanticKey.set(key, anchor);
      continue;
    }
    bySemanticKey.set(key, choosePreferredAnchor(existing, anchor));
  }
  return [...bySemanticKey.values()];
}

function filterResolvedUnresolvedMentions(
  unresolved: string[],
  anchors: QueryPlanAnchor[],
): string[] {
  const canonicalCompact = (value: string) => {
    const compactValue = alnumCompact(value);
    if (compactValue.length >= 5 && compactValue.endsWith("s")) {
      return compactValue.slice(0, -1);
    }
    return compactValue;
  };
  const resolvedForms = new Set<string>();
  const resolvedCompact = new Set<string>();
  for (const anchor of anchors) {
    for (const candidate of [anchor.mention, anchor.name]) {
      const normalized = normalize(candidate);
      if (!normalized) continue;
      resolvedForms.add(normalized);
      const compactValue = canonicalCompact(candidate);
      if (compactValue) resolvedCompact.add(compactValue);
    }
  }

  return unresolved.filter((mention) => {
    const normalized = normalize(mention);
    if (!normalized) return false;
    if (isGenericMechanismMention(mention)) return false;
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const hasResolvedDiseaseAnchor = anchors.some((anchor) => anchor.entityType === "disease");
    if (
      hasResolvedDiseaseAnchor &&
      tokens.length === 1 &&
      !/[0-9]/.test(normalized) &&
      !/[A-Z]/.test(mention) &&
      !/[-+]/.test(mention)
    ) {
      // Suppress generic single-word unresolved leftovers once disease anchors are resolved.
      return false;
    }
    if (resolvedForms.has(normalized)) return false;

    const mentionCompact = canonicalCompact(mention);
    if (mentionCompact && resolvedCompact.has(mentionCompact)) return false;
    if (mentionCompact) {
      for (const item of resolvedCompact) {
        if (item.length >= 4 && mentionCompact.length >= 4) {
          if (item.includes(mentionCompact) || mentionCompact.includes(item)) return false;
        }
      }
    }
    return true;
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function anchorScoreThreshold(mention: string, requestedType: MentionType): number {
  const tokenCount = tokenize(mention).length;
  if (tokenCount <= 1) {
    return requestedType === "unknown" ? 0.56 : 0.5;
  }
  if (tokenCount === 2) {
    return requestedType === "unknown" ? 0.34 : 0.3;
  }
  return 0.24;
}

const fallbackBoundaryPattern = /[.,;:!?()[\]{}]/g;

function sanitizeFallbackMention(value: string): string {
  return normalize(value).replace(/\s+/g, " ").trim();
}

function shouldPreserveSingleTokenMention(mention: string): boolean {
  const normalized = clean(mention);
  if (!normalized) return false;
  if (/[-+]/.test(normalized)) return true;
  if (/[0-9]/.test(normalized)) return true;
  if (/^[A-Z0-9-]{2,10}$/.test(normalized)) return true;
  const compactMention = alnumCompact(normalized);
  if (!compactMention) return false;
  if (/^[a-z]{1,6}\d{1,3}[a-z]?$/i.test(compactMention)) return true;
  return false;
}

function pruneSubsumedSingleTokenMentions(mentions: ExtractedMention[]): ExtractedMention[] {
  if (mentions.length <= 1) return mentions;
  const multiMentions = mentions
    .map((item) => sanitizeFallbackMention(item.mention))
    .filter((value) => value.split(/\s+/).filter(Boolean).length > 1);
  if (multiMentions.length === 0) return mentions;

  return mentions.filter((item) => {
    const mention = sanitizeFallbackMention(item.mention);
    const tokens = mention.split(/\s+/).filter(Boolean);
    if (tokens.length !== 1) return true;
    const token = tokens[0] ?? "";
    if (!token) return false;
    if (shouldPreserveSingleTokenMention(item.mention)) return true;
    const tokenRegex = new RegExp(`(^|\\s)${escapeRegex(token)}(\\s|$)`, "i");
    return !multiMentions.some((value) => tokenRegex.test(value));
  });
}

function normalizeRelationMention(value: string): string {
  let mention = sanitizeFallbackMention(value);
  if (!mention) return "";
  mention = mention.replace(/^(?:through|via|by|using)\s+/i, "");
  mention = mention.replace(
    /^(?:how|what|which|why)\s+(?:might|may|does|do|did|is|are|can|could|would|will|should)\s+/i,
    "",
  );
  mention = mention.replace(/^(?:how|what|which|why)\s+/i, "");
  mention = mention.replace(/^(?:might|may|does|do|did|is|are|can|could|would|will|should)\s+/i, "");
  mention = mention.replace(/^(?:the|a|an)\s+/i, "");
  mention = mention.replace(
    /^(?:lead(?:s|ing)?|driv(?:e|es|en|ing)|contribut(?:e|es|ed|ing)|caus(?:e|es|ed|ing)|trigger(?:s|ed|ing)?|promot(?:e|es|ed|ing)|predispos(?:e|es|ed|ing)|link(?:s|ed|ing)?|relat(?:e|es|ed|ing)|associat(?:e|es|ed|ing)|correlat(?:e|es|ed|ing)|connect(?:s|ed|ing)?)\s+(?:to\s+)?/i,
    "",
  );
  mention = mention.replace(/^(?:to|into|toward|towards)\s+/i, "");
  const prepositionTailMatch = mention.match(/\b(?:in|for|of|with|through|via|by|using)\s+(.+)$/i);
  if (prepositionTailMatch?.[1]) {
    const tail = sanitizeFallbackMention(prepositionTailMatch[1]);
    if (tail.length >= 3) mention = tail;
  }
  if (isGenericMechanismMention(mention)) return "";
  return mention;
}

function extractStructuredMentions(query: string): string[] {
  const cleaned = query.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const mentions = new Set<string>();
  const normalizeMentionParts = (value: string): string[] => {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    const parts = raw
      .split(/\s*,\s*|\s+(?:and|&)\s+/i)
      .map((item) => normalizeRelationMention(item))
      .filter(Boolean);
    if (parts.length > 1) return parts;
    const single = normalizeRelationMention(raw);
    return single ? [single] : [];
  };
  const addMention = (value: string) => {
    for (const mention of normalizeMentionParts(value)) {
      if (!mention || mention.length < 2) continue;
      if (mention.length > 90) continue;
      if (mention.split(/\s+/).filter(Boolean).length > 6) continue;
      if (isGenericMechanismMention(mention)) continue;
      mentions.add(mention);
    }
  };

  const betweenMatch = cleaned.match(
    /\bbetween\s+(.+?)\s+and\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (betweenMatch) {
    addMention(betweenMatch[1] ?? "");
    addMention(betweenMatch[2] ?? "");
    addMention(betweenMatch[3] ?? "");
  }

  const connectMatch = cleaned.match(
    /\b(?:connect(?:ed|ing|s)?|connection|relationship|link(?:ed|ing)?|overlap|related|relates)\s+(?:between\s+)?(.+?)\s+(?:to|with|and|vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (connectMatch) {
    addMention(connectMatch[1] ?? "");
    addMention(connectMatch[2] ?? "");
    addMention(connectMatch[3] ?? "");
  }

  const connectPrecedingMatch = cleaned.match(
    /(.+?)\s+(?:connect(?:ed|ing|s)?|connection|relationship|link(?:ed|ing)?|overlap|related|relates)\s+(?:to|with|and|vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (connectPrecedingMatch) {
    addMention(connectPrecedingMatch[1] ?? "");
    addMention(connectPrecedingMatch[2] ?? "");
    addMention(connectPrecedingMatch[3] ?? "");
  }

  const versusMatch = cleaned.match(
    /\b(.+?)\s+(?:vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (versusMatch) {
    addMention(versusMatch[1] ?? "");
    addMention(versusMatch[2] ?? "");
    addMention(versusMatch[3] ?? "");
  }

  const causalPatterns = [
    /\b(.+?)\s+(?:lead|leads|leading|drives?|driven|contributes?|causes?|triggers?|promotes?|predisposes?)\s+(?:to\s+)?(.+?)(?:\s+(?:through|via|using|with|by)\s+(.+))?$/i,
    /\b(.+?)\s+(?:results?\s+in|linked\s+to|associated\s+with|correlat(?:ed|es?|ion)\s+with)\s+(.+?)(?:\s+(?:through|via|using|with|by)\s+(.+))?$/i,
  ] as const;
  for (const pattern of causalPatterns) {
    const match = cleaned.match(pattern);
    if (!match) continue;
    addMention(match[1] ?? "");
    addMention(match[2] ?? "");
    addMention(match[3] ?? "");
  }

  for (const match of cleaned.matchAll(/["'`](.{2,90}?)["'`]/g)) {
    addMention(match[1] ?? "");
  }

  return [...mentions].slice(0, 8);
}

function splitFallbackMentions(query: string): Array<{ mention: string; type: MentionType }> {
  const textRaw = query
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!textRaw) return [];

  const normalized = normalize(textRaw).replace(fallbackBoundaryPattern, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 2);
  if (tokens.length === 0) return [];

  const mentionSet = new Set<string>();
  for (const mention of extractStructuredMentions(textRaw)) {
    mentionSet.add(mention);
  }

  const originalTokens = textRaw.split(/\s+/).filter(Boolean);
  for (const tokenRaw of originalTokens) {
    const token = clean(tokenRaw);
    const compactToken = alnumCompact(token);
    if (compactToken.length < 3 || compactToken.length > 18) continue;
    const hasSignal = /[0-9]/.test(compactToken) || /[A-Z]/.test(tokenRaw) || /[-+]/.test(tokenRaw);
    if (!hasSignal) continue;
    mentionSet.add(sanitizeFallbackMention(token));
  }

  if (mentionSet.size === 0) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = sanitizeFallbackMention(tokens[i] ?? "");
      if (token.length < 4) continue;
      const isLastToken = i === tokens.length - 1;
      const longBiomedicalLikeToken = token.length >= 8;
      if (isLastToken || longBiomedicalLikeToken) {
        mentionSet.add(token);
      }
    }

    const maxTailSize = Math.min(4, Math.max(2, tokens.length - 1));
    for (let size = 2; size <= maxTailSize; size += 1) {
      const tail = sanitizeFallbackMention(tokens.slice(-size).join(" ").trim());
      if (tail.length >= 3) mentionSet.add(tail);
    }
  }

  const mentionScore = (mention: string): number => {
    const parts = mention.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return -10;
    const alphaNumeric = mention.replace(/[^a-z0-9]/gi, "").length;
    const hasDigit = /\d/.test(mention);
    let score = 0;
    if (parts.length === 1) score += alphaNumeric >= 4 ? 1.8 : 0.2;
    else if (parts.length === 2) score += 0.9;
    else if (parts.length <= 4) score += 1.1;
    else if (parts.length <= 6) score += 0.35;
    else score -= 0.9;

    const compactMention = alnumCompact(mention);
    if (compactMention.length >= 3 && compactMention.length <= 10) score += 0.35;
    if (hasDigit) score += 0.25;
    if (mention.length > 52) score -= 1.1;
    score += Math.min(0.9, alphaNumeric / 28);
    return score;
  };

  const out = [...mentionSet]
    .map((mention) => sanitizeFallbackMention(mention))
    .map((mention) => mention.replace(/\s+/g, " ").trim())
    .filter((mention) => mention.length >= 3)
    .filter((mention) => /[a-z0-9]/i.test(mention))
    .filter((mention) => !/^(?:what|which|how|why)\b/i.test(mention))
    .filter((mention) => !/\b(connect(?:ed|ing|s)?|connection|relationship|related|relates|compare|between)\b/i.test(mention))
    .filter((mention) => !isGenericMechanismMention(mention))
    .sort((a, b) => mentionScore(b) - mentionScore(a))
    .map((mention) => ({
      mention,
      type: inferMentionTypeFromLexical(mention),
    }))
    .slice(0, 12);
  return out;
}

function rescueFallbackMentions(query: string): Array<{ mention: string; type: MentionType }> {
  const text = normalize(query);
  const tokens = text.split(/\s+/).filter((token) => token.length >= 3);
  if (tokens.length === 0) return [];

  const mentions = new Set<string>(extractStructuredMentions(query));
  const tailToken = tokens[tokens.length - 1] ?? "";
  if (tailToken.length >= 4) {
    mentions.add(tailToken);
  }
  const tailBigram = tokens.slice(-2).join(" ").trim();
  if (tailBigram.length >= 4) {
    mentions.add(tailBigram);
  }
  const tailTrigram = tokens.slice(-3).join(" ").trim();
  if (tailTrigram.length >= 5) {
    mentions.add(tailTrigram);
  }

  return [...mentions]
    .map((value) => sanitizeFallbackMention(value))
    .filter((value) => value.length >= 3)
    .filter((value) => !/^(?:what|which|how|why)\b/i.test(value))
    .filter((value) => !/\b(connect(?:ed|ing|s)?|connection|relationship|related|relates|compare|between|versus|vs)\b/i.test(value))
    .filter((value) => !isGenericMechanismMention(value))
    .sort((a, b) => b.length - a.length)
    .slice(0, 8)
    .map((mention) => ({
      mention,
      type: inferMentionTypeFromLexical(mention),
    }));
}

async function extractMentions(query: string): Promise<{
  intent: string;
  mentions: ExtractedMention[];
  constraints: QueryPlanConstraint[];
  rationale: string;
}> {
  const openai = getOpenAiClient();
  const lexicalFallbackMentions = splitFallbackMentions(query);
  const llmRelationMentionsRaw = await extractRelationMentionsFast(query, {
    maxMentions: 6,
    timeoutMs: 1_600,
  });
  const llmRelationMentions: ExtractedMention[] = llmRelationMentionsRaw
    .map((mention) => normalizeRelationMention(mention) || clean(mention))
    .map((mention) => compact(mention, 90))
    .map((mention) => ({
      mention,
      type: inferMentionTypeFromLexical(mention),
    }))
    .filter((item) => item.mention.length >= 2)
    .filter((item) => mentionHasSurfaceSupport(query, item.mention))
    .filter((item) => !isGenericMechanismMention(item.mention));
  const fallbackMentions = (() => {
    const byKey = new Map<string, ExtractedMention>();
    for (const item of [...llmRelationMentions, ...lexicalFallbackMentions]) {
      const key = normalize(item.mention);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, item);
    }
    return [...byKey.values()].slice(0, 12);
  })();

  const fallback = {
    intent: "multihop-discovery",
    mentions: fallbackMentions,
    constraints: [],
    rationale: "Fallback extractor used due unavailable/timeout structured planner call.",
  };

  if (!openai || isOpenAiRateLimited()) return fallback;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string" },
      mentions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            mention: { type: "string" },
            type: {
              type: "string",
              enum: [
                "disease",
                "target",
                "drug",
                "intervention",
                "pathway",
                "protein",
                "molecule",
                "effect",
                "phenotype",
                "anatomy",
                "unknown",
              ],
            },
          },
          required: ["mention", "type"],
        },
      },
      constraints: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            polarity: {
              type: "string",
              enum: ["include", "avoid", "optimize"],
            },
          },
          required: ["text", "polarity"],
        },
      },
      rationale: { type: "string" },
    },
    required: ["intent", "mentions", "constraints", "rationale"],
  } as const;

  try {
    const response = await withTimeout(
      openai.responses.create({
        model: appConfig.openai.smallModel,
        max_output_tokens: 500,
        reasoning: { effort: "minimal" },
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "Extract resolver-ready biomedical mentions and explicit constraints from the user query. Preserve all principal entities explicitly mentioned by the user (including mediator molecules/cytokines, diseases, targets, and interventions) when resolvable. Return only entities that can be resolved with tools; keep language exact; do not invent entities.",
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: query }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "query_plan_extract",
            schema,
            strict: true,
          },
        },
      }),
      4_200,
    );

    const parsed = JSON.parse(response.output_text) as {
      intent?: string;
      mentions?: Array<{ mention?: string; type?: MentionType }>;
      constraints?: QueryPlanConstraint[];
      rationale?: string;
    };

    const modelMentions = (parsed.mentions ?? [])
      .map((item) => ({
        mention: compact(String(item.mention ?? ""), 90),
        type: item.type ?? "unknown",
      }))
      .filter((item) => item.mention.length >= 2)
      .filter((item) => mentionHasSurfaceSupport(query, item.mention));
    const lexicalMentions = lexicalFallbackMentions;
    const mergedMentions = new Map<string, ExtractedMention>();
    if (modelMentions.length > 0) {
      for (const item of modelMentions) {
        const key = normalize(item.mention);
        if (!key) continue;
        mergedMentions.set(key, item);
      }
      for (const item of llmRelationMentions) {
        const key = normalize(item.mention);
        if (!key || mergedMentions.has(key)) continue;
        mergedMentions.set(key, item);
      }
      for (const item of lexicalMentions) {
        const key = normalize(item.mention);
        if (!key || mergedMentions.has(key)) continue;
        if (!isLikelySymbolMention(item.mention)) continue;
        mergedMentions.set(key, item);
      }
    } else {
      for (const item of llmRelationMentions) {
        const key = normalize(item.mention);
        if (!key || mergedMentions.has(key)) continue;
        mergedMentions.set(key, item);
      }
      for (const item of lexicalMentions) {
        const key = normalize(item.mention);
        if (!key || mergedMentions.has(key)) continue;
        mergedMentions.set(key, item);
      }
    }
    const mentions = pruneSubsumedSingleTokenMentions([...mergedMentions.values()]).slice(0, 10);

    if (mentions.length === 0) return fallback;

    return {
      intent: String(parsed.intent ?? "multihop-discovery"),
      mentions,
      constraints: (parsed.constraints ?? []).slice(0, 8),
      rationale: String(parsed.rationale ?? "Structured mention extraction complete."),
    };
  } catch (error) {
    handleOpenAiRateLimit(error);
    return fallback;
  }
}

function baseMentionVariants(mention: string): string[] {
  const cleanMention = mention.trim();
  if (!cleanMention) return [];
  const variants = new Set<string>([cleanMention]);
  const compactMention = cleanMention.replace(/\s+/g, "");

  if (/^[A-Za-z]{2,8}[0-9]{1,3}$/.test(compactMention)) {
    const splitPoint = compactMention.search(/[0-9]/);
    if (splitPoint > 1) {
      variants.add(`${compactMention.slice(0, splitPoint)}-${compactMention.slice(splitPoint)}`);
      variants.add(`${compactMention.slice(0, splitPoint)} ${compactMention.slice(splitPoint)}`);
    }
  }

  if (cleanMention.includes("-")) {
    variants.add(cleanMention.replace(/-/g, " "));
  }
  if (cleanMention.includes("'")) {
    variants.add(cleanMention.replace(/'/g, ""));
  }
  if (/^[a-z0-9-]{2,8}$/i.test(compactMention) && !cleanMention.includes(" ")) {
    variants.add(compactMention.toUpperCase());
  }
  const mechanismTrimmed = cleanMention
    .replace(/\b(signaling|signal|pathway|pathways|axis|cascade|network|events?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (mechanismTrimmed && mechanismTrimmed.length >= 2 && mechanismTrimmed !== cleanMention) {
    variants.add(mechanismTrimmed);
  }

  return [...variants]
    .map((item) => clean(item))
    .filter((item) => item.length >= 2)
    .slice(0, 4);
}

function targetSymbolHintBoost(mention: string, name: string, description?: string): number {
  const compactMention = alnumCompact(mention);
  if (!/^[a-z]{2,6}\d{1,3}[a-z]?$/i.test(compactMention)) return 0;
  const hintTokens = new Set<string>([compactMention]);
  const splitIndex = compactMention.search(/[0-9]/);
  if (splitIndex > 1) {
    const prefix = compactMention.slice(0, splitIndex);
    const suffix = compactMention.slice(splitIndex);
    hintTokens.add(`${prefix}-${suffix}`);
    hintTokens.add(`${prefix} ${suffix}`);
    if (prefix === "il") {
      hintTokens.add(`interleukin ${suffix}`);
    }
  }
  const haystack = `${name} ${description ?? ""}`.toLowerCase();
  const matchesHint = [...hintTokens].some((hint) => haystack.includes(hint));
  return matchesHint ? 0.45 : -0.12;
}

function symbolHintFromMention(mention: string): string | null {
  const mechanismTrimmed = mention
    .replace(/\b(signaling|signal|pathway|pathways|axis|cascade|network|events?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compactMention = alnumCompact(mechanismTrimmed || mention);
  if (!/^[a-z]{2,6}\d{1,3}[a-z]?$/i.test(compactMention)) return null;
  return compactMention.toUpperCase();
}

function isExplicitTargetLexeme(mention: string): boolean {
  const normalized = mention.trim();
  if (!normalized) return false;
  if (/[0-9]/.test(normalized)) return true;
  if (/[-+]/.test(normalized)) return true;
  if (/\b(gene|protein|receptor|kinase|enzyme|channel|target)\b/i.test(normalized)) return true;
  return false;
}

function isHighSignalDrugTargetHint(
  name: string,
  description?: string,
): boolean {
  const normalizedName = clean(name);
  if (!normalizedName) return false;
  const upper = normalizedName.toUpperCase();
  const details = clean(description ?? "").toLowerCase();
  const combined = `${normalizedName} ${details}`.toLowerCase();
  if (
    /cell\s*line|resistan|cytotox|xenograft|assay|screen/i.test(combined) ||
    /\/|\\/.test(normalizedName)
  ) {
    return false;
  }
  if (isLikelySymbolMention(upper)) return true;
  if (/protein|enzyme|receptor|ion channel|kinase|transporter|gpcr/i.test(details)) {
    return true;
  }
  return false;
}

async function expandMentionSearchQueries(
  query: string,
  mentions: ExtractedMention[],
): Promise<Map<string, string[]>> {
  const openai = getOpenAiClient();
  const result = new Map<string, string[]>();
  for (const mention of mentions) {
    result.set(mention.mention, baseMentionVariants(mention.mention));
  }

  if (!openai || isOpenAiRateLimited() || mentions.length === 0) {
    return result;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            mention: { type: "string" },
            queries: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["mention", "queries"],
        },
      },
    },
    required: ["items"],
  } as const;

  try {
    const response = await withTimeout(
      openai.responses.create({
        model: appConfig.openai.smallModel,
        max_output_tokens: 400,
        reasoning: { effort: "minimal" },
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: [
                  "Generate canonical biomedical search variants for entity resolver mentions.",
                  "Use semantically equivalent aliases only (e.g., abbreviations, canonical punctuation, known synonymous naming).",
                  "Do not invent new concepts and do not add generic words.",
                  "Return up to 3 high-precision search queries per mention.",
                ].join(" "),
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(
                  {
                    query,
                    mentions: mentions.map((item) => ({
                      mention: item.mention,
                      type: item.type,
                    })),
                  },
                  null,
                  2,
                ),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "resolver_search_variants",
            schema,
            strict: true,
          },
        },
      }),
      3_500,
    );

    const parsed = JSON.parse(response.output_text) as {
      items?: Array<{ mention?: string; queries?: string[] }>;
    };

    for (const item of parsed.items ?? []) {
      const mention = clean(String(item.mention ?? ""));
      if (!mention || !result.has(mention)) continue;
      const merged = new Set<string>(result.get(mention) ?? []);
      for (const queryVariant of item.queries ?? []) {
        const normalizedVariant = clean(String(queryVariant));
        if (!normalizedVariant || normalizedVariant.length < 2) continue;
        merged.add(normalizedVariant);
      }
      result.set(mention, [...merged].slice(0, 4));
    }
  } catch (error) {
    handleOpenAiRateLimit(error);
  }

  return result;
}

async function resolveMentionCandidates(
  mention: string,
  requestedType: MentionType,
  searchQueries: string[] = [],
): Promise<CandidateRow[]> {
  const query = mention.trim();
  if (!query) return [];

  const mentionTokens = query.split(/\s+/).filter(Boolean);
  const variantSet = new Set<string>([query, ...searchQueries]);
  const maxTailVariants = mentionTokens.length <= 2 ? mentionTokens.length : 2;
  for (let size = 1; size <= maxTailVariants; size += 1) {
    const tail = mentionTokens.slice(-size).join(" ").trim();
    if (tail.length >= 2) variantSet.add(tail);
  }
  const variants = [...variantSet].slice(0, 3);

  const diseaseTask = async (searchQuery: string) =>
    (await withTimeout(searchDiseases(searchQuery, 8), 5_000)).map((item) => ({
      mention: query,
      requestedType,
      entityType: "disease" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score:
        Math.max(similarityScore(query, item.name), similarityScore(searchQuery, item.name)) +
        entityPreferenceBoost(
          query,
          requestedType,
          "disease",
          item.name,
          item.description,
        ),
      source: "opentargets" as const,
    }));

  const targetTask = async (searchQuery: string) =>
    (await withTimeout(searchTargets(searchQuery, 8), 5_000)).map((item: TargetHit) => ({
      mention: query,
      requestedType,
      entityType: "target" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score:
        Math.max(
          similarityScore(query, item.name),
          similarityScore(searchQuery, item.name),
          similarityScore(query, item.description ?? ""),
          similarityScore(searchQuery, item.description ?? ""),
        ) +
        entityPreferenceBoost(
          query,
          requestedType,
          "target",
          item.name,
          item.description,
        ) +
        targetSymbolHintBoost(query, item.name, item.description) +
        targetSymbolHintBoost(searchQuery, item.name, item.description),
      source: "opentargets" as const,
    }));

  const drugTask = async (searchQuery: string) => {
    const [openTargetsHits, chemblHits] = await Promise.all([
      withTimeout(searchDrugs(searchQuery, 8), 5_000).catch(() => [] as DrugHit[]),
      withTimeout(searchDrugCandidates(searchQuery, 8), 5_000).catch(
        () =>
          [] as Array<{
            id: string;
            name: string;
            description?: string;
          }>,
      ),
    ]);

    const fromOpenTargets = openTargetsHits.map((item: DrugHit) => ({
      mention: query,
      requestedType,
      entityType: "drug" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score:
        Math.max(similarityScore(query, item.name), similarityScore(searchQuery, item.name)) +
        entityPreferenceBoost(
          query,
          requestedType,
          "drug",
          item.name,
          item.description,
        ),
      source: "opentargets" as const,
    }));

    const fromChembl = chemblHits.map((item) => ({
      mention: query,
      requestedType,
      entityType: "drug" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score:
        Math.max(
          similarityScore(query, item.name),
          similarityScore(searchQuery, item.name),
          similarityScore(query, item.description ?? ""),
          similarityScore(searchQuery, item.description ?? ""),
        ) +
        entityPreferenceBoost(
          query,
          requestedType,
          "drug",
          item.name,
          item.description,
        ),
      source: "chembl" as const,
    }));

    return [...fromOpenTargets, ...fromChembl];
  };

  const taskSetByVariant = (searchQuery: string) =>
    requestedType === "disease"
      ? [diseaseTask(searchQuery)]
      : requestedType === "target" || requestedType === "protein" || requestedType === "molecule"
        ? [targetTask(searchQuery), diseaseTask(searchQuery)]
        : requestedType === "drug" || requestedType === "intervention"
          ? [drugTask(searchQuery), targetTask(searchQuery)]
          : [diseaseTask(searchQuery), targetTask(searchQuery), drugTask(searchQuery)];

  const taskSet = variants.flatMap((variant) => taskSetByVariant(variant));

  const settled = await Promise.allSettled(taskSet);
  const rows: CandidateRow[] = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      rows.push(...item.value);
    }
  }

  const deduped = new Map<string, CandidateRow>();
  for (const row of rows) {
    const key = `${row.entityType}:${row.id}`;
    const existing = deduped.get(key);
    if (!existing || row.score > existing.score) {
      deduped.set(key, row);
    }
  }

  const mentionTokenCount = tokenize(query).length;
  const lowerAlphaSingleToken = mentionTokenCount <= 1 && /^[a-z]{4,}$/i.test(query);
  const genericMechanisticMention = isGenericMechanismMention(query);
  const symbolMention = isLikelySymbolMention(query);
  const filtered = [...deduped.values()].filter((row) => {
    const cutoff =
      row.entityType === "disease"
        ? mentionTokenCount <= 1
          ? lowerAlphaSingleToken
            ? 0.58
            : 0.5
          : genericMechanisticMention
            ? 0.7
            : 0.34
        : mentionTokenCount <= 1
          ? 0.52
          : genericMechanisticMention
            ? symbolMention
              ? 0.46
              : 0.72
            : 0.4;
    return row.score >= cutoff;
  });

  return filtered
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function addFollowup(
  bucket: QueryPlanFollowup[],
  question: string,
  reason: string,
  seedEntityIds: string[],
) {
  if (!question.trim()) return;
  if (bucket.some((item) => item.question.toLowerCase() === question.toLowerCase())) return;
  bucket.push({
    question: compact(question, 180),
    reason: compact(reason, 200),
    seedEntityIds: seedEntityIds.filter(Boolean).slice(0, 8),
  });
}

function deriveFollowups(anchors: QueryPlanAnchor[], constraints: QueryPlanConstraint[]): QueryPlanFollowup[] {
  const followups: QueryPlanFollowup[] = [];
  const diseases = anchors.filter((item) => item.entityType === "disease");
  const targets = anchors.filter((item) => item.entityType === "target");
  const drugs = anchors.filter((item) => item.entityType === "drug");
  const principalAnchors = anchors.slice(0, 4);

  if (principalAnchors.length >= 2) {
    let pairCount = 0;
    for (let leftIndex = 0; leftIndex < principalAnchors.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < principalAnchors.length; rightIndex += 1) {
        const left = principalAnchors[leftIndex];
        const right = principalAnchors[rightIndex];
        if (!left || !right) continue;
        addFollowup(
          followups,
          `Test mechanistic bridge evidence between ${left.name} and ${right.name}.`,
          "Multi-anchor query detected; preserve explicit anchor pairs during exploration.",
          [left.id, right.id],
        );
        pairCount += 1;
        if (pairCount >= 3) break;
      }
      if (pairCount >= 3) break;
    }
  }

  if (diseases.length >= 2) {
    addFollowup(
      followups,
      `Find shared pathways and target intersections between ${diseases[0]!.name} and ${diseases[1]!.name}.`,
      "Comparative disease anchors detected.",
      [diseases[0]!.id, diseases[1]!.id],
    );
  }

  if (diseases.length >= 1 && targets.length >= 1) {
    addFollowup(
      followups,
      `Map pathway and interaction evidence linking ${targets[0]!.name} to ${diseases[0]!.name}.`,
      "Disease+target anchor pair detected.",
      [diseases[0]!.id, targets[0]!.id],
    );
  }

  if (targets.length >= 1) {
    addFollowup(
      followups,
      `Expand compounds and PubMed evidence for ${targets[0]!.name}, then rank caveats.`,
      "Target-centric follow-up for translational depth.",
      [targets[0]!.id],
    );
  }

  if (drugs.length >= 1) {
    addFollowup(
      followups,
      `Resolve mechanism and downstream target neighborhood for ${drugs[0]!.name}.`,
      "Drug anchor detected.",
      [drugs[0]!.id],
    );
  }

  for (const constraint of constraints.slice(0, 3)) {
    addFollowup(
      followups,
      `Verify candidate thread against constraint: ${constraint.text}.`,
      "Explicit user constraint to validate.",
      [],
    );
  }

  addFollowup(
    followups,
    "Collect bibliography support and flag weak evidence branches.",
    "Evidence hardening step for final recommendation quality.",
    anchors.slice(0, 3).map((item) => item.id),
  );

  return followups.slice(0, 8);
}

export async function planQuery(query: string): Promise<ResolvedQueryPlan> {
  const normalizedQuery = query.trim();
  const cacheKey = normalize(normalizedQuery);
  const cached = planCache.get(cacheKey);
  if (cached) return cached;

  const extracted = await extractMentions(normalizedQuery);
  const mentions = extracted.mentions.length > 0 ? extracted.mentions : splitFallbackMentions(normalizedQuery);
  const mentionSearchVariants = await expandMentionSearchQueries(normalizedQuery, mentions);

  const mentionSettled = await Promise.allSettled(
    mentions.map((item) =>
      withTimeout(
        resolveMentionCandidates(
          item.mention,
          item.type,
          mentionSearchVariants.get(item.mention) ?? [],
        ),
        2_200,
      ).catch(() => []),
    ),
  );

  const allRows: CandidateRow[] = [];
  for (const row of mentionSettled) {
    if (row.status === "fulfilled") {
      allRows.push(...row.value);
    }
  }

  const selectedAnchors = new Map<string, QueryPlanAnchor>();
  const unresolvedMentions = new Set<string>();

  for (const mention of mentions) {
    const mentionRows = allRows
      .filter((row) => normalize(row.mention) === normalize(mention.mention))
      .sort((a, b) => b.score - a.score);
    const top = mentionRows[0];
    const minimumScore = anchorScoreThreshold(mention.mention, mention.type);
    if (!top || top.score < minimumScore) {
      unresolvedMentions.add(mention.mention);
      continue;
    }

    const key = `${top.entityType}:${top.id}`;
    if (!selectedAnchors.has(key)) {
      selectedAnchors.set(key, {
        mention: mention.mention,
        requestedType: mention.type,
        entityType: top.entityType,
        id: top.id,
        name: top.name,
        description: top.description,
        confidence: Math.max(0.15, Math.min(0.98, Number((top.score * 1.05).toFixed(3)))),
        source: top.source,
      });
    }
  }

  if (selectedAnchors.size === 0) {
    const rescueMentions = rescueFallbackMentions(normalizedQuery);
    const rescueSettled = await Promise.allSettled(
      rescueMentions.map((item) =>
        withTimeout(resolveMentionCandidates(item.mention, item.type), 2_200).catch(() => []),
      ),
    );

    const rescueRows: CandidateRow[] = [];
    for (const row of rescueSettled) {
      if (row.status === "fulfilled") {
        rescueRows.push(...row.value);
      }
    }

    for (const mention of rescueMentions) {
      const top = rescueRows
        .filter((row) => normalize(row.mention) === normalize(mention.mention))
        .sort((a, b) => b.score - a.score)[0];
      const minimumScore = anchorScoreThreshold(mention.mention, mention.type);
      if (!top || top.score < minimumScore) continue;
      const key = `${top.entityType}:${top.id}`;
      if (selectedAnchors.has(key)) continue;
      selectedAnchors.set(key, {
        mention: mention.mention,
        requestedType: mention.type,
        entityType: top.entityType,
        id: top.id,
        name: top.name,
        description: top.description,
        confidence: Math.max(0.16, Math.min(0.98, Number((top.score * 1.04).toFixed(3)))),
        source: top.source,
      });
    }
  }

  // Expand drug anchors into target anchors without hardcoded dictionaries.
  const anchors = [...selectedAnchors.values()];
  const drugAnchors = anchors.filter((item) => item.entityType === "drug");
  const drugTargetHints = await Promise.allSettled(
    drugAnchors.slice(0, 3).map((drug) => getDrugTargetHints(drug.id, 4)),
  );

  for (let i = 0; i < drugTargetHints.length; i += 1) {
    const hint = drugTargetHints[i];
    if (hint?.status !== "fulfilled") continue;
    const drug = drugAnchors[i];
    if (!drug) continue;
    for (const target of hint.value) {
      if (!isHighSignalDrugTargetHint(target.name, target.description)) continue;
      const key = `target:${target.id}`;
      if (selectedAnchors.has(key)) continue;
      selectedAnchors.set(key, {
        mention: drug.name,
        requestedType: "intervention",
        entityType: "target",
        id: target.id,
        name: target.name,
        description: target.description,
        confidence: Math.max(0.2, Math.min(0.9, Number((target.confidence * 0.92).toFixed(3)))),
        source: "chembl",
      });
    }
  }

  const finalAnchors = dedupeAnchorsSemantically([...selectedAnchors.values()])
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 16);
  const canonicalTargetAnchors = await Promise.all(
    finalAnchors.map(async (anchor) => {
      if (anchor.entityType !== "target") return anchor;
      const symbolHint = symbolHintFromMention(anchor.mention);
      if (!symbolHint) return anchor;
      if (alnumCompact(anchor.name).toUpperCase() === symbolHint) return anchor;
      const hits = await withTimeout(searchTargets(symbolHint, 8), 5_000).catch(() => []);
      const exact = hits.find((hit) => alnumCompact(hit.name).toUpperCase() === symbolHint);
      if (!exact) return anchor;
      return {
        ...anchor,
        id: exact.id,
        name: exact.name,
        description: exact.description,
        confidence: Math.max(anchor.confidence, 0.92),
        source: "opentargets" as const,
      };
    }),
  );
  const canonicalAnchors = dedupeAnchorsSemantically(canonicalTargetAnchors)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 16);
  const diseaseConfidenceByMention = new Map<string, number>();
  for (const anchor of canonicalAnchors) {
    if (anchor.entityType !== "disease") continue;
    const key = normalize(anchor.mention || anchor.name);
    if (!key) continue;
    const existing = diseaseConfidenceByMention.get(key) ?? 0;
    if (anchor.confidence > existing) {
      diseaseConfidenceByMention.set(key, anchor.confidence);
    }
  }
  const mentionDisambiguatedAnchors = canonicalAnchors.filter((anchor) => {
    if (anchor.entityType !== "target") return true;
    const key = normalize(anchor.mention || anchor.name);
    if (!key) return true;
    const diseaseConfidence = diseaseConfidenceByMention.get(key) ?? 0;
    if (diseaseConfidence < 0.82) return true;
    if (isExplicitTargetLexeme(anchor.mention)) return true;
    // When the same surface mention maps strongly to both disease and target,
    // prefer the disease interpretation unless the target intent is explicit.
    return false;
  });
  const followups = deriveFollowups(mentionDisambiguatedAnchors, extracted.constraints);
  const filteredUnresolvedMentions = filterResolvedUnresolvedMentions(
    [...unresolvedMentions],
    mentionDisambiguatedAnchors,
  );

  const plan: ResolvedQueryPlan = {
    query: normalizedQuery,
    intent: extracted.intent || "multihop-discovery",
    anchors: mentionDisambiguatedAnchors,
    constraints: extracted.constraints.slice(0, 10),
    unresolvedMentions: filteredUnresolvedMentions.slice(0, 8),
    followups,
    rationale: extracted.rationale,
  };

  if (plan.anchors.length > 0 || plan.followups.length > 0) {
    planCache.set(cacheKey, plan);
  }
  return plan;
}
