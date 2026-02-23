import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

const envCandidates = [
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", "..", ".env"),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    loadDotenv({ path: envPath, override: false, quiet: true });
  }
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
};

const parseMcpTransportMode = (
  value: string | undefined,
): "auto" | "prefer_mcp" | "fallback_only" => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "prefer_mcp" || normalized === "prefer-mcp") {
    return "prefer_mcp";
  }
  if (normalized === "fallback_only" || normalized === "fallback-only") {
    return "fallback_only";
  }
  return "auto";
};

type ModelPricing = {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cachedInputPer1MUsd?: number;
};

function parseModelPricingMap(
  value: string | undefined,
): Record<string, ModelPricing> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ModelPricing> = {};
    for (const [model, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const inputPer1MUsd = Number(row.inputPer1MUsd);
      const outputPer1MUsd = Number(row.outputPer1MUsd);
      if (!Number.isFinite(inputPer1MUsd) || !Number.isFinite(outputPer1MUsd)) continue;
      const cachedInputPer1MUsdRaw = row.cachedInputPer1MUsd;
      const cachedInputPer1MUsd = Number(cachedInputPer1MUsdRaw);
      out[model] = {
        inputPer1MUsd,
        outputPer1MUsd,
        cachedInputPer1MUsd:
          Number.isFinite(cachedInputPer1MUsd) ? cachedInputPer1MUsd : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function parsePromptCacheRetention(
  value: string | undefined,
): "in-memory" | "24h" | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "off") return null;
  if (normalized === "in_memory" || normalized === "in-memory") return "in-memory";
  if (normalized === "24h") return "24h";
  return null;
}

const defaultModelPricing: Record<string, ModelPricing> = {
  "gpt-5.2": {
    inputPer1MUsd: 1.25,
    cachedInputPer1MUsd: 0.125,
    outputPer1MUsd: 10,
  },
  "gpt-5-mini": {
    inputPer1MUsd: 0.25,
    cachedInputPer1MUsd: 0.025,
    outputPer1MUsd: 2,
  },
  "gpt-5-nano": {
    inputPer1MUsd: 0.05,
    cachedInputPer1MUsd: 0.005,
    outputPer1MUsd: 0.4,
  },
};

export const appConfig = {
  openAiApiKey: process.env.OPENAI_API_KEY,
  mcpTransportMode: parseMcpTransportMode(
    process.env.MCP_TRANSPORT_MODE ??
      (process.env.VERCEL ? "fallback_only" : "auto"),
  ),
  mcp: {
    opentargets: process.env.OPENTARGETS_MCP_URL ?? "http://localhost:7010/mcp",
    reactome: process.env.REACTOME_MCP_URL ?? "http://localhost:7020/mcp",
    string: process.env.STRING_MCP_URL ?? "http://localhost:7030/mcp",
    chembl: process.env.CHEMBL_MCP_URL ?? "http://localhost:7040/mcp",
    biomcp: process.env.BIOMCP_URL ?? "http://localhost:8000/mcp",
    medical: process.env.MEDICAL_MCP_URL ?? "http://localhost:7060/mcp",
    pubmed:
      process.env.PUBMED_MCP_URL ??
      process.env.BIOMCP_URL ??
      "http://localhost:7050/mcp",
  },
  stream: {
    phaseTimeoutMs: parseNumber(process.env.PHASE_TIMEOUT_MS, 600_000),
    batchMinDelayMs: parseNumber(process.env.STREAM_BATCH_MIN_DELAY_MS, 120),
    batchMaxDelayMs: parseNumber(process.env.STREAM_BATCH_MAX_DELAY_MS, 320),
    rankingTimeoutMs: parseNumber(process.env.STREAM_RANKING_TIMEOUT_MS, 180_000),
    p5BudgetMs: parseNumber(process.env.STREAM_P5_BUDGET_MS, 480_000),
    p5PerTargetTimeoutMs: parseNumber(process.env.STREAM_P5_PER_TARGET_TIMEOUT_MS, 45_000),
    maxLiteratureTargets: parseNumber(process.env.STREAM_MAX_LITERATURE_TARGETS, 5),
  },
  run: {
    hardBudgetMs: parseNumber(process.env.RUN_HARD_BUDGET_MS, 20 * 60 * 1000),
    finalizationReserveMs: parseNumber(
      process.env.RUN_FINALIZATION_RESERVE_MS,
      90_000,
    ),
    fallbackSynthesisTimeoutMs: parseNumber(
      process.env.RUN_FALLBACK_SYNTHESIS_TIMEOUT_MS,
      120_000,
    ),
    finalGroundingTimeoutMs: parseNumber(
      process.env.RUN_FINAL_GROUNDING_TIMEOUT_MS,
      120_000,
    ),
    discovererFinalWaitMs: parseNumber(
      process.env.RUN_DISCOVERER_FINAL_WAIT_MS,
      600_000,
    ),
    scientificAnswerWordBudget: parseNumber(
      process.env.RUN_SCIENTIFIC_ANSWER_WORD_BUDGET,
      1200,
    ),
  },
  deepDiscover: {
    agentTimeoutMs: parseNumber(process.env.DEEP_DISCOVER_AGENT_TIMEOUT_MS, 600_000),
    toolTimeoutMs: parseNumber(process.env.DEEP_DISCOVER_TOOL_TIMEOUT_MS, 120_000),
    maxRunMs: parseNumber(process.env.DEEP_DISCOVER_MAX_RUN_MS, 20 * 60 * 1000),
    maxPubmedSubqueries: Math.max(
      1,
      Math.floor(parseNumber(process.env.DEEP_DISCOVER_MAX_PUBMED_SUBQUERIES, 20)),
    ),
  },
  string: {
    confidenceDefault: parseNumber(process.env.STRING_CONFIDENCE_DEFAULT, 0.7),
    maxAddedNodes: parseNumber(process.env.STRING_MAX_ADDED_NODES, 180),
    maxAddedEdges: parseNumber(process.env.STRING_MAX_ADDED_EDGES, 500),
    maxNeighborsPerSeed: parseNumber(
      process.env.STRING_MAX_NEIGHBORS_PER_SEED,
      15,
    ),
  },
  cache: {
    ttlMs: parseNumber(process.env.CACHE_TTL_MS, 5 * 60 * 1000),
    maxEntries: parseNumber(process.env.CACHE_MAX_ENTRIES, 500),
  },
  openai: {
    model: process.env.OPENAI_MODEL ?? "gpt-5.2",
    smallModel: process.env.OPENAI_SMALL_MODEL ?? "gpt-5-mini",
    nanoModel: process.env.OPENAI_NANO_MODEL ?? "gpt-5-nano",
    hypothesisTimeoutMs: parseNumber(process.env.OPENAI_HYPOTHESIS_TIMEOUT_MS, 10_000),
    promptCachingEnabled: parseBoolean(
      process.env.OPENAI_PROMPT_CACHE_ENABLED,
      true,
    ),
    promptCacheRetention: parsePromptCacheRetention(
      process.env.OPENAI_PROMPT_CACHE_RETENTION,
    ),
    promptCacheKeyPrefix:
      process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX ?? "dendrite-v1",
    pricingByModel: {
      ...defaultModelPricing,
      ...parseModelPricingMap(process.env.OPENAI_MODEL_PRICING_JSON),
    },
  },
};

export function assertRuntimeConfig(): void {
  if (!appConfig.openAiApiKey) {
    console.warn("OPENAI_API_KEY missing: OpenAI ranking will use fallback mode.");
  }
}
