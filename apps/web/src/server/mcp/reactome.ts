/* eslint-disable @typescript-eslint/no-explicit-any */
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { fetchJson } from "@/server/http";
import { McpClient } from "@/server/mcp/client";

export type Pathway = {
  id: string;
  name: string;
  species?: string;
  url?: string;
};

const pathwaysCache = createTTLCache<string, Pathway[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const pathwayDetailCache = createTTLCache<string, Record<string, unknown>>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const mcp = new McpClient(appConfig.mcp.reactome);

export async function findPathwaysByGene(gene: string): Promise<Pathway[]> {
  const cacheKey = gene.toUpperCase();
  const cached = pathwaysCache.get(cacheKey);
  if (cached) return cached;

  try {
    const payload = await mcp.callTool<any>("find_pathways_by_gene", {
      gene,
      species: "Homo sapiens",
    });

    const pathways = (payload?.pathways ?? []).map((pathway: any) => ({
      id: pathway.id,
      name: pathway.name,
      species: pathway.species,
      url: pathway.url,
    }));

    pathwaysCache.set(cacheKey, pathways);
    return pathways;
  } catch {
    const search = await fetchJson<any>(
      `https://reactome.org/ContentService/search/query?query=${encodeURIComponent(
        gene,
      )}&types=Protein&cluster=true`,
    );

    const proteinGroup = (search?.results ?? []).find(
      (group: any) => group?.typeName === "Protein",
    );

    const stId = proteinGroup?.entries?.[0]?.stId;
    if (!stId) return [];

    const pathwaysRaw = await fetchJson<any[]>(
      `https://reactome.org/ContentService/data/pathways/low/entity/${encodeURIComponent(stId)}`,
    );

    const pathways = (pathwaysRaw ?? []).map((pathway: any) => ({
      id: pathway.stId,
      name: pathway.name,
      species: pathway.species?.[0]?.name,
      url: `https://reactome.org/content/detail/${pathway.stId}`,
    }));

    pathwaysCache.set(cacheKey, pathways);
    return pathways;
  }
}

export async function getPathwayDetails(
  pathwayId: string,
): Promise<Record<string, unknown>> {
  const cached = pathwayDetailCache.get(pathwayId);
  if (cached) return cached;

  try {
    const details = await mcp.callTool<Record<string, unknown>>("get_pathway_details", {
      id: pathwayId,
    });
    pathwayDetailCache.set(pathwayId, details);
    return details;
  } catch {
    const details = await fetchJson<Record<string, unknown>>(
      `https://reactome.org/ContentService/data/query/${encodeURIComponent(pathwayId)}`,
    );

    pathwayDetailCache.set(pathwayId, details);
    return details;
  }
}
