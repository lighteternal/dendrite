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

export const appConfig = {
  openAiApiKey: process.env.OPENAI_API_KEY,
  mcp: {
    opentargets: process.env.OPENTARGETS_MCP_URL ?? "http://localhost:7010/mcp",
    reactome: process.env.REACTOME_MCP_URL ?? "http://localhost:7020/mcp",
    string: process.env.STRING_MCP_URL ?? "http://localhost:7030/mcp",
    chembl: process.env.CHEMBL_MCP_URL ?? "http://localhost:7040/mcp",
    biomcp: process.env.BIOMCP_URL ?? "http://localhost:8000/mcp",
  },
  stream: {
    phaseTimeoutMs: parseNumber(process.env.PHASE_TIMEOUT_MS, 12_000),
    batchMinDelayMs: parseNumber(process.env.STREAM_BATCH_MIN_DELAY_MS, 120),
    batchMaxDelayMs: parseNumber(process.env.STREAM_BATCH_MAX_DELAY_MS, 320),
    rankingTimeoutMs: parseNumber(process.env.STREAM_RANKING_TIMEOUT_MS, 8_000),
    p5BudgetMs: parseNumber(process.env.STREAM_P5_BUDGET_MS, 14_000),
    p5PerTargetTimeoutMs: parseNumber(process.env.STREAM_P5_PER_TARGET_TIMEOUT_MS, 6_000),
    maxLiteratureTargets: parseNumber(process.env.STREAM_MAX_LITERATURE_TARGETS, 5),
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
    hypothesisTimeoutMs: parseNumber(process.env.OPENAI_HYPOTHESIS_TIMEOUT_MS, 10_000),
  },
};

export function assertRuntimeConfig(): void {
  if (!appConfig.openAiApiKey) {
    console.warn("OPENAI_API_KEY missing: OpenAI ranking will use fallback mode.");
  }
}
