/* eslint-disable @typescript-eslint/no-explicit-any */
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { fetchJson } from "@/server/http";
import { McpClient } from "@/server/mcp/client";

type DiseaseHit = {
  id: string;
  name: string;
  description?: string;
};

export type TargetHit = {
  id: string;
  name: string;
  description?: string;
};

export type DrugHit = {
  id: string;
  name: string;
  description?: string;
};

export type DiseaseTarget = {
  targetId: string;
  targetSymbol: string;
  targetName: string;
  associationScore: number;
};

export type KnownDrug = {
  drugId: string;
  name: string;
  phase: number;
  status?: string;
  mechanismOfAction?: string;
  drugType?: string;
};

const diseaseCache = createTTLCache<string, DiseaseHit[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);
const targetSummaryCache = createTTLCache<string, DiseaseTarget[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);
const targetSearchCache = createTTLCache<string, TargetHit[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);
const drugSearchCache = createTTLCache<string, DrugHit[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);
const knownDrugsCache = createTTLCache<string, KnownDrug[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const mcp = new McpClient(appConfig.mcp.opentargets);

const diseaseIdPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;

function toDiseaseHit(raw: any): DiseaseHit | null {
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  const description = typeof raw?.description === "string" ? raw.description : undefined;
  const entity =
    typeof raw?.entity === "string" ? raw.entity.toLowerCase() : undefined;

  if (!id || !name) return null;
  if (entity && entity !== "disease") return null;
  if (!diseaseIdPattern.test(id)) return null;

  return {
    id,
    name,
    description,
  };
}

function normalizeDiseaseHits(rawHits: any[], size: number): DiseaseHit[] {
  const deduped = new Map<string, DiseaseHit>();
  for (const hit of rawHits) {
    const normalized = toDiseaseHit(hit);
    if (!normalized) continue;
    if (!deduped.has(normalized.id)) {
      deduped.set(normalized.id, normalized);
    }
  }
  return [...deduped.values()].slice(0, size);
}

function normalizeEntityHits<T extends { id: string; name: string; description?: string }>(
  rawHits: any[],
  entityName: "target" | "drug",
  size: number,
): T[] {
  const deduped = new Map<string, T>();
  for (const raw of rawHits) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const description =
      typeof raw?.description === "string" ? raw.description : undefined;
    const entity =
      typeof raw?.entity === "string" ? raw.entity.toLowerCase() : undefined;

    if (!id || !name) continue;
    if (entity && entity !== entityName) continue;
    if (!deduped.has(id)) {
      deduped.set(id, {
        id,
        name,
        description,
      } as T);
    }
  }
  return [...deduped.values()].slice(0, size);
}

export async function searchDiseases(query: string, size = 8): Promise<DiseaseHit[]> {
  const cacheKey = `${query.toLowerCase()}::${size}`;
  const cached = diseaseCache.get(cacheKey);
  if (cached) return cached;

  try {
    const payload = await mcp.callTool<any>("search_diseases", { query, size });
    const rawHits = payload?.data?.search?.hits ?? payload?.hits ?? [];
    const hits = normalizeDiseaseHits(rawHits, size);

    diseaseCache.set(cacheKey, hits);
    return hits;
  } catch {
    const response = await fetchJson<any>(
      "https://api.platform.opentargets.org/api/v4/graphql",
      {
        method: "POST",
        body: JSON.stringify({
          query: `
            query SearchDiseases($queryString: String!) {
              search(queryString: $queryString, entityNames: ["disease"]) {
                hits {
                  id
                  name
                  description
                  entity
                }
              }
            }
          `,
          variables: { queryString: query },
        }),
      },
    );

    const rawHits = response?.data?.search?.hits ?? [];
    const hits = normalizeDiseaseHits(rawHits, size);
    diseaseCache.set(cacheKey, hits);
    return hits;
  }
}

export async function searchTargets(query: string, size = 8): Promise<TargetHit[]> {
  const cacheKey = `${query.toLowerCase()}::${size}`;
  const cached = targetSearchCache.get(cacheKey);
  if (cached) return cached;

  try {
    const payload = await mcp.callTool<any>("search_targets", { query, size });
    const rawHits = payload?.data?.search?.hits ?? payload?.hits ?? payload?.targets ?? [];
    const hits = normalizeEntityHits<TargetHit>(rawHits, "target", size);
    targetSearchCache.set(cacheKey, hits);
    return hits;
  } catch {
    const response = await fetchJson<any>(
      "https://api.platform.opentargets.org/api/v4/graphql",
      {
        method: "POST",
        body: JSON.stringify({
          query: `
            query SearchTargets($queryString: String!) {
              search(queryString: $queryString, entityNames: ["target"]) {
                hits {
                  id
                  name
                  description
                  entity
                }
              }
            }
          `,
          variables: { queryString: query },
        }),
      },
    );

    const rawHits = response?.data?.search?.hits ?? [];
    const hits = normalizeEntityHits<TargetHit>(rawHits, "target", size);
    targetSearchCache.set(cacheKey, hits);
    return hits;
  }
}

