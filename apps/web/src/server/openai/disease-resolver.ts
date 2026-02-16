import { appConfig } from "@/server/config";
import { handleOpenAiRateLimit, isOpenAiRateLimited } from "@/server/openai/rate-limit";
import { chooseDiseaseAutocompleteRankingModel } from "@/server/openai/model-router";
import { createTrackedOpenAIClient } from "@/server/openai/client";

export type DiseaseCandidate = {
  id: string;
  name: string;
  description?: string;
};

export type DiseaseAliasExpansion = {
  isDisease: boolean;
  aliases: string[];
  rationale: string;
};

function getOpenAiClient() {
  return createTrackedOpenAIClient();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractDiseaseIntent(query: string): string {
  // Keep full normalized query context; do not apply stopword/splitter pruning.
  return normalizeText(query);
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token.length > 1)
    .map((token) =>
      token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token,
    );
}

function alnumCompact(value: string): string {
  return value.replace(/[^a-z0-9]/g, "");
}

function initials(tokens: string[]): string {
  return tokens
    .map((token) => alnumCompact(token))
    .filter((token) => token.length > 0)
    .map((token) => token[0] ?? "")
    .join("");
}

function ontologyAdjustment(candidateId: string): number {
  if (/^(EFO|MONDO|DOID|ORPHANET)_/i.test(candidateId)) return 1.5;
  if (/^HP_/i.test(candidateId)) return -2;
  return 0;
}

function scoreCandidate(intent: string, candidate: DiseaseCandidate): number {
  const candidateNorm = normalizeText(candidate.name);
  const intentNorm = normalizeText(intent);

  let score = 0;

  if (candidateNorm === intentNorm) {
    score += 7;
  }

  if (candidateNorm.startsWith(intentNorm) && intentNorm.length >= 3) {
    score += 2.4;
  }

  if (intentNorm.includes(candidateNorm) && candidateNorm.length > 3) {
    score += 1.2;
  }

  const intentTokens = tokenize(intentNorm);
  const candidateTokens = tokenize(candidateNorm);
  const candidateSet = new Set(candidateTokens);
  const intentSet = new Set(intentTokens);
  const intentCompact = alnumCompact(intentTokens.join(""));
  const candidateInitials = initials(candidateTokens);

  if (intentTokens.length === 1) {
    const token = alnumCompact(intentTokens[0] ?? "");
    if (token && candidateInitials === token) {
      score += 8.4;
    }
    if (
      token &&
      candidateTokens.some((candidateToken) =>
        alnumCompact(candidateToken).startsWith(token),
      )
    ) {
      score += 1.6;
    }
  } else if (intentCompact && candidateInitials && intentCompact === candidateInitials) {
    score += 4.8;
  }

  const shared = intentTokens.filter((token) => candidateSet.has(token));
  if (shared.length > 0) {
    score += shared.length * 1.35;
    score += shared.length / Math.max(1, intentTokens.length);
  }
  if (intentTokens.length > 0 && shared.length === intentTokens.length) {
    score += 2.2;
  }

  const extraTokens = candidateTokens.filter((token) => !intentSet.has(token)).length;
  if (extraTokens > 0) {
    score -= extraTokens * 0.55;
  }
  if (shared.length === 0) {
    score -= 2;
  }

  score += ontologyAdjustment(candidate.id);

  return score;
}

export function scoreDiseaseCandidateMatch(query: string, candidate: DiseaseCandidate): number {
  return scoreCandidate(extractDiseaseIntent(query), candidate);
}

type RankedCandidate = DiseaseCandidate & {
  score: number;
};

export function lexicalRankDiseaseCandidates(
  query: string,
  candidates: DiseaseCandidate[],
): RankedCandidate[] {
  const intent = extractDiseaseIntent(query);
  return candidates
    .map((candidate) => {
      return {
        ...candidate,
        score: scoreCandidate(intent, candidate),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export async function rankDiseaseCandidatesFast(
  query: string,
  candidates: DiseaseCandidate[],
  limit = 8,
): Promise<DiseaseCandidate[]> {
  const openai = getOpenAiClient();
  if (candidates.length === 0) return [];

  const lexical = lexicalRankDiseaseCandidates(query, candidates);
  const capped = lexical.slice(0, Math.max(1, limit));
  if (!openai || capped.length <= 2 || isOpenAiRateLimited()) {
    return capped.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
    }));
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      orderedIds: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["orderedIds"],
  } as const;

  const systemPrompt = [
    "You rank disease entity autocomplete suggestions for a biomedical user query.",
    "Prefer canonical disease entities over biomarker or measurement variants.",
    "Use only provided candidates and return orderedIds only.",
  ].join(" ");

  const userPrompt = JSON.stringify(
    {
      query,
      candidates: capped.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
    },
    null,
    2,
  );

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: chooseDiseaseAutocompleteRankingModel(),
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userPrompt }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "disease_autocomplete_ranking",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("autocomplete timeout")), 1_800),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as {
      orderedIds?: string[];
    };
    const rankedMap = new Map(capped.map((item) => [item.id, item]));
    const ordered = (parsed.orderedIds ?? [])
      .map((id) => rankedMap.get(id))
      .filter(Boolean) as RankedCandidate[];

    for (const candidate of capped) {
      if (!ordered.some((item) => item.id === candidate.id)) {
        ordered.push(candidate);
      }
    }

    return ordered
      .slice(0, Math.max(1, limit))
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
      }));
  } catch (error) {
    handleOpenAiRateLimit(error);
    return capped.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
    }));
  }
}

