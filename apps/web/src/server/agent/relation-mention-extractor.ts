import { appConfig } from "@/server/config";
import { createTrackedOpenAIClient } from "@/server/openai/client";
import { withOpenAiOperationContext } from "@/server/openai/cost-tracker";
import {
  handleOpenAiRateLimit,
  isOpenAiRateLimited,
} from "@/server/openai/rate-limit";

export type EvidenceEntityMention = {
  label: string;
  category: "exposure" | "mechanism" | "outcome";
  confidence: number;
};

function getOpenAiClient() {
  return createTrackedOpenAIClient();
}

function cleanMention(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[`"'\s]+|[`"'\s]+$/g, "")
    .trim();
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

export async function extractRelationMentionsFast(
  query: string,
  options?: {
    maxMentions?: number;
    timeoutMs?: number;
  },
): Promise<string[]> {
  const openai = getOpenAiClient();
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  if (!openai || isOpenAiRateLimited()) return [];

  const maxMentions = Math.max(1, Math.min(10, options?.maxMentions ?? 6));
  const timeoutMs = Math.max(700, Math.min(6_000, options?.timeoutMs ?? 1_800));
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

  try {
    const response = await withOpenAiOperationContext(
      "relation_extract.fast_nano",
      () =>
        withTimeout(
          openai.responses.create({
            model: appConfig.openai.nanoModel,
            reasoning: { effort: "minimal" },
            max_output_tokens: 180,
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: [
                      "Extract relation anchors from the biomedical question.",
                      "Return only concrete entity mentions suitable for resolver lookup.",
                      "Keep disease/protein/drug/biological-entity anchors; avoid generic phrase-only mentions.",
                      "Do not add entities not present in the query text.",
                      `Return up to ${maxMentions} mentions.`,
                    ].join(" "),
                  },
                ],
              },
              {
                role: "user",
                content: [{ type: "input_text", text: normalizedQuery }],
              },
            ],
            text: {
              format: {
                type: "json_schema",
                name: "relation_mentions_fast",
                schema,
                strict: true,
              },
            },
          }),
          timeoutMs,
        ),
    );

    const parsed = JSON.parse(response.output_text) as {
      mentions?: string[];
    };

    const seen = new Set<string>();
    const mentions: string[] = [];
    for (const item of parsed.mentions ?? []) {
      const mention = cleanMention(String(item ?? ""));
      if (!mention) continue;
      if (mention.length < 2 || mention.length > 90) continue;
      if (mention.split(/\s+/).filter(Boolean).length > 6) continue;
      const key = mention.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push(mention);
      if (mentions.length >= maxMentions) break;
    }
    return mentions;
  } catch (error) {
    handleOpenAiRateLimit(error);
    return [];
  }
}

export async function extractEvidenceEntitiesFast(input: {
  query?: string;
  snippets: string[];
  maxEntities?: number;
  timeoutMs?: number;
}): Promise<EvidenceEntityMention[]> {
  const openai = getOpenAiClient();
  if (!openai || isOpenAiRateLimited()) return [];

  const snippets = input.snippets
    .map((value) => cleanMention(value))
    .filter((value) => value.length >= 6)
    .slice(0, 24);
  if (snippets.length === 0) return [];

  const query = cleanMention(input.query ?? "");
  const maxEntities = Math.max(2, Math.min(18, input.maxEntities ?? 8));
  const timeoutMs = Math.max(1_200, Math.min(12_000, input.timeoutMs ?? 3_200));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            category: {
              type: "string",
              enum: ["exposure", "mechanism", "outcome"],
            },
            confidence: { type: "number" },
          },
          required: ["label", "category", "confidence"],
        },
      },
    },
    required: ["entities"],
  } as const;

  try {
    const response = await withOpenAiOperationContext(
      "relation_extract.evidence_entities",
      () =>
        withTimeout(
          openai.responses.create({
            model: appConfig.openai.nanoModel,
            reasoning: { effort: "minimal" },
            max_output_tokens: 300,
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: [
                      "Extract concrete biomedical entities from evidence snippets for graph construction.",
                      "Prioritize named exposures/interventions (e.g., caffeine, asbestos, alcohol), named molecular mechanisms (genes/proteins/pathways), and explicit outcomes.",
                      "Use only entities explicitly present in the snippets (or the user query context if provided).",
                      "Do not invent entities and avoid generic words.",
                      `Return up to ${maxEntities} entities.`,
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
                        query: query || null,
                        snippets,
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
                name: "evidence_entities_fast",
                schema,
                strict: true,
              },
            },
          }),
          timeoutMs,
        ),
    );

    const parsed = JSON.parse(response.output_text) as {
      entities?: Array<{
        label?: string;
        category?: EvidenceEntityMention["category"];
        confidence?: number;
      }>;
    };

    const seen = new Set<string>();
    const entities: EvidenceEntityMention[] = [];
    for (const item of parsed.entities ?? []) {
      const label = cleanMention(String(item.label ?? ""));
      if (!label || label.length < 2 || label.length > 96) continue;
      if (label.split(/\s+/).filter(Boolean).length > 8) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        label,
        category:
          item.category === "exposure" || item.category === "outcome"
            ? item.category
            : "mechanism",
        confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.6))),
      });
      if (entities.length >= maxEntities) break;
    }
    return entities;
  } catch (error) {
    handleOpenAiRateLimit(error);
    return [];
  }
}