export async function searchDrugs(query: string, size = 8): Promise<DrugHit[]> {
  const cacheKey = `${query.toLowerCase()}::${size}`;
  const cached = drugSearchCache.get(cacheKey);
  if (cached) return cached;

  try {
    const payload = await mcp.callTool<any>("search_drugs", { query, size });
    const rawHits = payload?.data?.search?.hits ?? payload?.hits ?? payload?.drugs ?? [];
    const hits = normalizeEntityHits<DrugHit>(rawHits, "drug", size);
    drugSearchCache.set(cacheKey, hits);
    return hits;
  } catch {
    const response = await fetchJson<any>(
      "https://api.platform.opentargets.org/api/v4/graphql",
      {
        method: "POST",
        body: JSON.stringify({
          query: `
            query SearchDrugs($queryString: String!) {
              search(queryString: $queryString, entityNames: ["drug"]) {
                hits {
                  id
                  name
                  description
                  entity
                }
              }
            }
          `,
          variables: { queryString: query },
        }),
      },
    );

    const rawHits = response?.data?.search?.hits ?? [];
    const hits = normalizeEntityHits<DrugHit>(rawHits, "drug", size);
    drugSearchCache.set(cacheKey, hits);
    return hits;
  }
}

export async function getDiseaseTargetsSummary(
  diseaseId: string,
  size = 20,
): Promise<DiseaseTarget[]> {
  const cacheKey = `${diseaseId}::${size}`;
  const cached = targetSummaryCache.get(cacheKey);
  if (cached) return cached;

  try {
    const payload = await mcp.callTool<any>("get_disease_targets_summary", {
      diseaseId,
      size,
    });

    const topTargets = (payload?.topTargets ?? []).slice(0, size).map((t: any) => ({
      targetId: t.targetId,
      targetSymbol: t.targetSymbol,
      targetName: t.targetName,
      associationScore: Number(t.associationScore ?? 0),
    }));

    targetSummaryCache.set(cacheKey, topTargets);
    return topTargets;
  } catch {
    const response = await fetchJson<any>(
      "https://api.platform.opentargets.org/api/v4/graphql",
      {
        method: "POST",
        body: JSON.stringify({
          query: `
          query DiseaseTargets($efoId: String!) {
            disease(efoId: $efoId) {
              associatedTargets {
                rows {
                  score
                  target {
                    id
                    approvedName
                    approvedSymbol
                  }
                }
              }
            }
          }
        `,
          variables: { efoId: diseaseId },
        }),
      },
    );

    const targets = (response?.data?.disease?.associatedTargets?.rows ?? [])
      .slice(0, size)
      .map((row: any) => ({
        targetId: row?.target?.id,
        targetSymbol: row?.target?.approvedSymbol,
        targetName: row?.target?.approvedName,
        associationScore: Number(row?.score ?? 0),
      }))
      .filter((t: DiseaseTarget) => !!t.targetId && !!t.targetSymbol);

    targetSummaryCache.set(cacheKey, targets);
    return targets;
  }
}

export async function getKnownDrugsForTarget(
  targetId: string,
  size = 12,
): Promise<KnownDrug[]> {
  const cacheKey = `${targetId}::${size}`;
  const cached = knownDrugsCache.get(cacheKey);
  if (cached) return cached;

  const response = await fetchJson<any>(
    "https://api.platform.opentargets.org/api/v4/graphql",
    {
      method: "POST",
      body: JSON.stringify({
        query: `
        query TargetKnownDrugs($id: String!) {
          target(ensemblId: $id) {
            knownDrugs(size: 50) {
              rows {
                phase
                status
                mechanismOfAction
                drug {
                  id
                  name
                  maximumClinicalTrialPhase
                  drugType
                }
              }
            }
          }
        }
      `,
        variables: { id: targetId },
      }),
    },
  );

  const drugs = (response?.data?.target?.knownDrugs?.rows ?? [])
    .slice(0, size)
    .map((row: any) => ({
      drugId: row?.drug?.id,
      name: row?.drug?.name,
      phase: Number(row?.phase ?? row?.drug?.maximumClinicalTrialPhase ?? 0),
      status: row?.status,
      mechanismOfAction: row?.mechanismOfAction,
      drugType: row?.drug?.drugType,
    }))
    .filter((d: KnownDrug) => !!d.drugId && !!d.name);

  knownDrugsCache.set(cacheKey, drugs);
  return drugs;
}
