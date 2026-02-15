import OpenAI from "openai";
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { chooseAutocompleteModel } from "@/server/openai/model-router";

const AUTOCOMPLETE_TIMEOUT_MS = 360;
const OPENAI_AUTOCOMPLETE_ENABLED = process.env.AUTOCOMPLETE_USE_OPENAI === "1";

const openai = OPENAI_AUTOCOMPLETE_ENABLED && appConfig.openAiApiKey
  ? new OpenAI({ apiKey: appConfig.openAiApiKey })
  : null;

const autocompleteCache = createTTLCache<string, string[]>(
  Math.min(appConfig.cache.ttlMs, 2 * 60 * 1000),
  Math.min(appConfig.cache.maxEntries, 400),
);

const curatedQueries = [
  "is als hereditary?",
  "is als hereditary or sporadic?",
  "is als hereditary and which genes are implicated?",
  "what are the treatments for lupus?",
  "what are the treatments for lupus with strongest evidence?",
  "what are the treatments for systemic lupus erythematosus by mechanism class?",
  "what is the moa of paracetamol in fever?",
  "what is the moa of paracetamol in fever and which targets are involved?",
  "what pathways are implicated in crohn disease?",
  "what genes are linked to alzheimer disease?",
  "which targets are strongest for non small cell lung cancer?",
  "which targets are strongest for rheumatoid arthritis with tractable compounds?",
  "does tnf inhibition help ulcerative colitis?",
  "is psoriasis autoimmune?",
  "how does metformin affect ampk in type 2 diabetes?",
  "which pathways connect il6 to rheumatoid arthritis?",
  "what are the key caveats for tnf inhibitors in crohn disease?",
  "what evidence supports jak inhibitors in atopic dermatitis?",
  "is multiple sclerosis hereditary?",
  "what targets are actionable in glioblastoma?",
  "what mechanism links amyloid beta to tau pathology?",
  "which compounds modulate nlrp3 in gout?",
  "is ulcerative colitis hereditary?",
  "is lupus hereditary?",
  "is rheumatoid arthritis hereditary?",
];

const curatedSet = new Set(curatedQueries.map((item) => normalizeLower(item)));

const stopperTokens = new Set([
  "the",
  "a",
  "an",
  "for",
  "in",
  "of",
  "to",
  "and",
  "or",
  "is",
  "are",
  "what",
  "which",
  "how",
  "does",
  "do",
  "can",
]);

function normalizePrefix(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+\?/g, "?");
}

function normalizeLower(value: string): string {
  return normalizePrefix(value).toLowerCase();
}

