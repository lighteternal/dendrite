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

export type DiseaseResolutionLoopResult = {
  primary: DiseaseCandidate;
  alternatives: DiseaseCandidate[];
  mustKeep: DiseaseCandidate[];
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

function dedupeDiseaseCandidates(candidates: DiseaseCandidate[]): DiseaseCandidate[] {
  const byId = new Map<string, DiseaseCandidate>();
  for (const candidate of candidates) {
    if (!candidate?.id) continue;
    if (!byId.has(candidate.id)) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()];
}

function buildResolutionLoopFallback(
  query: string,
  candidates: DiseaseCandidate[],
  planDiseaseAnchors: DiseaseCandidate[],
  maxOptions: number,
): DiseaseResolutionLoopResult {
  const ranked = lexicalRankDiseaseCandidates(query, candidates);
  const rankedCandidates: DiseaseCandidate[] = ranked.map((item) => ({
    id: item.id,
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
  }));
  const rankedById = new Map<string, DiseaseCandidate>(
    rankedCandidates.map((item) => [item.id, item]),
  );
  const scoreById = new Map(ranked.map((item) => [item.id, item.score]));
  const primary = rankedCandidates[0]!;
  const primaryScore = scoreById.get(primary.id) ?? 0;
  const minSupportScore = Math.max(0.9, primaryScore - 1.2);
  const keepIds = planDiseaseAnchors
    .map((anchor) => anchor.id)
    .filter((id) => rankedById.has(id))
    .filter((id) => (scoreById.get(id) ?? -Infinity) >= minSupportScore)
    .slice(0, 3);
  const alternativeIds = [
    ...keepIds.filter((id) => id !== primary.id),
    ...ranked
      .filter(
        (candidate) =>
          candidate.id !== primary.id && (scoreById.get(candidate.id) ?? -Infinity) >= minSupportScore,
      )
      .map((candidate) => candidate.id),
  ]
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, Math.max(0, maxOptions - 1));
  const alternatives = alternativeIds
    .map((id) => rankedById.get(id))
    .filter((item): item is DiseaseCandidate => Boolean(item));
  const mustKeep = keepIds
    .map((id) => rankedById.get(id))
    .filter((item): item is DiseaseCandidate => Boolean(item));

  return {
    primary,
    alternatives,
    mustKeep,
    rationale: "Selected via lexical disease-intent ranking fallback.",
  };
}

