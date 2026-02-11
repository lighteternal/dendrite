/* eslint-disable @typescript-eslint/no-explicit-any */
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { fetchJson } from "@/server/http";
import { McpClient } from "@/server/mcp/client";

export type ChEMBLActivityDrug = {
  moleculeId: string;
  name: string;
  activityType?: string;
  potency?: number;
  potencyUnits?: string;
  targetChemblId?: string;
};

const activityCache = createTTLCache<string, ChEMBLActivityDrug[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const mcp = new McpClient(appConfig.mcp.chembl);

async function resolveTargetChemblIds(symbol: string): Promise<string[]> {
  try {
    const payload = await mcp.callTool<any>("search_targets", {
      query: symbol,
      organism: "Homo sapiens",
      limit: 5,
    });

    const ids = (payload?.targets ?? [])
      .map((item: any) => item?.target_chembl_id)
      .filter(Boolean);

    if (ids.length > 0) return ids;
  } catch {
    // fall through
  }

  const fallback = await fetchJson<any>(
    `https://www.ebi.ac.uk/chembl/api/data/target/search.json?q=${encodeURIComponent(symbol)}&limit=5`,
  );

  return (fallback?.targets ?? [])
    .map((target: any) => target?.target_chembl_id)
    .filter(Boolean);
}

async function moleculeName(moleculeId: string): Promise<string> {
  try {
    const payload = await fetchJson<any>(
      `https://www.ebi.ac.uk/chembl/api/data/molecule/${encodeURIComponent(moleculeId)}.json`,
    );

    return (
      payload?.pref_name ??
      payload?.molecule_synonyms?.find((s: any) => !!s?.molecule_synonym)
        ?.molecule_synonym ??
      moleculeId
    );
  } catch {
    return moleculeId;
  }
}

export async function getTargetActivityDrugs(
  targetSymbol: string,
  maxRows = 10,
): Promise<ChEMBLActivityDrug[]> {
  const cacheKey = `${targetSymbol.toUpperCase()}::${maxRows}`;
  const cached = activityCache.get(cacheKey);
  if (cached) return cached;

  const targetIds = await resolveTargetChemblIds(targetSymbol);
  if (targetIds.length === 0) return [];

  const drugs: ChEMBLActivityDrug[] = [];

  for (const targetChemblId of targetIds.slice(0, 2)) {
    let payload: any;

    try {
      payload = await mcp.callTool<any>("search_activities", {
        target_chembl_id: targetChemblId,
        limit: 30,
      });
    } catch {
      payload = await fetchJson<any>(
        `https://www.ebi.ac.uk/chembl/api/data/activity.json?target_chembl_id=${encodeURIComponent(targetChemblId)}&limit=30`,
      );
    }

    for (const activity of payload?.activities ?? []) {
      const moleculeId = activity?.molecule_chembl_id;
      if (!moleculeId) continue;

      drugs.push({
        moleculeId,
        name: moleculeId,
        activityType: activity?.standard_type,
        potency:
          activity?.standard_value !== null && activity?.standard_value !== undefined
            ? Number(activity.standard_value)
            : undefined,
        potencyUnits: activity?.standard_units,
        targetChemblId,
      });
    }
  }

  const deduped = new Map<string, ChEMBLActivityDrug>();
  for (const drug of drugs) {
    const existing = deduped.get(drug.moleculeId);
    if (!existing) {
      deduped.set(drug.moleculeId, drug);
      continue;
    }

    if ((drug.potency ?? Number.POSITIVE_INFINITY) < (existing.potency ?? Number.POSITIVE_INFINITY)) {
      deduped.set(drug.moleculeId, drug);
    }
  }

  const top = [...deduped.values()]
    .sort((a, b) => (a.potency ?? Number.POSITIVE_INFINITY) - (b.potency ?? Number.POSITIVE_INFINITY))
    .slice(0, maxRows);

  await Promise.all(
    top.map(async (drug) => {
      drug.name = await moleculeName(drug.moleculeId);
    }),
  );

  activityCache.set(cacheKey, top);
  return top;
}