function tokenize(value: string): string[] {
  return normalizeLower(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function compact(value: string, max = 180): string {
  const normalized = normalizePrefix(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function normalizedToken(value: string): string {
  let token = value.trim().toLowerCase();
  if (token.endsWith("s") && token.length > 4) token = token.slice(0, -1);
  if (token === "moa") return "mechanism";
  if (token === "als") return "amyotrophic";
  return token;
}

function editDistanceWithin(a: string, b: string, maxDistance: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > maxDistance) return false;

  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let i = 0; i <= b.length; i += 1) prev[i] = i;

  for (let i = 1; i <= a.length; i += 1) {
    next[0] = i;
    let rowMin = next[0];
    const aChar = a.charCodeAt(i - 1);

    for (let j = 1; j <= b.length; j += 1) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      next[j] = Math.min(
        prev[j]! + 1,
        next[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
      rowMin = Math.min(rowMin, next[j]!);
    }

    if (rowMin > maxDistance) return false;
    for (let j = 0; j <= b.length; j += 1) prev[j] = next[j]!;
  }

  return prev[b.length]! <= maxDistance;
}

function fuzzyLastTokenMatch(prefix: string, candidate: string): { matches: boolean; penalty: number } {
  const prefixTokens = tokenize(prefix);
  const candidateTokens = tokenize(candidate);

  if (prefixTokens.length === 0 || candidateTokens.length < prefixTokens.length) {
    return { matches: false, penalty: 0 };
  }

  for (let i = 0; i < prefixTokens.length - 1; i += 1) {
    if (normalizedToken(prefixTokens[i]!) !== normalizedToken(candidateTokens[i]!)) {
      return { matches: false, penalty: 0 };
    }
  }

  const typedLast = normalizedToken(prefixTokens[prefixTokens.length - 1]!);
  const candidateLast = normalizedToken(candidateTokens[prefixTokens.length - 1]!);

  if (!typedLast || !candidateLast) {
    return { matches: false, penalty: 0 };
  }

  if (candidateLast.startsWith(typedLast)) {
    return { matches: true, penalty: 0.4 };
  }

  const maxDistance = typedLast.length >= 7 ? 2 : 1;
  if (typedLast.length >= 4 && editDistanceWithin(typedLast, candidateLast, maxDistance)) {
    return { matches: true, penalty: 1.4 };
  }

  return { matches: false, penalty: 0 };
}

function candidateMatch(prefix: string, candidate: string): { matches: boolean; penalty: number } {
  const prefixLower = normalizeLower(prefix);
  const candidateLower = normalizeLower(candidate);

  if (candidateLower.startsWith(prefixLower)) {
    return { matches: true, penalty: 0 };
  }

  return fuzzyLastTokenMatch(prefixLower, candidateLower);
}

function extractSubject(prefix: string, startToken: string, stopToken: string): string | null {
  const normalized = normalizeLower(prefix);
  const startIndex = normalized.indexOf(startToken);
  if (startIndex === -1) return null;
  const from = startIndex + startToken.length;
  const stopIndex = normalized.indexOf(stopToken, from);
  const raw = (stopIndex === -1 ? normalized.slice(from) : normalized.slice(from, stopIndex)).trim();
  return raw.length > 0 ? raw : null;
}

function extractSuffix(prefix: string, marker: string): string | null {
  const normalized = normalizeLower(prefix);
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return null;
  const raw = normalized.slice(markerIndex + marker.length).trim();
  return raw.length > 0 ? raw : null;
}

function inferIntent(prefix: string): "hereditary" | "treatments" | "moa" | "targets" | "pathways" | "generic" {
  const normalized = normalizeLower(prefix);
  if (normalized.startsWith("is ") && normalized.includes("hered")) return "hereditary";
  if (normalized.includes("treatments for") || normalized.includes("therapy for")) return "treatments";
  if (normalized.includes("moa") || normalized.includes("mechanism of action")) return "moa";
  if (normalized.startsWith("which targets")) return "targets";
  if (normalized.startsWith("what pathways") || normalized.startsWith("which pathways")) return "pathways";
  return "generic";
}

function buildHeuristicCandidates(prefix: string): string[] {
  const normalized = normalizeLower(prefix);
  if (!normalized) return [];

  const candidates: string[] = [];

  let hereditarySubject =
    extractSubject(normalized, "is ", " hereditary") ??
    (normalized.startsWith("is ") && normalized.includes(" her")
      ? normalized.slice(3, normalized.indexOf(" her")).trim()
      : null);

  if (hereditarySubject) {
    hereditarySubject = hereditarySubject.replace(/\bhered\w*\b/g, "").trim();
  }

  if (hereditarySubject && hereditarySubject.length > 1) {
    candidates.push(
      `is ${hereditarySubject} hereditary?`,
      `is ${hereditarySubject} hereditary or sporadic?`,
      `is ${hereditarySubject} hereditary and which genes are implicated?`,
    );
  }

  const treatmentSubject =
    extractSuffix(normalized, "what are the treatments for ") ??
    extractSuffix(normalized, "treatments for ");
  if (treatmentSubject && treatmentSubject.length > 1) {
    candidates.push(
      `what are the treatments for ${treatmentSubject}?`,
      `what are the treatments for ${treatmentSubject} with strongest evidence?`,
      `what are the treatments for ${treatmentSubject} by mechanism class?`,
    );
  }

  const moaSubject =
    extractSuffix(normalized, "what is the moa of ") ??
    extractSuffix(normalized, "mechanism of action of ");
  if (moaSubject && moaSubject.length > 1) {
    const inIndex = moaSubject.indexOf(" in ");
    const drug = inIndex === -1 ? moaSubject : moaSubject.slice(0, inIndex).trim();
    const context = inIndex === -1 ? "" : moaSubject.slice(inIndex + 4).trim();

    if (drug.length > 1 && context.length > 1) {
      candidates.push(
        `what is the moa of ${drug} in ${context}?`,
        `what is the moa of ${drug} in ${context} and which targets are involved?`,
      );
    } else if (drug.length > 1) {
      candidates.push(
        `what is the moa of ${drug}?`,
        `what is the moa of ${drug} and which targets are involved?`,
      );
    }
  }

  if (normalized.startsWith("which targets")) {
    candidates.push(
      `${compact(prefix)} have strongest evidence?`,
      `${compact(prefix)} have tractable compounds?`,
    );
  }

  if (normalized.startsWith("what pathways") || normalized.startsWith("which pathways")) {
    candidates.push(
      `${compact(prefix)} are most implicated?`,
      `${compact(prefix)} connect disease to top targets?`,
    );
  }

  if (normalized.startsWith("does ") && normalized.includes(" help ")) {
    candidates.push(
      `${compact(prefix)}?`,
      `${compact(prefix)} and what evidence supports it?`,
    );
  }

  return candidates;
}

function scoreCandidate(prefix: string, candidate: string): number {
  const prefixLower = normalizeLower(prefix);
  const candidateLower = normalizeLower(candidate);

  const matched = candidateMatch(prefixLower, candidateLower);
  if (!matched.matches) return Number.NEGATIVE_INFINITY;

  const delta = Math.max(0, candidateLower.length - prefixLower.length);
  const prefixTokens = tokenize(prefixLower).map(normalizedToken).filter((token) => !stopperTokens.has(token));
  const candidateTokens = new Set(tokenize(candidateLower).map(normalizedToken));
  const overlap = prefixTokens.filter((token) => candidateTokens.has(token)).length;

  const intent = inferIntent(prefixLower);
  const candidateIntent = inferIntent(candidateLower);

  let score = 120 - Math.min(72, delta * 0.85);
  score -= matched.penalty * 14;
  score += overlap * 8;

  if (candidateLower.endsWith("?")) score += 2;
  if (curatedSet.has(candidateLower)) score += 7;
  if (intent === candidateIntent && intent !== "generic") score += 10;

  return score;
}

function rankDeterministic(prefix: string, candidates: string[], limit: number): string[] {
  const normalizedPrefix = normalizePrefix(prefix);
  const deduped = new Set<string>();
  return candidates
    .map((candidate) => normalizePrefix(candidate))
    .filter((candidate) => candidate.length >= Math.max(6, normalizedPrefix.length + 1))
    .filter((candidate) => {
      const key = normalizeLower(candidate);
      if (deduped.has(key)) return false;
      deduped.add(key);
      return true;
    })
    .map((candidate) => ({ candidate, score: scoreCandidate(normalizedPrefix, candidate) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.candidate);
}

function deterministicSuggestions(prefix: string, limit: number): string[] {
  const normalizedPrefix = normalizePrefix(prefix);
  const pool = [...buildHeuristicCandidates(normalizedPrefix), ...curatedQueries];
  const ranked = rankDeterministic(normalizedPrefix, pool, limit);

  if (ranked.length > 0) return ranked;

  if (normalizedPrefix.length >= 6 && !normalizedPrefix.endsWith("?")) {
    return rankDeterministic(
      normalizedPrefix,
      [
        `${compact(normalizedPrefix)}?`,
        `${compact(normalizedPrefix)} and which targets have strongest evidence?`,
        `${compact(normalizedPrefix)} and what are the key caveats?`,
      ],
      limit,
    );
  }

  return [];
}

async function maybeOpenAiSuggestions(prefix: string, limit: number): Promise<string[]> {
  if (!openai) return [];

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      suggestions: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["suggestions"],
  } as const;

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: chooseAutocompleteModel(),
        max_output_tokens: 140,
        reasoning: { effort: "minimal" },
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: [
                  "Generate biomedical translational autocomplete suggestions.",
                  "Return 1-5 high-quality completions.",
                  "Prefer canonical disease/target wording.",
                  "No speculative or trendy phrasing.",
                ].join(" "),
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: `Prefix: ${prefix}` }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "query_autocomplete",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("autocomplete timeout")), AUTOCOMPLETE_TIMEOUT_MS),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as { suggestions?: string[] };
    const suggestions = (parsed.suggestions ?? [])
      .map((item) => normalizePrefix(item))
      .filter((item) => item.length > 0)
      .slice(0, limit * 2);

    return rankDeterministic(prefix, suggestions, limit);
  } catch {
    return [];
  }
}

export async function suggestQueryCompletions(
  prefix: string,
  limit = 5,
): Promise<string[]> {
  const normalized = normalizePrefix(prefix);
  if (normalized.length < 3) return [];

  const cacheKey = `${normalizeLower(normalized)}::${limit}`;
  const cached = autocompleteCache.get(cacheKey);
  if (cached) return cached;

  const deterministic = deterministicSuggestions(normalized, limit);
  if (!openai || deterministic.length >= limit) {
    autocompleteCache.set(cacheKey, deterministic);
    return deterministic;
  }

  const semantic = await maybeOpenAiSuggestions(normalized, limit);
  const merged = rankDeterministic(normalized, [...deterministic, ...semantic], limit);

  autocompleteCache.set(cacheKey, merged);
  return merged;
}