function lexicalFallback(query: string, candidates: DiseaseCandidate[]): {
  selected: DiseaseCandidate;
  score: number;
  rationale: string;
} {
  const intent = extractDiseaseIntent(query);
  const scored = candidates.map((item) => {
    return {
      item,
      score: scoreCandidate(intent, item),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) {
    return {
      selected: candidates[0]!,
      score: 0,
      rationale: "Selected first candidate by fallback.",
    };
  }

  return {
    selected: best.item,
    score: best.score,
    rationale: "Selected via lexical disease-intent matching.",
  };
}

export function chooseBestDiseaseCandidateLexical(
  query: string,
  candidates: DiseaseCandidate[],
): { selected: DiseaseCandidate; score: number; rationale: string } {
  return lexicalFallback(query, candidates);
}

export async function chooseBestDiseaseCandidate(
  query: string,
  candidates: DiseaseCandidate[],
): Promise<{ selected: DiseaseCandidate; rationale: string }> {
  const openai = getOpenAiClient();
  if (candidates.length === 0) {
    throw new Error("No disease candidates available");
  }

  const fallback = lexicalFallback(query, candidates);
  if (!openai || candidates.length === 1 || isOpenAiRateLimited()) {
    return {
      selected: fallback.selected,
      rationale: fallback.rationale,
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      selectedId: { type: "string" },
      rationale: { type: "string" },
    },
    required: ["selectedId", "rationale"],
  } as const;

  const systemPrompt = [
    "You are a biomedical disease entity resolver.",
    "Select the single best matching disease candidate for the user query.",
    "Use semantic intent, synonyms, and translational context.",
    "Ignore non-entity tokens and question scaffolding (e.g. what, is, best, target, for).",
    "Only map the disease concept implied by the query.",
    "If query uses abbreviations (e.g., COPD), map to canonical disease entities.",
    "Return only the schema fields.",
  ].join(" ");

  const userPrompt = JSON.stringify(
    {
      query,
      normalizedDiseaseIntent: extractDiseaseIntent(query),
      candidates,
    },
    null,
    2,
  );

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: appConfig.openai.smallModel,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userPrompt }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "disease_candidate_selection",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("disease selection timeout")), 3_200),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as {
      selectedId?: string;
      rationale?: string;
    };

    const selected =
      candidates.find((item) => item.id === parsed.selectedId) ?? fallback.selected;
    const selectedScore = scoreCandidate(extractDiseaseIntent(query), selected);

    if (fallback.score - selectedScore > 1.8) {
      return {
        selected: fallback.selected,
        rationale: `${fallback.rationale} Semantic resolver output was deprioritized by lexical score guardrail.`,
      };
    }

    return {
      selected,
      rationale:
        typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
          ? parsed.rationale.trim()
          : "Selected via semantic resolver.",
    };
  } catch (error) {
    handleOpenAiRateLimit(error);
    return {
      selected: fallback.selected,
      rationale: "Semantic resolver unavailable; used lexical disease-intent fallback.",
    };
  }
}

export async function expandDiseaseAliases(query: string): Promise<DiseaseAliasExpansion> {
  const openai = getOpenAiClient();
  const intent = extractDiseaseIntent(query).trim();
  if (!intent) {
    return {
      isDisease: false,
      aliases: [],
      rationale: "No disease-like phrase extracted from query.",
    };
  }

  if (!openai || isOpenAiRateLimited()) {
    return {
      isDisease: true,
      aliases: [intent],
      rationale: "Alias expansion fallback: OpenAI unavailable.",
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      isDisease: { type: "boolean" },
      aliases: {
        type: "array",
        items: { type: "string" },
      },
      rationale: { type: "string" },
    },
    required: ["isDisease", "aliases", "rationale"],
  } as const;

  try {
    const response = await Promise.race([
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
                  "Identify whether the query contains a disease concept.",
                  "If yes, return canonical disease aliases suitable for ontology resolver search.",
                  "If no disease concept is present, set isDisease=false and aliases=[].",
                  "Do not invent unrelated diseases.",
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
                    extractedDiseaseIntent: intent,
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
            name: "disease_alias_expansion",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("alias expansion timeout")), 3_000),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as {
      isDisease?: boolean;
      aliases?: string[];
      rationale?: string;
    };

    const aliases = [...new Set([intent, ...(parsed.aliases ?? [])])]
      .map((value) => normalizeText(value))
      .filter((value) => value.length >= 2)
      .slice(0, 6);

    return {
      isDisease: Boolean(parsed.isDisease),
      aliases,
      rationale:
        typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
          ? parsed.rationale.trim()
          : "Alias expansion complete.",
    };
  } catch (error) {
    handleOpenAiRateLimit(error);
    return {
      isDisease: true,
      aliases: [intent],
      rationale: "Alias expansion unavailable; used extracted disease intent.",
    };
  }
}
