import OpenAI from "openai";
import { appConfig } from "@/server/config";

export type DiseaseCandidate = {
  id: string;
  name: string;
  description?: string;
};

const openai = appConfig.openAiApiKey
  ? new OpenAI({ apiKey: appConfig.openAiApiKey })
  : null;

const penalizedQualifierTerms = [
  "biomarker",
  "measurement",
  "susceptibility",
  "risk",
  "severity",
  "progression",
  "response",
  "remission",
  "stage",
  "screening",
  "finding",
  "neuropathologic",
  "change",
  "trait",
];

const diseaseAffirmationTerms = [
  "disease",
  "cancer",
  "carcinoma",
  "arthritis",
  "leukemia",
  "lymphoma",
  "melanoma",
  "syndrome",
  "colitis",
  "asthma",
];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDiseaseIntent(query: string): string {
  let value = normalizeText(query);
  value = value.replace(/^(for|in|about|regarding)\s+/, "");

  const splitters = [
    ",",
    "?",
    " what ",
    " which ",
    " where ",
    " when ",
    " how ",
    " should ",
    " would ",
    " with ",
    " showing ",
    " to identify ",
    " to evaluate ",
  ];

  for (const splitter of splitters) {
    const idx = value.indexOf(splitter);
    if (idx > 0) {
      value = value.slice(0, idx).trim();
    }
  }

  return value.trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token.length > 1)
    .map((token) => {
      let normalizedToken = token;
      if (normalizedToken.endsWith("s") && normalizedToken.length > 4) {
        normalizedToken = normalizedToken.slice(0, -1);
      }
      if (normalizedToken === "carcinoma") normalizedToken = "cancer";
      if (normalizedToken === "tumour") normalizedToken = "tumor";
      return normalizedToken;
    });
}

function scoreCandidate(intent: string, candidate: DiseaseCandidate): {
  score: number;
  penalized: boolean;
} {
  const candidateNorm = normalizeText(candidate.name);
  const intentNorm = normalizeText(intent);

  let score = 0;

  if (candidateNorm === intentNorm) {
    score += 7;
  }

  if (candidateNorm.startsWith(intentNorm) && intentNorm.length > 3) {
    score += 2.4;
  }

  if (intentNorm.includes(candidateNorm) && candidateNorm.length > 3) {
    score += 1.2;
  }

  const intentTokens = tokenize(intentNorm);
  const candidateTokens = tokenize(candidateNorm);
  const candidateSet = new Set(candidateTokens);
  const intentSet = new Set(intentTokens);
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

  const hasDiseaseAffirmation = diseaseAffirmationTerms.some((term) =>
    candidateNorm.includes(term),
  );
  if (hasDiseaseAffirmation) {
    score += 0.5;
  }

  const penalized = penalizedQualifierTerms.some((term) =>
    candidateNorm.includes(term),
  );
  if (penalized) {
    score -= 2.8;
  }

  return { score, penalized };
}

function lexicalFallback(query: string, candidates: DiseaseCandidate[]): {
  selected: DiseaseCandidate;
  score: number;
  penalized: boolean;
  rationale: string;
} {
  const intent = extractDiseaseIntent(query);
  const scored = candidates.map((item) => {
    const { score, penalized } = scoreCandidate(intent, item);
    return {
      item,
      score,
      penalized,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) {
    return {
      selected: candidates[0]!,
      score: 0,
      penalized: false,
      rationale: "Selected first candidate by fallback.",
    };
  }

  return {
    selected: best.item,
    score: best.score,
    penalized: best.penalized,
    rationale: best.penalized
      ? "Selected via lexical fallback with qualifier penalty guardrails."
      : "Selected via lexical disease-intent matching.",
  };
}

export async function chooseBestDiseaseCandidate(
  query: string,
  candidates: DiseaseCandidate[],
): Promise<{ selected: DiseaseCandidate; rationale: string }> {
  if (candidates.length === 0) {
    throw new Error("No disease candidates available");
  }

  const fallback = lexicalFallback(query, candidates);
  if (!openai || candidates.length === 1) {
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
    "Return only the schema fields.",
  ].join(" ");

  const userPrompt = JSON.stringify(
    {
      query,
      candidates,
    },
    null,
    2,
  );

  try {
    const response = await openai.responses.create({
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
    });

    const parsed = JSON.parse(response.output_text) as {
      selectedId?: string;
      rationale?: string;
    };

    const selected =
      candidates.find((item) => item.id === parsed.selectedId) ?? fallback.selected;
    const selectedScore = scoreCandidate(extractDiseaseIntent(query), selected);

    // Guardrail: if semantic output is qualifier-like and heuristic has a stronger disease-intent match,
    // prefer heuristic to avoid "biomarker measurement"-style picks.
    if (
      (selectedScore.penalized && !fallback.penalized) ||
      fallback.score - selectedScore.score > 1.8
    ) {
      return {
        selected: fallback.selected,
        rationale: `${fallback.rationale} Semantic resolver output was deprioritized by guardrails.`,
      };
    }

    return {
      selected,
      rationale:
        typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
          ? parsed.rationale.trim()
          : "Selected via semantic resolver.",
    };
  } catch {
    return {
      selected: fallback.selected,
      rationale: "Semantic resolver unavailable; used lexical disease-intent fallback.",
    };
  }
}
