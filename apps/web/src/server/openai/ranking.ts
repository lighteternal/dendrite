import OpenAI from "openai";
import {
  hypothesisResponseSchema,
  mechanismThreadSchema,
  rankingResponseSchema,
  type HypothesisResponse,
  type RankingResponse,
} from "@/lib/contracts";
import { clamp } from "@/lib/graph";
import { appConfig } from "@/server/config";

type RankingInputRow = {
  id: string;
  symbol: string;
  openTargetsEvidence: number;
  drugActionability: number;
  networkCentrality: number;
  literatureSupport: number;
  drugCount: number;
  interactionCount: number;
  articleCount: number;
  trialCount: number;
  pathwayIds: string[];
};

type HypothesisInput = {
  diseaseId: string;
  pathwayId: string;
  outputCount: 1 | 3;
  missingInputs: string[];
  scoredTargets: Array<{
    id: string;
    symbol: string;
    score: number;
    scoreBreakdown: {
      openTargetsEvidence: number;
      drugActionability: number;
      networkCentrality: number;
      literatureSupport: number;
    };
  }>;
};

const openai = appConfig.openAiApiKey
  ? new OpenAI({ apiKey: appConfig.openAiApiKey })
  : null;

async function callStructuredJson<T>(options: {
  schemaName: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  reasoningEffort?: "medium" | "high";
}): Promise<T> {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  try {
    const response = await openai.responses.create({
      model: appConfig.openai.model,
      reasoning: options.reasoningEffort
        ? {
            effort: options.reasoningEffort,
          }
        : undefined,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: options.systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: options.userPrompt }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: options.schemaName,
          schema: options.schema,
          strict: true,
        },
      },
    });

    return JSON.parse(response.output_text) as T;
  } catch {
    const response = await openai.chat.completions.create({
      model: appConfig.openai.model,
      messages: [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: options.schemaName,
          strict: true,
          schema: options.schema,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned empty content");
    }

    return JSON.parse(content) as T;
  }
}

export function rankTargetsFallback(rows: RankingInputRow[]): RankingResponse {
  const scored = rows
    .map((row) => {
      const score =
        0.4 * clamp(row.openTargetsEvidence) +
        0.25 * clamp(row.drugActionability) +
        0.2 * clamp(row.networkCentrality) +
        0.15 * clamp(row.literatureSupport);

      return {
        ...row,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  return {
    rankedTargets: scored.map((target, idx) => ({
      id: target.id,
      symbol: target.symbol,
      rank: idx + 1,
      score: Number(target.score.toFixed(4)),
      reasons: [
        `OpenTargets evidence ${target.openTargetsEvidence.toFixed(2)}`,
        `Drug actionability ${target.drugActionability.toFixed(2)} with ${target.drugCount} linked drugs`,
      ],
      caveats: [
        target.articleCount === 0
          ? "No literature snippets provided"
          : `${target.articleCount} article snippets provided`,
      ],
      pathwayHooks: target.pathwayIds.slice(0, 3),
      drugHooks: [`${target.drugCount} compounds`],
      interactionHooks: [`${target.interactionCount} interaction edges`],
      evidenceRefs: [
        { field: "openTargetsEvidence", value: target.openTargetsEvidence },
        { field: "drugActionability", value: target.drugActionability },
        { field: "networkCentrality", value: target.networkCentrality },
        { field: "literatureSupport", value: target.literatureSupport },
      ],
    })),
    systemSummary: {
      keyPathways: [...new Set(scored.flatMap((item) => item.pathwayIds))].slice(0, 8),
      actionableTargets: scored.slice(0, 5).map((item) => item.symbol),
      dataGaps: [
        "Evidence derived from currently available MCP/API responses only",
        "No claim of efficacy or clinical recommendation",
      ],
    },
  };
}

export async function rankTargets(rows: RankingInputRow[]): Promise<RankingResponse> {
  const fallback = rankTargetsFallback(rows);
  if (!openai) return fallback;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      rankedTargets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            symbol: { type: "string" },
            rank: { type: "integer" },
            score: { type: "number" },
            reasons: { type: "array", items: { type: "string" } },
            caveats: { type: "array", items: { type: "string" } },
            pathwayHooks: { type: "array", items: { type: "string" } },
            drugHooks: { type: "array", items: { type: "string" } },
            interactionHooks: { type: "array", items: { type: "string" } },
            evidenceRefs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  field: { type: "string" },
                  value: {
                    anyOf: [
                      { type: "string" },
                      { type: "number" },
                      { type: "boolean" },
                    ],
                  },
                },
                required: ["field", "value"],
              },
            },
          },
          required: [
            "id",
            "symbol",
            "rank",
            "score",
            "reasons",
            "caveats",
            "pathwayHooks",
            "drugHooks",
            "interactionHooks",
            "evidenceRefs",
          ],
        },
      },
      systemSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          keyPathways: { type: "array", items: { type: "string" } },
          actionableTargets: { type: "array", items: { type: "string" } },
          dataGaps: { type: "array", items: { type: "string" } },
        },
        required: ["keyPathways", "actionableTargets", "dataGaps"],
      },
    },
    required: ["rankedTargets", "systemSummary"],
  };

  const systemPrompt = [
    "You rank disease targets from an evidence table.",
    "Use ONLY the provided fields and node IDs.",
    "If information is missing, explicitly state 'not provided'.",
    "Never claim efficacy or provide clinical recommendation.",
    "Output must satisfy the supplied JSON schema.",
  ].join(" ");

  const userPrompt = `Evidence table:\n${JSON.stringify(rows, null, 2)}`;

  try {
    const json = await callStructuredJson<RankingResponse>({
      schemaName: "targetgraph_ranking",
      schema,
      systemPrompt,
      userPrompt,
    });

    return rankingResponseSchema.parse(json);
  } catch {
    return fallback;
  }
}

