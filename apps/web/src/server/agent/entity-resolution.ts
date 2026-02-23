import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import {
  chooseBestDiseaseCandidate,
  type DiseaseCandidate,
} from "@/server/openai/disease-resolver";
import {
  handleOpenAiRateLimit,
  isOpenAiRateLimited,
} from "@/server/openai/rate-limit";
import {
  planQuery,
  QueryPlanAnchor,
  QueryPlanConstraint,
  QueryPlanFollowup,
  ResolvedQueryPlan,
} from "@/server/agent/query-plan";
import { extractRelationMentionsFast } from "@/server/agent/relation-mention-extractor";
import {
  searchDiseases,
  searchDrugs,
  searchTargets,
  type TargetHit,
} from "@/server/mcp/opentargets";
import { searchDrugCandidates } from "@/server/mcp/chembl";
import { createTrackedOpenAIClient } from "@/server/openai/client";

type CandidateEntityType = "disease" | "target" | "drug";
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

type MentionCandidate = {
  mention: string;
  entityType: CandidateEntityType;
  id: string;
  name: string;
  description?: string;
  score: number;
  source: "opentargets" | "chembl";
};

type ResolutionModelResult = {
  intent: string;
  anchors: Array<{
    mention: string;
    entityType: CandidateEntityType;
    id: string;
    confidence: number;
  }>;
  primaryDiseaseId?: string;
  constraints?: QueryPlanConstraint[];
  unresolvedMentions?: string[];
  rationale?: string;
};

export type QueryEntityBundle = {
  query: string;
  queryPlan: ResolvedQueryPlan;
  selectedDisease: DiseaseCandidate | null;
  diseaseCandidates: DiseaseCandidate[];
  rationale: string;
  openAiCalls: number;
};

const diseaseIdPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;
const mentionBoundaryPattern = /[.,;:!?()[\]{}]/g;
function getOpenAiClient() {
  return createTrackedOpenAIClient();
}
const bundleCache = createTTLCache<string, QueryEntityBundle>(
  Math.min(appConfig.cache.ttlMs, 2 * 60 * 1000),
  Math.min(appConfig.cache.maxEntries, 500),
);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function isMeasurementLike(name: string, description?: string): boolean {
  const text = `${name} ${description ?? ""}`.toLowerCase();
  return (
    text.includes("measurement") ||
    text.includes("quantification") ||
    text.includes("metabolite ratio") ||
    text.includes("in a sample")
  );
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function normalizeDisplay(value: string): string {
  return value.replace(/[^\p{L}\p{N}\s+\-]/gu, " ").replace(/\s+/g, " ").trim();
}

function alnumCompact(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function initials(tokens: string[]): string {
  return tokens
    .map((token) => alnumCompact(token))
    .filter((token) => token.length > 0)
    .map((token) => token[0] ?? "")
    .join("");
}

function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.startsWith(left) || left.startsWith(right)) return 0.82;

  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.length === 1) {
    const leftToken = alnumCompact(leftTokens[0] ?? "");
    const rightInitials = initials(rightTokens);
    if (leftToken && rightInitials && leftToken === rightInitials) return 0.94;
  }
  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token)).length;
  if (shared === 0) return 0;
  const precision = shared / Math.max(1, leftTokens.length);
  const recall = shared / Math.max(1, rightTokens.length);
  return (2 * precision * recall) / Math.max(0.001, precision + recall);
}

function sanitizeMention(value: string): string {
  return normalize(value)
    .replace(/\s+/g, " ")
    .trim();
}

function shouldPreserveSingleTokenMention(mention: string): boolean {
  const normalized = mention.trim();
  if (!normalized) return false;
  if (/[-+]/.test(normalized)) return true;
  if (/[0-9]/.test(normalized)) return true;
  if (/^[A-Z0-9-]{2,10}$/.test(normalized)) return true;
  const compactMention = alnumCompact(normalized);
  if (!compactMention) return false;
  if (/^[a-z]{1,6}\d{1,3}[a-z]?$/i.test(compactMention)) return true;
  return false;
}

function pruneSubsumedSingleTokenMentions(mentions: string[]): string[] {
  if (mentions.length <= 1) return mentions;
  const normalized = mentions
    .map((value) => sanitizeMention(value))
    .filter(Boolean);
  const multiMentions = normalized.filter(
    (value) => value.split(/\s+/).filter(Boolean).length > 1,
  );
  if (multiMentions.length === 0) return normalized;

  return normalized.filter((mention) => {
    const tokens = mention.split(/\s+/).filter(Boolean);
    if (tokens.length !== 1) return true;
    const token = tokens[0] ?? "";
    if (!token) return false;
    if (shouldPreserveSingleTokenMention(mention)) return true;
    const tokenRegex = new RegExp(`(^|\\s)${escapeRegex(token)}(\\s|$)`, "i");
    return !multiMentions.some((value) => tokenRegex.test(value));
  });
}

function isLikelySymbolMention(mention: string): boolean {
  const normalizedMention = mention.trim();
  if (!normalizedMention || normalizedMention.includes(" ")) return false;
  const compactMention = alnumCompact(normalizedMention);
  if (!compactMention) return false;
  if (compactMention.length > 12) return false;
  return /[0-9]/.test(compactMention) || compactMention.length <= 6;
}

