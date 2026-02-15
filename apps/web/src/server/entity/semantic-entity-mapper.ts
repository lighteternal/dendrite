import OpenAI from "openai";
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { extractDiseaseIntent } from "@/server/openai/disease-resolver";
import {
  searchDiseases,
  searchDrugs,
  searchTargets,
} from "@/server/mcp/opentargets";

type ConceptType = "disease" | "target" | "drug" | "intervention" | "pathway";

type ConceptMention = {
  mention: string;
  type: ConceptType;
};

type CanonicalEntity = {
  entityType: "disease" | "target" | "drug";
  id: string;
  name: string;
  description?: string;
  score: number;
};

export type ResolvedConcept = {
  mention: string;
  type: ConceptType;
  selected: CanonicalEntity | null;
  alternatives: CanonicalEntity[];
};

type ResolveConceptOptions = {
  useLlm?: boolean;
  maxConcepts?: number;
};

const openai = appConfig.openAiApiKey
  ? new OpenAI({ apiKey: appConfig.openAiApiKey })
  : null;

const conceptCache = createTTLCache<string, ResolvedConcept[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const diseaseQualifierTerms = [
  "biomarker",
  "measurement",
  "profile",
  "susceptibility",
  "severity",
  "risk",
  "response",
  "progression",
  "screening",
  "finding",
  "trait",
];

function normalizeGreek(value: string): string {
  return value
    .toLowerCase()
    .replace(/α/g, "alpha")
    .replace(/β/g, "beta")
    .replace(/γ/g, "gamma")
    .replace(/δ/g, "delta")
    .replace(/[-_]/g, " ")
    .replace(/\btnf\s*a\b/g, "tnf alpha")
    .replace(/\btnf\s*b\b/g, "tnf beta")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeMention(value: string): string {
  return value
    .trim()
    .replace(/^(of|for|to|in|with)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDiseaseMention(value: string): string {
  return sanitizeMention(value)
    .split(/\s+/)
    .filter((token) => {
      const normalized = normalizeGreek(token);
      return !diseaseQualifierTerms.some((term) => normalized === term);
    })
    .join(" ")
    .trim();
}

function isQuestionLike(value: string): boolean {
  const normalized = normalizeGreek(value);
  return /\b(what|which|why|how|implication|impact|effect|best|strongest|thread)\b/.test(
    normalized,
  );
}

function greekHint(value: string): "alpha" | "beta" | "gamma" | "delta" | null {
  const normalized = normalizeGreek(value);
  if (/\balpha\b/.test(normalized)) return "alpha";
  if (/\bbeta\b/.test(normalized)) return "beta";
  if (/\bgamma\b/.test(normalized)) return "gamma";
  if (/\bdelta\b/.test(normalized)) return "delta";
  return null;
}

function tokens(value: string): string[] {
  return normalizeGreek(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function interventionAnchorVariants(mention: string): string[] {
  const normalized = normalizeGreek(mention).replace(/\binhibitors?\b/g, "").trim();
  const variants = new Set<string>();
  if (normalized) variants.add(normalized);

  if (/\btnf\s+alpha\b/.test(normalized)) {
    variants.add("tnf alpha");
    variants.add("tnf-a");
    variants.add("tnf a");
    variants.add("tnf");
  }

  if (/\btnf\s+beta\b/.test(normalized)) {
    variants.add("tnf beta");
    variants.add("tnf-b");
    variants.add("tnf b");
  }

  return [...variants].filter((value) => value.length >= 2).slice(0, 4);
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

function scoreMatch(mention: string, candidateName: string, description?: string): number {
  const mentionNorm = normalizeGreek(mention);
  const nameNorm = normalizeGreek(candidateName);
  const descNorm = normalizeGreek(description ?? "");

  let score = 0;
  if (mentionNorm === nameNorm) score += 5.5;
  if (nameNorm.startsWith(mentionNorm) && mentionNorm.length > 3) score += 1.6;
  if (mentionNorm.includes(nameNorm) && nameNorm.length > 3) score += 1.2;

  const mentionTokens = tokens(mentionNorm);
  const candidateTokens = new Set([...tokens(nameNorm), ...tokens(descNorm)]);
  const shared = mentionTokens.filter((token) => candidateTokens.has(token));

  if (shared.length > 0) {
    score += shared.length * 1.25;
    score += shared.length / Math.max(1, mentionTokens.length);
  } else {
    score -= 1.8;
  }

  const mentionGreek = greekHint(mentionNorm);
  const candidateGreek = greekHint(`${nameNorm} ${descNorm}`);
  if (mentionGreek && candidateGreek && mentionGreek !== candidateGreek) {
    score -= 8;
  }

  if (/\binhibitors?\b/.test(mentionNorm) && /\bdrug\b/.test(descNorm)) {
    score += 0.5;
  }

  const shortCandidate = nameNorm.replace(/\s+/g, "");
  if (shortCandidate.length <= 4 && mentionNorm.includes(shortCandidate)) {
    score += 2.6;
  }

  return score;
}

function dedupeMentions(concepts: ConceptMention[]): ConceptMention[] {
  const seen = new Set<string>();
  const out: ConceptMention[] = [];
  for (const concept of concepts) {
    const normalizedMention = normalizeGreek(concept.mention);
    const cleanedMention = sanitizeMention(concept.mention);
    if (!cleanedMention) continue;
    if (isQuestionLike(cleanedMention)) continue;
    const key = `${concept.type}:${normalizedMention}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      mention: concept.type === "disease" ? normalizeDiseaseMention(cleanedMention) : cleanedMention,
      type: concept.type,
    });
  }
  return out
    .filter((concept) => concept.mention.length >= 2)
    .slice(0, 4);
}

function heuristicConcepts(query: string): ConceptMention[] {
  const concepts: ConceptMention[] = [];
  const text = query.trim();
  const inhibitorMatches = text.matchAll(
    /\b([a-zA-Z0-9αβγδ\-]{2,}(?:\s+[a-zA-Z0-9αβγδ\-]{2,})?\s+inhibitors?)\b/g,
  );
  for (const hit of inhibitorMatches) {
    const mention = hit[1]?.trim();
    if (mention) {
      concepts.push({
        mention,
        type: "intervention",
      });
    }
  }

  const diseaseHintFromIntent = extractDiseaseIntent(query);
  const diseaseWordCount = diseaseHintFromIntent.split(/\s+/).filter(Boolean).length;
  if (
    diseaseHintFromIntent.length > 2 &&
    diseaseWordCount <= 7 &&
    !isQuestionLike(diseaseHintFromIntent) &&
    !/\binhibitors?\b/i.test(diseaseHintFromIntent)
  ) {
    concepts.push({
      mention: diseaseHintFromIntent,
      type: "disease",
    });
  }

  const prepositionMatches = text.matchAll(
    /\b(?:to|for|in|with)\s+([a-zA-Z][a-zA-Z0-9\s'\-]{2,40})/g,
  );
  for (const hit of prepositionMatches) {
    const raw = hit[1]?.trim();
    if (!raw) continue;
    const truncated = raw
      .split(/\b(what|which|why|how|and|or|that)\b/i)[0]
      ?.trim();
    if (
      truncated &&
      truncated.length >= 3 &&
      truncated.split(/\s+/).length <= 6 &&
      !isQuestionLike(truncated)
    ) {
      concepts.push({
        mention: truncated,
        type: "disease",
      });
    }
  }

  const actionMatches = text.matchAll(
    /\b(?:help(?:s)?|improve(?:s)?|reduce(?:s)?|affect(?:s)?)\s+([a-zA-Z][a-zA-Z0-9\s'\-]{2,40})/g,
  );
  for (const hit of actionMatches) {
    const raw = hit[1]?.trim();
    if (!raw) continue;
    const truncated = raw
      .split(/\b(what|which|why|how|and|or|that)\b/i)[0]
      ?.trim();
    if (
      truncated &&
      truncated.length >= 3 &&
      truncated.split(/\s+/).length <= 6 &&
      !isQuestionLike(truncated)
    ) {
      concepts.push({
        mention: truncated,
        type: "disease",
      });
    }
  }

  return dedupeMentions(concepts);
}

async function extractConceptMentions(query: string, useLlm: boolean): Promise<ConceptMention[]> {
  const fallback = heuristicConcepts(query);
  if (!useLlm || !openai) return fallback;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      concepts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            mention: { type: "string" },
            type: {
              type: "string",
              enum: ["disease", "target", "drug", "intervention", "pathway"],
            },
          },
          required: ["mention", "type"],
        },
      },
    },
    required: ["concepts"],
  } as const;

  const systemPrompt = [
    "Extract explicit biomedical concepts from the user sentence.",
    "Prefer minimal high-confidence concepts (usually 1-3).",
    "Preserve the exact mention phrase from the sentence.",
    "Do not hallucinate concepts not written by user.",
    "Do not substitute alpha and beta families (e.g., TNF-alpha is not TNF-beta).",
  ].join(" ");

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: appConfig.openai.smallModel,
        max_output_tokens: 220,
        reasoning: { effort: "minimal" },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: query }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "biomedical_concept_mentions",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("concept extraction timeout")), 1200),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as {
      concepts?: ConceptMention[];
    };
    const mentions = dedupeMentions(parsed.concepts ?? []);
    if (mentions.length === 0) return fallback;
    return mentions;
  } catch {
    return fallback;
  }
}

async function resolveDiseaseMention(mention: string): Promise<CanonicalEntity[]> {
  const normalizedMention = normalizeDiseaseMention(mention);
  const query = normalizedMention.length >= 3 ? normalizedMention : mention;
  const hits = await searchDiseases(query, 8);
  return hits
    .map((item) => ({
      entityType: "disease" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score: scoreMatch(query, item.name, item.description),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

async function resolveTargetMention(mention: string): Promise<CanonicalEntity[]> {
  const hits = await searchTargets(mention, 8);
  return hits
    .map((item) => ({
      entityType: "target" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score: scoreMatch(mention, item.name, item.description),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

async function resolveDrugMention(mention: string): Promise<CanonicalEntity[]> {
  const hits = await searchDrugs(mention, 8);
  return hits
    .map((item) => ({
      entityType: "drug" as const,
      id: item.id,
      name: item.name,
      description: item.description,
      score: scoreMatch(mention, item.name, item.description),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

async function resolveInterventionMention(mention: string): Promise<CanonicalEntity[]> {
  const anchors = interventionAnchorVariants(mention);
  const targetSets = await Promise.all(
    anchors.length > 0
      ? anchors.map((anchor) => resolveTargetMention(anchor))
      : [Promise.resolve([] as CanonicalEntity[])],
  );
  const mentionNorm = normalizeGreek(mention);

  const targetMap = new Map<string, CanonicalEntity>();
  for (const candidate of targetSets.flat()) {
    const existing = targetMap.get(candidate.id);
    if (!existing || candidate.score > existing.score) {
      targetMap.set(candidate.id, candidate);
    }
  }

  const targetHits = [...targetMap.values()].map((candidate) => {
    const nameNorm = normalizeGreek(candidate.name);
    const descNorm = normalizeGreek(candidate.description ?? "");
    let boostedScore = candidate.score;

    if (
      /\btnf\s+alpha\b/.test(mentionNorm) &&
      /\bbeta\b/.test(`${nameNorm} ${descNorm}`)
    ) {
      boostedScore -= 8;
    }

    if (/\btnf\b/.test(mentionNorm) && nameNorm === "tnf") {
      boostedScore += 4;
    }

    return {
      ...candidate,
      score: boostedScore,
    };
  });

  const drugHits = await resolveDrugMention(mention);

  const combined = [...targetHits, ...drugHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  return combined;
}

export async function resolveSemanticConcepts(
  query: string,
  options: ResolveConceptOptions = {},
): Promise<ResolvedConcept[]> {
  const useLlm = options.useLlm ?? true;
  const maxConcepts = Math.max(1, Math.min(4, options.maxConcepts ?? 4));
  const cacheKey = `${normalizeGreek(query)}::${useLlm ? "llm" : "det"}::${maxConcepts}`;
  const cached = conceptCache.get(cacheKey);
  if (cached) return cached;

  const mentions = (await extractConceptMentions(query, useLlm)).slice(0, maxConcepts);
  const settled = await Promise.allSettled(
    mentions.map(async (mention) => {
      let alternatives: CanonicalEntity[] = [];
      if (mention.type === "disease") {
        alternatives = await withTimeout(resolveDiseaseMention(mention.mention), 900);
      } else if (mention.type === "target") {
        alternatives = await withTimeout(resolveTargetMention(mention.mention), 900);
      } else if (mention.type === "drug") {
        alternatives = await withTimeout(resolveDrugMention(mention.mention), 900);
      } else if (mention.type === "intervention") {
        alternatives = await withTimeout(resolveInterventionMention(mention.mention), 900);
      }

      return {
        mention: mention.mention,
        type: mention.type,
        selected: alternatives[0] ?? null,
        alternatives,
      } satisfies ResolvedConcept;
    }),
  );

  const concepts: ResolvedConcept[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      concepts.push(result.value);
    }
  }

  const filtered = concepts
    .filter((concept) => {
      const selected = concept.selected;
      if (!selected) return false;
      if (concept.type === "disease" && /\binhibitors?\b/i.test(concept.mention)) {
        return false;
      }
      if (concept.type === "disease") {
        return selected.score >= 2.2;
      }
      return selected.score >= 0.9;
    })
    .sort((a, b) => (b.selected?.score ?? 0) - (a.selected?.score ?? 0));

  const dedupedByMention = new Map<string, ResolvedConcept>();
  for (const concept of filtered) {
    const key = normalizeGreek(concept.mention);
    const existing = dedupedByMention.get(key);
    const currentScore = concept.selected?.score ?? 0;
    if (!existing || currentScore > (existing.selected?.score ?? 0)) {
      dedupedByMention.set(key, concept);
    }
  }

  const dedupedByEntity = new Map<string, ResolvedConcept>();
  for (const concept of dedupedByMention.values()) {
    const selected = concept.selected;
    if (!selected) continue;
    const key = `${selected.entityType}:${selected.id}`;
    if (!dedupedByEntity.has(key)) {
      dedupedByEntity.set(key, concept);
    }
  }

  const result = [...dedupedByEntity.values()].slice(0, 4);
  conceptCache.set(cacheKey, result);
  return result;
}

export async function inferDiseaseFromQuery(query: string): Promise<{
  id: string;
  name: string;
} | null> {
  const concepts = await resolveSemanticConcepts(query, {
    useLlm: false,
    maxConcepts: 2,
  });
  for (const concept of concepts) {
    if (concept.selected?.entityType === "disease") {
      return {
        id: concept.selected.id,
        name: concept.selected.name,
      };
    }
  }
  return null;
}
