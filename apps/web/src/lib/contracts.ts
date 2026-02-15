import { z } from "zod";

export const graphNodeTypes = [
  "disease",
  "target",
  "pathway",
  "drug",
  "interaction",
] as const;

export const graphEdgeTypes = [
  "disease_target",
  "disease_disease",
  "target_pathway",
  "target_drug",
  "target_target",
  "pathway_drug",
] as const;

export const sourceNames = [
  "opentargets",
  "reactome",
  "string",
  "chembl",
  "biomcp",
  "pubmed",
  "openai",
] as const;

export type SourceName = (typeof sourceNames)[number];

export const sourceHealthSchema = z.enum(["green", "yellow", "red"]);

export const graphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(graphNodeTypes),
  primaryId: z.string(),
  label: z.string(),
  score: z.number().optional(),
  size: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});

export const graphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.enum(graphEdgeTypes),
  weight: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});

export const streamStatusSchema = z.object({
  phase: z.string(),
  message: z.string(),
  pct: z.number().min(0).max(100),
  elapsedMs: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number()).default({}),
  sourceHealth: z.record(z.enum(sourceNames), sourceHealthSchema),
  partial: z.boolean().default(false),
  timeoutMs: z.number().int().positive().optional(),
});

export const streamPartialGraphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  stats: z.record(z.string(), z.number()).default({}),
});

export const sankeyRowSchema = z.object({
  source: z.string(),
  target: z.string(),
  value: z.number().nonnegative(),
  sourceType: z.string(),
  targetType: z.string(),
});

export const rankingTargetSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  rank: z.number().int().positive(),
  score: z.number(),
  reasons: z.array(z.string()),
  caveats: z.array(z.string()),
  pathwayHooks: z.array(z.string()),
  drugHooks: z.array(z.string()),
  interactionHooks: z.array(z.string()),
  evidenceRefs: z.array(
    z.object({
      field: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
  ),
});

export const rankingResponseSchema = z.object({
  rankedTargets: z.array(rankingTargetSchema),
  systemSummary: z.object({
    keyPathways: z.array(z.string()),
    actionableTargets: z.array(z.string()),
    dataGaps: z.array(z.string()),
  }),
});

export const mechanismThreadSchema = z.object({
  claim: z.string(),
  evidenceBullets: z.array(z.string()),
  counterfactuals: z.array(z.string()),
  caveats: z.array(z.string()),
  nextExperiments: z.array(z.string()),
});

export const hypothesisRequestSchema = z.object({
  diseaseId: z.string(),
  pathwayId: z.string(),
  outputCount: z.union([z.literal(1), z.literal(3)]),
  sliderWeights: z.object({
    noveltyToActionability: z.number().min(0).max(100),
    riskTolerance: z.number().min(0).max(100),
  }),
  graphEvidenceTable: z.array(
    z.object({
      targetId: z.string(),
      symbol: z.string(),
      pathwayIds: z.array(z.string()),
      openTargetsEvidence: z.number(),
      drugActionability: z.number(),
      networkCentrality: z.number(),
      literatureSupport: z.number(),
      drugCount: z.number(),
      interactionCount: z.number(),
      articleCount: z.number(),
      trialCount: z.number(),
    }),
  ),
});

export const hypothesisResponseSchema = z.object({
  recommendedTargets: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      score: z.number(),
      scoreBreakdown: z.object({
        openTargetsEvidence: z.number(),
        drugActionability: z.number(),
        networkCentrality: z.number(),
        literatureSupport: z.number(),
      }),
      pathwayId: z.string(),
    }),
  ),
  mechanismThread: mechanismThreadSchema,
  missingInputs: z.array(z.string()),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type RankingResponse = z.infer<typeof rankingResponseSchema>;
export type HypothesisRequest = z.infer<typeof hypothesisRequestSchema>;
export type HypothesisResponse = z.infer<typeof hypothesisResponseSchema>;
export type SankeyRow = z.infer<typeof sankeyRowSchema>;

export type StreamEventPayload =
  | { event: "status"; data: z.infer<typeof streamStatusSchema> }
  | { event: "partial_graph"; data: z.infer<typeof streamPartialGraphSchema> }
  | { event: "sankey"; data: { rows: SankeyRow[] } }
  | { event: "ranking"; data: RankingResponse }
  | { event: "done"; data: { stats: Record<string, number> } }
  | {
      event: "error";
      data: { phase: string; message: string; recoverable: boolean };
    }
  | {
      event: "enrichment_ready";
      data: {
        linksByNodeId: Record<string, { articles: unknown[]; trials: unknown[] }>;
      };
    };