export function mechanismThreadFallback(input: HypothesisInput): HypothesisResponse {
  return {
    recommendedTargets: input.scoredTargets.slice(0, input.outputCount).map((target) => ({
      id: target.id,
      symbol: target.symbol,
      score: Number(target.score.toFixed(4)),
      scoreBreakdown: target.scoreBreakdown,
      pathwayId: input.pathwayId,
    })),
    mechanismThread: {
      claim:
        input.scoredTargets.length > 0
          ? `Within pathway ${input.pathwayId}, ${input.scoredTargets[0].symbol} is the strongest mechanistic lever in this evidence table.`
          : `Insufficient evidence rows to generate a pathway-specific claim for ${input.pathwayId}.`,
      evidenceBullets: input.scoredTargets.slice(0, 3).map(
        (target) =>
          `${target.symbol}: OT=${target.scoreBreakdown.openTargetsEvidence.toFixed(2)}, Drug=${target.scoreBreakdown.drugActionability.toFixed(2)}, Centrality=${target.scoreBreakdown.networkCentrality.toFixed(2)}, Literature=${target.scoreBreakdown.literatureSupport.toFixed(2)}`,
      ),
      counterfactuals: ["Alternative same-pathway targets may change if missing inputs are added."],
      caveats: input.missingInputs.length
        ? input.missingInputs
        : ["No explicit missing input flags were provided."],
      nextExperiments: [
        "Confirm target perturbation effect in pathway-relevant cellular model.",
        "Compare prioritized targets with matched perturbation controls.",
      ],
    },
    missingInputs: input.missingInputs,
  };
}

export async function generateMechanismThread(
  input: HypothesisInput,
): Promise<HypothesisResponse> {
  const fallback = mechanismThreadFallback(input);

  if (!openai) return fallback;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      recommendedTargets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            symbol: { type: "string" },
            score: { type: "number" },
            scoreBreakdown: {
              type: "object",
              additionalProperties: false,
              properties: {
                openTargetsEvidence: { type: "number" },
                drugActionability: { type: "number" },
                networkCentrality: { type: "number" },
                literatureSupport: { type: "number" },
              },
              required: [
                "openTargetsEvidence",
                "drugActionability",
                "networkCentrality",
                "literatureSupport",
              ],
            },
            pathwayId: { type: "string" },
          },
          required: ["id", "symbol", "score", "scoreBreakdown", "pathwayId"],
        },
      },
      mechanismThread: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          evidenceBullets: { type: "array", items: { type: "string" } },
          counterfactuals: { type: "array", items: { type: "string" } },
          caveats: { type: "array", items: { type: "string" } },
          nextExperiments: { type: "array", items: { type: "string" } },
        },
        required: [
          "claim",
          "evidenceBullets",
          "counterfactuals",
          "caveats",
          "nextExperiments",
        ],
      },
      missingInputs: { type: "array", items: { type: "string" } },
    },
    required: ["recommendedTargets", "mechanismThread", "missingInputs"],
  };

  const systemPrompt = [
    "Generate a mechanism thread from provided hypothesis evidence.",
    "Use only supplied values and IDs.",
    "If a detail is not provided, write 'not provided'.",
    "No efficacy claims and no clinical recommendations.",
    "Output strict JSON schema.",
  ].join(" ");

  const userPrompt = JSON.stringify(input, null, 2);

  try {
    const json = await callStructuredJson<HypothesisResponse>({
      schemaName: "targetgraph_hypothesis",
      schema,
      systemPrompt,
      userPrompt,
      reasoningEffort: "medium",
    });

    const parsed = hypothesisResponseSchema.parse(json);
    mechanismThreadSchema.parse(parsed.mechanismThread);
    return parsed;
  } catch {
    return fallback;
  }
}