export async function resolveDiseaseAlternativesLoop(input: {
  query: string;
  candidates: DiseaseCandidate[];
  planDiseaseAnchors?: DiseaseCandidate[];
  relationMentions?: string[];
  maxOptions?: number;
}): Promise<DiseaseResolutionLoopResult> {
  const openai = getOpenAiClient();
  const allCandidates = dedupeDiseaseCandidates(input.candidates);
  const maxOptions = Math.max(2, Math.min(3, input.maxOptions ?? 3));
  if (allCandidates.length === 0) {
    throw new Error("No disease candidates available");
  }

  const planDiseaseAnchors = dedupeDiseaseCandidates(input.planDiseaseAnchors ?? []);
  const fallback = buildResolutionLoopFallback(
    input.query,
    allCandidates,
    planDiseaseAnchors,
    maxOptions,
  );

  if (!openai || allCandidates.length <= 1 || isOpenAiRateLimited()) {
    return fallback;
  }

  const ranked = lexicalRankDiseaseCandidates(input.query, allCandidates);
  const shortlist = ranked
    .slice(0, Math.max(6, maxOptions * 4))
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      lexicalScore: Number(item.score.toFixed(4)),
    }));
  const shortlistById = new Map<string, DiseaseCandidate>(
    shortlist.map((item) => [
      item.id,
      {
        id: item.id,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      },
    ]),
  );
  const lexicalScoreById = new Map(shortlist.map((item) => [item.id, item.lexicalScore]));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      primaryId: { type: "string" },
      alternativeIds: { type: "array", items: { type: "string" } },
      mustKeepIds: { type: "array", items: { type: "string" } },
      rationale: { type: "string" },
    },
    required: ["primaryId", "alternativeIds", "mustKeepIds", "rationale"],
  } as const;

  const systemPrompt = [
    "You verify biomedical disease entity resolution for a user query.",
    "Choose a primary disease and up to two alternatives from the provided candidates only.",
    "If the query has two disease anchors (relation/comparison), preserve both when present by returning them in mustKeepIds.",
    "Prefer semantically exact disease matches and reject unrelated look-alikes sharing generic words.",
    "Do not invent IDs and do not output entities not in candidate list.",
    "Return strict JSON schema only.",
  ].join(" ");

  const userPrompt = JSON.stringify(
    {
      query: input.query,
      normalizedDiseaseIntent: extractDiseaseIntent(input.query),
      relationMentions: (input.relationMentions ?? []).slice(0, 8),
      planDiseaseAnchors: planDiseaseAnchors.map((anchor) => ({
        id: anchor.id,
        name: anchor.name,
      })),
      candidates: shortlist,
      maxOptions,
    },
    null,
    2,
  );

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: appConfig.openai.smallModel,
        reasoning: { effort: "minimal" },
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
            name: "disease_resolution_loop",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("disease resolution loop timeout")), 3_400),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as {
      primaryId?: string;
      alternativeIds?: string[];
      mustKeepIds?: string[];
      rationale?: string;
    };

    const primary =
      (typeof parsed.primaryId === "string" ? shortlistById.get(parsed.primaryId) : null) ??
      fallback.primary;
    const primaryScore = lexicalScoreById.get(primary.id) ?? lexicalScoreById.get(fallback.primary.id) ?? 0;
    const minSupportScore = Math.max(0.9, primaryScore - 1.15);
    const mustKeepIds = [
      ...((Array.isArray(parsed.mustKeepIds) ? parsed.mustKeepIds : []).filter(
        (id) =>
          shortlistById.has(id) && (lexicalScoreById.get(id) ?? -Infinity) >= minSupportScore,
      )),
    ]
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, 3);
    const alternativeIds = [
      ...(Array.isArray(parsed.alternativeIds) ? parsed.alternativeIds : []),
      ...mustKeepIds,
      ...shortlist.map((item) => item.id),
    ]
      .filter(
        (id) =>
          id !== primary.id &&
          shortlistById.has(id) &&
          (lexicalScoreById.get(id) ?? -Infinity) >= minSupportScore,
      )
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, Math.max(0, maxOptions - 1));

    const lexicalTopId = shortlist[0]?.id ?? fallback.primary.id;
    const lexicalTopScore = lexicalScoreById.get(lexicalTopId) ?? -Infinity;
    const selectedScore = lexicalScoreById.get(primary.id) ?? -Infinity;
    const preservePrimary = mustKeepIds.includes(primary.id);
    const guardedPrimary =
      !preservePrimary && lexicalTopScore - selectedScore > 1.25
        ? fallback.primary
        : primary;

    return {
      primary: guardedPrimary,
      alternatives: alternativeIds
        .map((id) => shortlistById.get(id))
        .filter((item): item is DiseaseCandidate => Boolean(item)),
      mustKeep: mustKeepIds
        .map((id) => shortlistById.get(id))
        .filter((item): item is DiseaseCandidate => Boolean(item)),
      rationale:
        typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
          ? parsed.rationale.trim()
          : "Selected via disease resolution verification loop.",
    };
  } catch (error) {
    handleOpenAiRateLimit(error);
    return fallback;
  }
}

export async function suggestDiseaseResolverMentions(input: {
  query: string;
  currentMentions?: string[];
  maxMentions?: number;
}): Promise<string[]> {
  const openai = getOpenAiClient();
  const maxMentions = Math.max(1, Math.min(3, input.maxMentions ?? 3));
  const fallback = [...new Set((input.currentMentions ?? []).map((value) => normalizeText(value)).filter(Boolean))]
    .slice(0, maxMentions);

  if (!openai || isOpenAiRateLimited()) {
    return fallback;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      mentions: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["mentions"],
  } as const;

  const systemPrompt = [
    "Extract up to three disease/entity phrases from the user query that should be used for ontology disease search.",
    "Prefer explicit disease mentions and disease outcomes; keep wording concise.",
    "Do not invent entities and avoid generic scaffolding words.",
    "Return only phrases useful for disease candidate lookup.",
  ].join(" ");

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: appConfig.openai.smallModel,
        reasoning: { effort: "minimal" },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(
                  {
                    query: input.query,
                    currentMentions: input.currentMentions ?? [],
                    maxMentions,
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
            name: "disease_resolver_mentions",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("disease mention extraction timeout")), 2_800),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as {
      mentions?: string[];
    };

    const mentions = [...new Set((parsed.mentions ?? [])
      .map((value) => normalizeText(String(value ?? "")))
      .filter((value) => value.length >= 3))]
      .slice(0, maxMentions);

    if (mentions.length === 0) return fallback;
    return mentions;
  } catch (error) {
    handleOpenAiRateLimit(error);
    return fallback;
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
