/* eslint-disable @typescript-eslint/no-explicit-any */
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { fetchJson } from "@/server/http";
import { McpClient } from "@/server/mcp/client";

export type StringNode = {
  id: string;
  symbol: string;
  annotation?: string;
};

export type StringEdge = {
  sourceSymbol: string;
  targetSymbol: string;
  score: number;
  evidence?: string[];
};

const networkCache = createTTLCache<string, { nodes: StringNode[]; edges: StringEdge[] }>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const mcp = new McpClient(appConfig.mcp.string);

export async function getInteractionNetwork(
  proteins: string[],
  confidence = appConfig.string.confidenceDefault,
  addNodes = appConfig.string.maxAddedNodes,
): Promise<{ nodes: StringNode[]; edges: StringEdge[] }> {
  const sortedProteins = [...new Set(proteins.map((p) => p.trim()).filter(Boolean))].sort();
  const cacheKey = `${sortedProteins.join(",")}::${confidence}::${addNodes}`;
  const cached = networkCache.get(cacheKey);
  if (cached) return cached;

  const requiredScore = Math.round(Math.max(0, Math.min(1, confidence)) * 1000);

  try {
    const payload = await mcp.callTool<any>("get_interaction_network", {
      protein_ids: sortedProteins,
      species: "9606",
      add_nodes: addNodes,
      required_score: requiredScore,
    });

    const nodes: StringNode[] = (payload?.nodes ?? []).map((node: any) => ({
      id: node.string_id || node.protein_name,
      symbol: node.protein_name,
      annotation: node.annotation,
    }));

    const edges: StringEdge[] = (payload?.edges ?? []).map((edge: any) => ({
      sourceSymbol: edge.protein_a,
      targetSymbol: edge.protein_b,
      score:
        Number(edge.confidence_score ?? 0) > 1
          ? Number(edge.confidence_score ?? 0) / 1000
          : Number(edge.confidence_score ?? 0),
      evidence: Array.isArray(edge.evidence_types)
        ? edge.evidence_types
        : typeof edge.evidence_types === "string"
          ? [edge.evidence_types]
          : [],
    }));

    const data = {
      nodes,
      edges: edges.slice(0, appConfig.string.maxAddedEdges),
    };

    networkCache.set(cacheKey, data);
    return data;
  } catch {
    const url =
      `https://string-db.org/api/json/network?identifiers=${encodeURIComponent(
        sortedProteins.join("\r"),
      )}&species=9606&required_score=${requiredScore}` +
      `&add_white_nodes=${Math.min(addNodes, appConfig.string.maxNeighborsPerSeed)}`;

    const raw = await fetchJson<any[]>(url);

    const nodeSet = new Map<string, StringNode>();
    const edges: StringEdge[] = [];

    for (const row of raw ?? []) {
      const a = row?.preferredName_A ?? row?.preferredNameA;
      const b = row?.preferredName_B ?? row?.preferredNameB;
      if (!a || !b) continue;

      nodeSet.set(a, { id: row?.stringId_A ?? a, symbol: a });
      nodeSet.set(b, { id: row?.stringId_B ?? b, symbol: b });

      edges.push({
        sourceSymbol: a,
        targetSymbol: b,
        score: Number(row?.score ?? 0),
      });
    }

    const data = {
      nodes: [...nodeSet.values()].slice(0, appConfig.string.maxAddedNodes),
      edges: edges.slice(0, appConfig.string.maxAddedEdges),
    };

    networkCache.set(cacheKey, data);
    return data;
  }
}