function isGenericMechanismMention(mention: string): boolean {
  const normalizedMention = sanitizeMention(mention);
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

function normalizeRelationMention(value: string): string {
  let mention = sanitizeMention(normalizeDisplay(value));
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
    const tail = sanitizeMention(prepositionTailMatch[1]);
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
    /\b(?:connect|connection|relationship|link|overlap|related|relates)\s+(?:between\s+)?(.+?)\s+(?:to|with|and|vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (connectMatch) {
    addMention(connectMatch[1] ?? "");
    addMention(connectMatch[2] ?? "");
    addMention(connectMatch[3] ?? "");
  }

  const connectPrecedingMatch = cleaned.match(
    /(.+?)\s+(?:connect|connection|relationship|link|overlap|related|relates)\s+(?:to|with|and|vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
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

function diseaseIdPriority(id: string): number {
  if (/^EFO_/i.test(id)) return 6;
  if (/^MONDO_/i.test(id)) return 5;
  if (/^ORPHANET_/i.test(id)) return 4;
  if (/^DOID_/i.test(id)) return 3;
  if (/^HP_/i.test(id)) return 2;
  return 1;
}

function pickPreferredAnchor(existing: QueryPlanAnchor, candidate: QueryPlanAnchor): QueryPlanAnchor {
  if (candidate.confidence > existing.confidence) return candidate;
  if (candidate.confidence < existing.confidence) return existing;
  if (existing.entityType === "disease" && candidate.entityType === "disease") {
    const existingPriority = diseaseIdPriority(existing.id);
    const candidatePriority = diseaseIdPriority(candidate.id);
    if (candidatePriority > existingPriority) return candidate;
    if (candidatePriority < existingPriority) return existing;
  }
  if (candidate.name.length < existing.name.length) return candidate;
  return existing;
}

function dedupeAnchorsSemantically(anchors: QueryPlanAnchor[]): QueryPlanAnchor[] {
  const bySemantic = new Map<string, QueryPlanAnchor>();
  for (const anchor of anchors) {
    const key = `${anchor.entityType}:${normalize(anchor.name)}`;
    const existing = bySemantic.get(key);
    if (!existing) {
      bySemantic.set(key, anchor);
      continue;
    }
    bySemantic.set(key, pickPreferredAnchor(existing, anchor));
  }
  return [...bySemantic.values()];
}

function filterResolvedUnresolvedMentions(
  unresolvedMentions: string[],
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
    for (const value of [anchor.mention, anchor.name]) {
      const normalized = normalize(value);
      if (!normalized) continue;
      resolvedForms.add(normalized);
      const compactValue = canonicalCompact(value);
      if (compactValue) resolvedCompact.add(compactValue);
    }
  }

  return unresolvedMentions.filter((mention) => {
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

    const compactValue = canonicalCompact(mention);
    if (!compactValue) return true;
    if (resolvedCompact.has(compactValue)) return false;
    for (const token of resolvedCompact) {
      if (token.length >= 4 && compactValue.length >= 4) {
        if (token.includes(compactValue) || compactValue.includes(token)) return false;
      }
    }
    return true;
  });
}

function mergeQueryPlans(
  base: ResolvedQueryPlan,
  augment: ResolvedQueryPlan | null,
): ResolvedQueryPlan {
  if (!augment) return base;

  const anchorMap = new Map<string, QueryPlanAnchor>();
  for (const anchor of [...base.anchors, ...augment.anchors]) {
    const key = `${anchor.entityType}:${anchor.id}`;
    const existing = anchorMap.get(key);
    if (!existing || anchor.confidence > existing.confidence) {
      anchorMap.set(key, anchor);
    }
  }

  const constraints = new Map<string, QueryPlanConstraint>();
  for (const item of [...base.constraints, ...augment.constraints]) {
    constraints.set(`${item.polarity}:${item.text.toLowerCase()}`, item);
  }

  const followups = new Map<string, QueryPlanFollowup>();
  for (const item of [...base.followups, ...augment.followups]) {
    followups.set(item.question.toLowerCase(), item);
  }

  const mergedAnchors = dedupeAnchorsSemantically([...anchorMap.values()]).slice(0, 20);
  const unresolvedMentions = filterResolvedUnresolvedMentions(
    [...new Set([...base.unresolvedMentions, ...augment.unresolvedMentions])].slice(0, 12),
    mergedAnchors,
  );

  return {
    query: base.query,
    intent:
      augment.intent && augment.intent !== "multihop-discovery"
        ? augment.intent
        : base.intent,
    anchors: mergedAnchors,
    constraints: [...constraints.values()].slice(0, 10),
    unresolvedMentions,
    followups: [...followups.values()].slice(0, 10),
    rationale: `${base.rationale} ${augment.rationale}`.trim(),
  };
}

function keepDiseaseAnchor(anchor: QueryPlanAnchor): boolean {
  if (anchor.entityType !== "disease") return true;
  const mention = sanitizeMention(anchor.mention);
  if (!mention) return true;
  const mentionSimilarity = similarity(mention, anchor.name);
  const hasDirectDiseaseCue = /\b(?:disease|disorder|syndrome|cancer|carcinoma|tumou?r|diabetes|obesity|lupus|arthritis|sclerosis|colitis|asthma|fibrosis|infection)\b/i.test(
    mention,
  );
  if (mentionSimilarity >= 0.45 || hasDirectDiseaseCue) return true;
  const mechanisticPhrase = /\b(signaling|signal|pathway|pathways|mechanism|mechanistic|network|axis|cascade|events?)\b/i.test(
    mention,
  );
  if (mechanisticPhrase) return false;
  const tokenCount = mention.split(/\s+/).filter(Boolean).length;
  if (tokenCount <= 2 && anchor.confidence < 0.72) return false;
  return true;
}

function targetSymbolHintFromMention(mention: string): string | null {
  const mechanismTrimmed = mention
    .replace(/\b(signaling|signal|pathway|pathways|axis|cascade|network|events?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compactMention = alnumCompact(mechanismTrimmed || mention);
  if (!/^[a-z]{2,6}\d{1,3}[a-z]?$/i.test(compactMention)) return null;
  return compactMention.toUpperCase();
}

function isExplicitTargetLexeme(mention: string): boolean {
  const normalized = sanitizeMention(mention);
  if (!normalized) return false;
  if (/[0-9]/.test(normalized)) return true;
  if (/[-+]/.test(normalized)) return true;
  if (/\b(gene|protein|receptor|kinase|enzyme|channel|target)\b/i.test(normalized)) return true;
  return false;
}

function disambiguateMentionTargetDiseaseCollisions(anchors: QueryPlanAnchor[]): QueryPlanAnchor[] {
  const diseaseConfidenceByMention = new Map<string, number>();
  for (const anchor of anchors) {
    if (anchor.entityType !== "disease") continue;
    const key = normalize(anchor.mention || anchor.name);
    if (!key) continue;
    const existing = diseaseConfidenceByMention.get(key) ?? 0;
    if (anchor.confidence > existing) {
      diseaseConfidenceByMention.set(key, anchor.confidence);
    }
  }

  return anchors.filter((anchor) => {
    if (anchor.entityType !== "target") return true;
    const key = normalize(anchor.mention || anchor.name);
    if (!key) return true;
    const diseaseConfidence = diseaseConfidenceByMention.get(key) ?? 0;
    if (diseaseConfidence < 0.82) return true;
    if (isExplicitTargetLexeme(anchor.mention)) return true;
    return false;
  });
}

function mentionsFromQueryPlan(
  query: string,
  queryPlan: ResolvedQueryPlan | null,
): string[] {
  if (!queryPlan) return [];
  const mentionSet = new Set<string>();
  for (const anchor of queryPlan.anchors) {
    const mention = sanitizeMention(anchor.mention);
    if (mention) {
      mentionSet.add(mention);
    }
    if (anchor.entityType === "disease") {
      const canonicalDiseaseName = sanitizeMention(anchor.name);
      if (canonicalDiseaseName) {
        mentionSet.add(canonicalDiseaseName);
      }
    }
  }
  for (const unresolved of queryPlan.unresolvedMentions) {
    const mention = sanitizeMention(unresolved);
    if (!mention) continue;
    const tokenCount = mention.split(/\s+/).filter(Boolean).length;
    if (mention.length > 48 || tokenCount > 6) continue;
    if (/\b(connect|connection|relationship|related|relates|compare|between|vs|versus)\b/i.test(mention)) continue;
    mentionSet.add(mention);
  }
  for (const relationMention of extractStructuredMentions(query)) {
    if (isGenericMechanismMention(relationMention)) continue;
    mentionSet.add(relationMention);
  }
  return pruneSubsumedSingleTokenMentions([...mentionSet])
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .filter((item) => !/\b(connect|connection|relationship|related|relates|compare|between)\b/i.test(item))
    .filter((item) => !isGenericMechanismMention(item))
    .slice(0, 8);
}

function extractMentions(query: string): string[] {
  const normalized = sanitizeMention(
    normalizeDisplay(query).replace(mentionBoundaryPattern, " "),
  );
  if (!normalized) return [];

  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 2);
  if (tokens.length === 0) return [];
  const originalTokens = query.split(/\s+/).filter((token) => token.length >= 2);

  const mentionSet = new Set<string>();
  for (const mention of extractStructuredMentions(query)) {
    mentionSet.add(mention);
  }
  for (const tokenRaw of originalTokens) {
    const token = sanitizeMention(tokenRaw);
    const compactToken = alnumCompact(token);
    if (compactToken.length < 3 || compactToken.length > 18) continue;
    const hasSignal = /[0-9]/.test(compactToken) || /[A-Z]/.test(tokenRaw) || /[-+]/.test(tokenRaw);
    if (!hasSignal) continue;
    mentionSet.add(token);
  }

  if (mentionSet.size === 0) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = sanitizeMention(tokens[i] ?? "");
      if (token.length < 4) continue;
      const isLastToken = i === tokens.length - 1;
      const longBiomedicalLikeToken = token.length >= 8;
      if (isLastToken || longBiomedicalLikeToken) {
        mentionSet.add(token);
      }
    }
    const maxTailSize = Math.min(4, Math.max(2, tokens.length - 1));
    for (let size = 2; size <= maxTailSize; size += 1) {
      const tail = sanitizeMention(tokens.slice(-size).join(" "));
      if (tail.length >= 3) mentionSet.add(tail);
    }
  }

  const scoreMention = (mention: string): number => {
    const parts = mention.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return -100;
    const compactValue = alnumCompact(mention);
    const alphaNumeric = mention.replace(/[^a-z0-9]/gi, "").length;

    let score = 0;
    if (parts.length === 1) score += alphaNumeric >= 4 ? 1.6 : 0.3;
    else if (parts.length === 2) score += 1.8;
    else if (parts.length <= 4) score += 1.2;
    else score += 0.5;

    if (compactValue.length > 0 && compactValue.length <= 10) score += 0.4;
    if (/[0-9+\-]/.test(mention)) score += 0.55;
    if (mention.length > 60) score -= 1.3;
    score += Math.min(0.9, alphaNumeric / 26);
    return score;
  };

  return pruneSubsumedSingleTokenMentions([...mentionSet])
    .map((value) => sanitizeMention(value))
    .filter((value) => value.length >= 3)
    .filter((value) => !/^(?:what|which|how|why)\b/i.test(value))
    .filter((value) => !/\b(connect|connection|relationship|related|relates|compare|between|versus|vs)\b/i.test(value))
    .filter((value) => !isGenericMechanismMention(value))
    .sort((a, b) => scoreMention(b) - scoreMention(a))
    .slice(0, 10);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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

async function searchMentionCandidates(mention: string): Promise<MentionCandidate[]> {
  const normalizedMention = mention.trim();
  if (!normalizedMention) return [];

  const mentionVariants = new Set<string>([normalizedMention]);
  const compactMention = normalizedMention.replace(/\s+/g, "");
  const alphaNumericJoinMatch = compactMention.match(/^([A-Za-z]{2,})([0-9]{1,3})$/);
  if (alphaNumericJoinMatch) {
    mentionVariants.add(`${alphaNumericJoinMatch[1]}-${alphaNumericJoinMatch[2]}`);
    mentionVariants.add(`${alphaNumericJoinMatch[1]} ${alphaNumericJoinMatch[2]}`);
  }
  if (normalizedMention.includes("'")) {
    mentionVariants.add(normalizedMention.replace(/'/g, ""));
  }
  if (normalizedMention.includes("-")) {
    mentionVariants.add(normalizedMention.replace(/-/g, " "));
  }
  if (/^[a-z0-9-]{2,8}$/i.test(compactMention) && !normalizedMention.includes(" ")) {
    mentionVariants.add(compactMention.toUpperCase());
  }
  if (/^[a-z]{2,6}[0-9]{1,3}$/i.test(compactMention) && !normalizedMention.includes("-")) {
    const splitPoint = compactMention.search(/[0-9]/);
    if (splitPoint > 1) {
      mentionVariants.add(`${compactMention.slice(0, splitPoint)}-${compactMention.slice(splitPoint)}`);
    }
  }
  const mechanismTrimmed = normalizedMention
    .replace(/\b(signaling|signal|pathway|pathways|axis|cascade|network|events?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (mechanismTrimmed && mechanismTrimmed.length >= 2 && mechanismTrimmed !== normalizedMention) {
    mentionVariants.add(mechanismTrimmed);
  }

  const variants = [...mentionVariants].slice(0, 4);
  const diseaseRows: Awaited<ReturnType<typeof searchDiseases>> = [];
  const targetRows: TargetHit[] = [];
  const drugRows: Array<{ id: string; name: string; description?: string }> = [];
  const diseaseSeen = new Set<string>();
  const targetSeen = new Set<string>();
  const drugSeen = new Set<string>();

  for (const variant of variants) {
    const [diseaseHit, targetHit, drugHit, chemblDrugHit] = await Promise.all([
      withTimeout(searchDiseases(variant, 8), 5000).catch(() => []),
      withTimeout(searchTargets(variant, 8), 5000).catch(() => []),
      withTimeout(searchDrugs(variant, 8), 5000).catch(() => []),
      withTimeout(searchDrugCandidates(variant, 8), 5000).catch(() => []),
    ]);

    for (const row of diseaseHit) {
      if (diseaseSeen.has(row.id)) continue;
      diseaseSeen.add(row.id);
      diseaseRows.push(row);
    }
    for (const row of targetHit) {
      if (targetSeen.has(row.id)) continue;
      targetSeen.add(row.id);
      targetRows.push(row);
    }
    for (const row of drugHit) {
      if (drugSeen.has(row.id)) continue;
      drugSeen.add(row.id);
      drugRows.push(row);
    }
    for (const row of chemblDrugHit) {
      if (drugSeen.has(row.id)) continue;
      drugSeen.add(row.id);
      drugRows.push({
        id: row.id,
        name: row.name,
        description: row.description,
      });
    }
  }

  const toDisease = diseaseRows
    .filter((item) => diseaseIdPattern.test(item.id))
    .filter((item) => !isMeasurementLike(item.name, item.description))
    .map((item) => ({
      mention: normalizedMention,
      entityType: "disease" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score: similarity(normalizedMention, item.name),
      source: "opentargets" as const,
    }));
  const toTarget = targetRows.map((item: TargetHit) => ({
    mention: normalizedMention,
    entityType: "target" as const,
    id: item.id,
    name: item.name,
    description: item.description,
    score: Math.max(
      similarity(normalizedMention, item.name),
      similarity(normalizedMention, item.description ?? ""),
    ),
    source: "opentargets" as const,
  }));
  const toDrug = drugRows.map((item) => ({
    mention: normalizedMention,
    entityType: "drug" as const,
    id: item.id,
    name: item.name,
    description: item.description,
    score: Math.max(
      similarity(normalizedMention, item.name),
      similarity(normalizedMention, item.description ?? ""),
      similarity(normalizedMention, item.id),
    ),
    source: /^CHEMBL/i.test(item.id) ? ("chembl" as const) : ("opentargets" as const),
  }));

  const merged = [...toDisease, ...toTarget, ...toDrug]
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
  const deduped = new Map<string, MentionCandidate>();
  for (const row of merged) {
    const key = `${row.entityType}:${row.id}`;
    const existing = deduped.get(key);
    if (!existing || row.score > existing.score) {
      deduped.set(key, row);
    }
  }
  const mentionTokenCount = tokenize(normalizedMention).length;
  const lowerAlphaSingleToken =
    mentionTokenCount <= 1 && /^[a-z]{4,}$/.test(normalizedMention);
  const genericMechanisticMention = isGenericMechanismMention(normalizedMention);
  const symbolMention = isLikelySymbolMention(normalizedMention);
  const diseaseCueMention = hasDiseaseCue(normalizedMention);
  const filtered = [...deduped.values()].filter((row) => {
    let cutoff =
      row.entityType === "disease"
        ? mentionTokenCount <= 1
          ? lowerAlphaSingleToken
            ? 0.66
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
    if (diseaseCueMention && row.entityType !== "disease") {
      cutoff += 0.18;
    }
    return row.score >= cutoff;
  });

  const mentionCompact = alnumCompact(mechanismTrimmed || normalizedMention).toLowerCase();
  const hintTokens = new Set<string>();
  if (/^[a-z]{2,6}\d{1,3}[a-z]?$/i.test(mentionCompact)) {
    hintTokens.add(mentionCompact);
    const splitIndex = mentionCompact.search(/[0-9]/);
    if (splitIndex > 1) {
      const prefix = mentionCompact.slice(0, splitIndex);
      const suffix = mentionCompact.slice(splitIndex);
      hintTokens.add(`${prefix}-${suffix}`);
      hintTokens.add(`${prefix} ${suffix}`);
      if (prefix === "il") {
        hintTokens.add(`interleukin ${suffix}`);
      }
    }
  }

  const boosted = filtered.map((row) => {
    let nextScore = row.score;
    if (row.entityType === "target" && hintTokens.size > 0) {
      const haystack = `${row.name} ${row.description ?? ""}`.toLowerCase();
      const matchesHint = [...hintTokens].some((hint) => haystack.includes(hint));
      nextScore += matchesHint ? 0.45 : -0.12;
    }
    if (diseaseCueMention) {
      if (row.entityType === "disease") nextScore += 0.34;
      else nextScore -= 0.22;
    }
    if (nextScore === row.score) return row;
    return {
      ...row,
      score: nextScore,
    };
  });

  return boosted.sort((a, b) => b.score - a.score);
}

function diseaseCandidatesFromRows(
  query: string,
  rows: MentionCandidate[],
): Array<DiseaseCandidate & { score: number }> {
  const ontologyAdjustment = (candidateId: string): number => {
    if (/^(EFO|MONDO|DOID|ORPHANET)_/i.test(candidateId)) return 0.5;
    if (/^HP_/i.test(candidateId)) return -0.3;
    return 0;
  };

  const byId = new Map<
    string,
    {
      id: string;
      name: string;
      description?: string;
      bestSimilarity: number;
      mentionSet: Set<string>;
    }
  >();

  for (const row of rows) {
    if (row.entityType !== "disease") continue;
    if (isMeasurementLike(row.name, row.description)) continue;
    const existing = byId.get(row.id);
    if (existing) {
      existing.bestSimilarity = Math.max(existing.bestSimilarity, row.score);
      existing.mentionSet.add(row.mention);
      continue;
    }
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description,
      bestSimilarity: row.score,
      mentionSet: new Set([row.mention]),
    });
  }

  const baseCandidates = [...byId.values()].slice(0, 24);
  const normalizedQuery = normalize(query);
  const queryTokens = new Set(tokenize(query));

  return baseCandidates
    .map((item) => {
      const mentionSupport = Math.min(0.8, (item.mentionSet.size - 1) * 0.2);
      const normalizedCandidateName = normalize(item.name);
      const literalPhraseBonus = normalizedQuery.includes(normalizedCandidateName) ? 2.4 : 0;
      const querySimilarity = similarity(query, item.name);
      const mentionMaxSimilarity = [...item.mentionSet].reduce(
        (best, mention) => Math.max(best, similarity(mention, item.name)),
        0,
      );
      const candidateTokens = tokenize(item.name);
      const queryTokenCoverage =
        candidateTokens.length === 0
          ? 0
          : candidateTokens.filter((token) => queryTokens.has(token)).length /
            Math.max(1, candidateTokens.length);
      const unmatchedTokenPenalty =
        candidateTokens.length === 0
          ? 0
          : candidateTokens.filter((token) => !queryTokens.has(token)).length *
            0.38;
      const mergedScore =
        mentionMaxSimilarity * 2.8 +
        querySimilarity * 1.6 +
        item.bestSimilarity * 1.2 +
        queryTokenCoverage * 1.2 +
        mentionSupport +
        literalPhraseBonus -
        unmatchedTokenPenalty +
        ontologyAdjustment(item.id);
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        score: mergedScore,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);
}

function pickDeterministicDiseaseSelection(
  query: string,
  rankedDiseaseCandidates: Array<DiseaseCandidate & { score: number }>,
  options?: {
    hasDiseaseAnchor: boolean;
    hasNonDiseaseSignal: boolean;
  },
): DiseaseCandidate | null {
  if (rankedDiseaseCandidates.length === 0) return null;
  if (rankedDiseaseCandidates.length === 1) {
    const only = rankedDiseaseCandidates[0]!;
    const requiresStrongScore = Boolean(
      options?.hasNonDiseaseSignal && !options?.hasDiseaseAnchor,
    );
    if (requiresStrongScore && only.score < 3.1) {
      return null;
    }
    return {
      id: only.id,
      name: only.name,
      description: only.description,
    };
  }

  const top = rankedDiseaseCandidates[0]!;
  const second = rankedDiseaseCandidates[1];
  const topCandidate: DiseaseCandidate = {
    id: top.id,
    name: top.name,
    description: top.description,
  };
  const requiresStrongScore = Boolean(
    options?.hasNonDiseaseSignal && !options?.hasDiseaseAnchor,
  );
  const clearTop =
    (!second && top.score >= 2.2) ||
    (Boolean(second) && top.score >= 2.2 && top.score - (second?.score ?? 0) >= 1.4);
  if (requiresStrongScore && top.score < 3.1) {
    return null;
  }
  if (!clearTop) {
    const relationIntent = /\b(and|between|vs|versus|connection|relationship|related|relates|link|overlap|compare|compared|associated|correlated)\b/i.test(
      query,
    );
    if (!relationIntent) return topCandidate;
    return null;
  }
  return topCandidate;
}

function fallbackBundle(query: string, mentions: string[], rows: MentionCandidate[]): QueryEntityBundle {
  const byMention = new Map<string, MentionCandidate[]>();
  for (const row of rows) {
    byMention.set(row.mention, [...(byMention.get(row.mention) ?? []), row]);
  }

  const anchors: QueryPlanAnchor[] = [];
  const unresolvedMentions: string[] = [];
  for (const mention of mentions) {
    const mentionRows = (byMention.get(mention) ?? []).sort((a, b) => b.score - a.score);
    let top = mentionRows[0];
    const mentionThreshold = mention.split(" ").length <= 1 ? 0.58 : 0.32;
    if (hasDiseaseCue(mention)) {
      const topDisease = mentionRows.find((item) => item.entityType === "disease");
      if (topDisease && topDisease.score >= Math.max(0.24, mentionThreshold - 0.08)) {
        top = topDisease;
      }
    }
    if (!top || top.score < mentionThreshold) {
      unresolvedMentions.push(mention);
      continue;
    }
    anchors.push({
      mention,
      requestedType: "unknown",
      entityType: top.entityType,
      id: top.id,
      name: top.name,
      description: top.description,
      confidence: Math.max(0.2, Math.min(0.95, top.score)),
      source: "opentargets",
    });
  }

  if (anchors.length === 0) {
    const rankedRows = [...rows]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    const diseaseRows = rankedRows.filter((row) => row.entityType === "disease");
    const nonDiseaseRows = rankedRows.filter((row) => row.entityType !== "disease");
    const fallbackRows = (
      diseaseRows.length > 0 ? diseaseRows : nonDiseaseRows.length > 0 ? nonDiseaseRows : rankedRows
    ).slice(0, 3);
    for (const row of fallbackRows) {
      anchors.push({
        mention: row.mention,
        requestedType: "unknown",
        entityType: row.entityType,
        id: row.id,
        name: row.name,
        description: row.description,
        confidence: Math.max(0.2, Math.min(0.95, row.score)),
        source: "opentargets",
      });
    }
  }

  const rankedDiseaseCandidates = diseaseCandidatesFromRows(query, rows);
  const diseaseCandidates = rankedDiseaseCandidates
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
    }))
    .slice(0, 14);
  const hasDiseaseAnchor = anchors.some((anchor) => anchor.entityType === "disease");
  const hasNonDiseaseSignal = rows.some((row) => row.entityType !== "disease");
  const hasStrongNonDiseaseAnchor = anchors.some(
    (anchor) => anchor.entityType !== "disease" && anchor.confidence >= 0.66,
  );
  const topDiseaseScore = rankedDiseaseCandidates[0]?.score ?? -Infinity;
  let selectedDisease = pickDeterministicDiseaseSelection(
    query,
    rankedDiseaseCandidates,
    {
      hasDiseaseAnchor,
      hasNonDiseaseSignal,
    },
  );
  if (!hasDiseaseAnchor && hasStrongNonDiseaseAnchor && topDiseaseScore < 3.3) {
    selectedDisease = null;
  }
  return {
    query,
    selectedDisease,
    diseaseCandidates,
    queryPlan: {
      query,
      intent: "multihop-discovery",
      anchors,
      constraints: [],
      unresolvedMentions: unresolvedMentions.slice(0, 8),
      followups: [],
      rationale: "Lexical bundled resolver fallback.",
    },
    rationale: "Lexical bundled resolver fallback.",
    openAiCalls: 0,
  };
}

function shouldSkipSemanticResolution(query: string, rows: MentionCandidate[]): boolean {
  const openai = getOpenAiClient();
  if (!openai || isOpenAiRateLimited()) return true;
  if (rows.length === 0) return true;
  const diseaseCandidates = diseaseCandidatesFromRows(query, rows);
  const relationIntent = /\b(and|between|vs|versus|connection|relationship|related|relates|link|overlap|compare|compared|associated|correlated)\b/i.test(
    query,
  );
  const tokenCount = tokenize(query).length;
  const hasNonDiseaseCandidates = rows.some((row) => row.entityType !== "disease");

  const groupedByMention = new Map<string, number>();
  for (const row of rows) {
    groupedByMention.set(row.mention, (groupedByMention.get(row.mention) ?? 0) + 1);
  }
  const ambiguousMentionCount = [...groupedByMention.values()].filter((count) => count > 1).length;

  const topDisease = diseaseCandidates[0];
  const singleHighConfidenceDisease =
    diseaseCandidates.length === 1 && Boolean(topDisease && topDisease.score >= 3.2);
  const simpleSingleDiseaseQuery =
    singleHighConfidenceDisease &&
    ambiguousMentionCount === 0 &&
    !relationIntent &&
    !hasNonDiseaseCandidates &&
    tokenCount <= 4;

  if (simpleSingleDiseaseQuery) {
    return true;
  }
  if (rows.length <= 3 && diseaseCandidates.length <= 1 && !hasNonDiseaseCandidates) {
    return true;
  }
  return false;
}

async function runModelResolution(
  query: string,
  mentions: string[],
  rows: MentionCandidate[],
): Promise<QueryEntityBundle> {
  const openai = getOpenAiClient();
  if (shouldSkipSemanticResolution(query, rows)) {
    return fallbackBundle(query, mentions, rows);
  }
  if (!openai) return fallbackBundle(query, mentions, rows);

  const candidateByEntityId = new Map<string, MentionCandidate>();
  for (const row of rows) {
    candidateByEntityId.set(`${row.entityType}:${row.id}`, row);
  }
  const groupedByMention = mentions.map((mention) => ({
    mention,
    candidates: rows
      .filter((row) => row.mention === mention)
      .slice(0, 6)
      .map((row) => ({
        entityType: row.entityType,
        id: row.id,
        name: row.name,
        description: row.description,
        score: Number(row.score.toFixed(3)),
      })),
  }));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string" },
      anchors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            mention: { type: "string" },
            entityType: { type: "string", enum: ["disease", "target", "drug"] },
            id: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["mention", "entityType", "id", "confidence"],
        },
      },
      primaryDiseaseId: { type: "string" },
      unresolvedMentions: {
        type: "array",
        items: { type: "string" },
      },
      constraints: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            polarity: { type: "string", enum: ["include", "avoid", "optimize"] },
          },
          required: ["text", "polarity"],
        },
      },
      rationale: { type: "string" },
    },
    required: ["intent", "anchors", "unresolvedMentions", "constraints", "rationale"],
  } as const;

  try {
    const response = await withTimeout(
      openai.responses.create({
        model: appConfig.openai.smallModel,
        reasoning: { effort: "minimal" },
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: [
                  "Resolve biomedical entities from candidate lists.",
                  "Use only provided candidate IDs.",
                  "Identify disease/target/drug anchors and optionally primaryDiseaseId.",
                  "If query has no clear disease concept, keep disease anchors empty.",
                ].join(" "),
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({ query, mentions: groupedByMention }, null, 2),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "bundled_entity_resolution",
            schema,
            strict: true,
          },
        },
      }),
      6_500,
    );

    const parsed = JSON.parse(response.output_text) as ResolutionModelResult;
    const anchors: QueryPlanAnchor[] = [];
    for (const anchor of parsed.anchors ?? []) {
      const key = `${anchor.entityType}:${anchor.id}`;
      const hit = candidateByEntityId.get(key);
      if (!hit) continue;
      const candidateSimilarity = similarity(anchor.mention || hit.mention, hit.name);
      const boundedConfidence = Math.max(0.2, Math.min(0.98, Number(anchor.confidence ?? hit.score)));
      const mentionTokenCount = tokenize(anchor.mention || hit.mention).length;
      const mentionCompact = alnumCompact(anchor.mention || hit.mention);
      const symbolLikeMention = mentionTokenCount <= 1 && mentionCompact.length > 0 && mentionCompact.length <= 8;
      if (
        hit.entityType === "disease" &&
        !symbolLikeMention &&
        (candidateSimilarity < 0.42 || (boundedConfidence < 0.64 && candidateSimilarity < 0.56))
      ) {
        continue;
      }
      anchors.push({
        mention: compact(anchor.mention || hit.mention, 90),
        requestedType: "unknown" as MentionType,
        entityType: hit.entityType,
        id: hit.id,
        name: hit.name,
        description: hit.description,
        confidence: boundedConfidence,
        source: "opentargets",
      });
    }

    const rankedDiseaseCandidates = diseaseCandidatesFromRows(query, rows);
    const diseaseCandidates = rankedDiseaseCandidates.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
    }));

    const diseaseById = new Map(diseaseCandidates.map((item) => [item.id, item]));
    const firstDiseaseAnchorId = anchors.find((item) => item.entityType === "disease")?.id;
    const hasDiseaseAnchor = anchors.some((item) => item.entityType === "disease");
    const hasNonDiseaseSignal = rows.some((row) => row.entityType !== "disease");
    const hasStrongNonDiseaseAnchor = anchors.some(
      (item) => item.entityType !== "disease" && item.confidence >= 0.66,
    );
    const topDiseaseScore = rankedDiseaseCandidates[0]?.score ?? -Infinity;
    let selectedDisease =
      (parsed.primaryDiseaseId ? diseaseById.get(parsed.primaryDiseaseId) ?? null : null) ??
      (firstDiseaseAnchorId ? diseaseById.get(firstDiseaseAnchorId) ?? null : null) ??
      pickDeterministicDiseaseSelection(query, rankedDiseaseCandidates, {
        hasDiseaseAnchor,
        hasNonDiseaseSignal,
      }) ??
      null;

    if (!hasDiseaseAnchor && hasStrongNonDiseaseAnchor && topDiseaseScore < 3.3) {
      selectedDisease = null;
    }

    let openAiCalls = 1;
    if (diseaseCandidates.length > 1 && (hasDiseaseAnchor || !hasNonDiseaseSignal)) {
      try {
        const refinement = await chooseBestDiseaseCandidate(query, diseaseCandidates);
        selectedDisease = refinement.selected;
        openAiCalls += 1;
      } catch {
        // keep selected disease from bundled arbitration/fallback
      }
    }

    return {
      query,
      selectedDisease,
      diseaseCandidates,
      queryPlan: {
        query,
        intent: parsed.intent || "multihop-discovery",
        anchors: anchors.slice(0, 16),
        constraints: (parsed.constraints ?? []).slice(0, 8),
        unresolvedMentions: (parsed.unresolvedMentions ?? []).slice(0, 8),
        followups: [],
        rationale: parsed.rationale || "Bundled semantic entity resolution.",
      },
      rationale: parsed.rationale || "Bundled semantic entity resolution.",
      openAiCalls,
    };
  } catch (error) {
    handleOpenAiRateLimit(error);
    return fallbackBundle(query, mentions, rows);
  }
}

