import { appConfig } from "@/server/config";
import { getLiteratureAndTrials } from "@/server/mcp/biomcp";
import { searchDrugCandidates } from "@/server/mcp/chembl";
import { collectMedicalEvidence } from "@/server/mcp/medical";
import { searchDiseases } from "@/server/mcp/opentargets";
import { searchPubmedByQuery } from "@/server/mcp/pubmed";
import { findPathwaysByGene } from "@/server/mcp/reactome";
import { getInteractionNetwork } from "@/server/mcp/stringdb";

export type McpHealthKey =
  | "opentargets"
  | "reactome"
  | "string"
  | "chembl"
  | "biomcp"
  | "pubmed"
  | "medical";

export type McpHealthState = "green" | "red";

export type McpHealthRow = {
  key: McpHealthKey;
  label: string;
  state: McpHealthState;
  detail: string;
  latencyMs: number;
  checkedAt: string;
};

export type McpHealthSnapshot = {
  checkedAt: string;
  transportMode: string;
  tools: McpHealthRow[];
};

type ProbeResult = {
  ok: boolean;
  detail: string;
};

const PROBE_TIMEOUT_MS = 16_000;
const SNAPSHOT_TTL_MS = 90_000;

let cachedSnapshot: McpHealthSnapshot | null = null;
let cachedAtMs = 0;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

async function runProbe(
  key: McpHealthKey,
  label: string,
  probe: () => Promise<ProbeResult>,
): Promise<McpHealthRow> {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(probe(), PROBE_TIMEOUT_MS);
    return {
      key,
      label,
      state: result.ok ? "green" : "red",
      detail: result.detail,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      key,
      label,
      state: "red",
      detail: error instanceof Error ? error.message : "probe failed",
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function getMcpHealthSnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<McpHealthSnapshot> {
  const forceRefresh = options?.forceRefresh ?? false;
  const now = Date.now();
  if (!forceRefresh && cachedSnapshot && now - cachedAtMs <= SNAPSHOT_TTL_MS) {
    return cachedSnapshot;
  }

  const probes = await Promise.all([
    runProbe("opentargets", "OpenTargets MCP", async () => {
      const hits = await searchDiseases("obesity", 2);
      return {
        ok: hits.length > 0,
        detail: `sample search returned ${hits.length} disease hit(s)`,
      };
    }),
    runProbe("reactome", "Reactome MCP", async () => {
      const pathways = await findPathwaysByGene("IL6");
      return {
        ok: pathways.length > 0,
        detail: `sample gene probe returned ${pathways.length} pathway hit(s)`,
      };
    }),
    runProbe("string", "STRING MCP", async () => {
      const network = await getInteractionNetwork(["IL6", "TNF"], 0.4, 8);
      return {
        ok: network.edges.length > 0,
        detail: `sample network probe returned ${network.edges.length} edge(s)`,
      };
    }),
    runProbe("chembl", "ChEMBL MCP", async () => {
      const drugs = await searchDrugCandidates("metformin", 3);
      return {
        ok: drugs.length > 0,
        detail: `sample drug probe returned ${drugs.length} molecule hit(s)`,
      };
    }),
    runProbe("biomcp", "BioMCP", async () => {
      const evidence = await getLiteratureAndTrials("obesity", "IL6", "metformin");
      const total = evidence.articles.length + evidence.trials.length;
      return {
        ok: total > 0,
        detail: `sample evidence probe returned ${evidence.articles.length} article(s) and ${evidence.trials.length} trial(s)`,
      };
    }),
    runProbe("pubmed", "PubMed MCP", async () => {
      const articles = await searchPubmedByQuery(
        "obesity inflammatory signaling type 2 diabetes",
        3,
      );
      return {
        ok: articles.length > 0,
        detail: `sample query returned ${articles.length} article(s)`,
      };
    }),
    runProbe("medical", "Medical MCP", async () => {
      const evidence = await collectMedicalEvidence({
        query: "obesity inflammatory signaling type 2 diabetes",
        diseaseName: "obesity",
        targetSymbol: "IL6",
        interventionHint: "metformin",
        maxLiterature: 2,
        maxDrug: 2,
        maxStats: 2,
      });
      const total = evidence.literature.length + evidence.drugs.length + evidence.stats.length;
      return {
        ok: total > 0,
        detail: `sample evidence returned ${evidence.literature.length} literature / ${evidence.drugs.length} drug / ${evidence.stats.length} stats snippet(s)`,
      };
    }),
  ]);

  const snapshot: McpHealthSnapshot = {
    checkedAt: new Date().toISOString(),
    transportMode: appConfig.mcpTransportMode,
    tools: probes,
  };
  cachedSnapshot = snapshot;
  cachedAtMs = now;
  return snapshot;
}
