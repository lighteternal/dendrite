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
const knownDrugsCache = createTTLCache<string, KnownDrug[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const mcp = new McpClient(appConfig.mcp.opentargets);

export async function searchDiseases(query: string, size = 8): Promise<DiseaseHit[]> {
  const cacheKey = `${query.toLowerCase()}::${size}`;
  const cached = diseaseCache.get(cacheKey);
  if (cached) return cached;

  try {
    const payload = await mcp.callTool<any>("search_diseases", { query, size });
    const hits =
      payload?.data?.search?.hits?.map((hit: any) => ({
        id: hit.id,
        name: hit.name,
        description: hit.description,
      })) ?? [];

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
                }
              }
            }
          `,
          variables: { queryString: query },
        }),
      },
    );

    const hits = (response?.data?.search?.hits ?? []).slice(0, size).map((hit: any) => ({
      id: hit.id,
      name: hit.name,
      description: hit.description,
    }));
    diseaseCache.set(cacheKey, hits);
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