export async function resolveQueryEntitiesBundle(query: string): Promise<QueryEntityBundle> {
  const trimmed = query.trim();
  const cacheKey = normalize(trimmed);
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;

  const semanticPlan = await withTimeout(planQuery(trimmed), 14_000).catch(() => null);
  const llmRelationMentions = (await extractRelationMentionsFast(trimmed, {
    maxMentions: 6,
    timeoutMs: 1_800,
  }).catch(() => []))
    .map((item) => normalizeRelationMention(item) || sanitizeMention(item))
    .filter((item) => item.length >= 3)
    .filter((item) => !isGenericMechanismMention(item));
  const mentions = (() => {
    const fromPlan = mentionsFromQueryPlan(trimmed, semanticPlan);
    const lexical = fromPlan.length > 0 ? fromPlan : extractMentions(trimmed);
    const merged = new Set<string>();
    for (const mention of [...fromPlan, ...llmRelationMentions, ...lexical]) {
      const normalizedMention = sanitizeMention(mention);
      if (!normalizedMention) continue;
      merged.add(normalizedMention);
      if (merged.size >= 10) break;
    }
    return pruneSubsumedSingleTokenMentions([...merged]);
  })();
  const criticalSingleTokenMentions = mentions.filter(
    (mention) =>
      mention.split(" ").length === 1 &&
      /^[a-z0-9+\-]{2,8}$/i.test(mention),
  );
  const prioritizedMentions = [...new Set([...mentions.slice(0, 4), ...criticalSingleTokenMentions])]
    .slice(0, 6);
  const rows: MentionCandidate[] = [];
  const seenEntityIds = new Set<string>();
  const pushRows = (items: MentionCandidate[]) => {
    for (const item of items) {
      const key = `${item.entityType}:${item.id}`;
      if (seenEntityIds.has(key)) continue;
      seenEntityIds.add(key);
      rows.push(item);
    }
  };

  const prioritizedSettled = await Promise.allSettled(
    prioritizedMentions.map((mention) => searchMentionCandidates(mention)),
  );
  for (const result of prioritizedSettled) {
    if (result.status === "fulfilled") {
      pushRows(result.value);
    }
  }

  const stageOneDiseaseCount = rows.filter((row) => row.entityType === "disease").length;
  if (stageOneDiseaseCount < 2 || rows.length < 8) {
    const remainingMentions = mentions
      .slice(0, 8)
      .filter((mention) => !prioritizedMentions.includes(mention))
      .slice(0, 4);
    const remainingSettled = await Promise.allSettled(
      remainingMentions.map((mention) => searchMentionCandidates(mention)),
    );
    for (const result of remainingSettled) {
      if (result.status === "fulfilled") {
        pushRows(result.value);
      }
    }
  }

  const resolved = await runModelResolution(trimmed, mentions, rows);
  const merged = {
    ...resolved,
    queryPlan: mergeQueryPlans(resolved.queryPlan, semanticPlan),
    rationale: semanticPlan
      ? `${resolved.rationale} ${semanticPlan.rationale}`.trim()
      : resolved.rationale,
  };
  const canonicalAnchors = await Promise.all(
    merged.queryPlan.anchors.map(async (anchor) => {
      if (anchor.entityType !== "target") return anchor;
      const symbolHint = targetSymbolHintFromMention(anchor.mention);
      if (!symbolHint) return anchor;
      if (alnumCompact(anchor.name).toUpperCase() === symbolHint) return anchor;
      const hits = await withTimeout(searchTargets(symbolHint, 8), 5_000).catch(() => []);
      const exact = hits.find((hit) => alnumCompact(hit.name).toUpperCase() === symbolHint);
      if (!exact) return null;
      return {
        ...anchor,
        id: exact.id,
        name: exact.name,
        description: exact.description,
        confidence: Math.max(anchor.confidence, 0.92),
      };
    }),
  );
  merged.queryPlan = {
    ...merged.queryPlan,
    anchors: disambiguateMentionTargetDiseaseCollisions(
      dedupeAnchorsSemantically(
        canonicalAnchors
          .filter((anchor): anchor is QueryPlanAnchor => Boolean(anchor))
          .filter((anchor) => keepDiseaseAnchor(anchor)),
      ),
    ),
  };
  if (
    merged.queryPlan.anchors.length > 0 ||
    merged.diseaseCandidates.length > 0 ||
    Boolean(merged.selectedDisease)
  ) {
    bundleCache.set(cacheKey, merged);
  }
  return merged;
}
