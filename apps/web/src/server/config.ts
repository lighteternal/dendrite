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
    batchMinDelayMs: parseNumber(process.env.STREAM_BATCH_MIN_DELAY_MS, 300),
    batchMaxDelayMs: parseNumber(process.env.STREAM_BATCH_MAX_DELAY_MS, 800),
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
  },
};

export function assertRuntimeConfig(): void {
  if (!appConfig.openAiApiKey) {
    console.warn("OPENAI_API_KEY missing: OpenAI ranking will use fallback mode.");
  }
}
