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

export type DrugTargetHint = {
  id: string;
  symbol: string;
  name: string;
  targetChemblId: string;
  confidence: number;
  description?: string;
};

export type ChEMBLDrugHit = {
  id: string;
  name: string;
  description?: string;
  maxPhase?: number;
};

const activityCache = createTTLCache<string, ChEMBLActivityDrug[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);
const drugTargetCache = createTTLCache<string, DrugTargetHint[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const mcp = new McpClient(appConfig.mcp.chembl);

export async function searchDrugCandidates(
  query: string,
  limit = 8,
): Promise<ChEMBLDrugHit[]> {
  const normalized = query.trim();
  if (!normalized) return [];

  const cap = Math.max(1, Math.min(limit, 20));
  let molecules: any[] = [];

  try {
    const payload = await mcp.callTool<any>("search_drugs", {
      query: normalized,
      limit: Math.max(cap, 12),
    });
    molecules = Array.isArray(payload?.drugs) ? payload.drugs : [];
  } catch {
    // fall through to direct API fallback
  }

  if (molecules.length === 0) {
    const fallback = await fetchJson<any>(
      `https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q=${encodeURIComponent(normalized)}&limit=${Math.max(
        cap,
        12,
      )}`,
    ).catch(() => null);
    molecules = Array.isArray(fallback?.molecules) ? fallback.molecules : [];
  }

  const out = new Map<string, ChEMBLDrugHit>();
  for (const molecule of molecules) {
    const id =
      typeof molecule?.molecule_chembl_id === "string"
        ? molecule.molecule_chembl_id.trim().toUpperCase()
        : "";
    if (!id) continue;
    const synonyms: string[] = Array.isArray(molecule?.molecule_synonyms)
      ? [
          ...new Set<string>(
            molecule.molecule_synonyms
              .map((item: any) =>
                typeof item?.molecule_synonym === "string"
                  ? item.molecule_synonym.trim()
                  : "",
              )
              .filter((item: string) => item.length > 0),
          ),
        ].slice(0, 20)
      : [];
    const normalizedQuery = normalized.toLowerCase();
    const queryMatchedSynonym =
      synonyms.find((item) => item.toLowerCase() === normalizedQuery) ??
      synonyms.find((item) => item.toLowerCase().includes(normalizedQuery));
    const name =
      (typeof queryMatchedSynonym === "string" && queryMatchedSynonym.length > 0
        ? queryMatchedSynonym
        : undefined) ||
      (typeof molecule?.pref_name === "string" && molecule.pref_name.trim().length > 0
        ? molecule.pref_name
        : undefined) ||
      (typeof synonyms[0] === "string" && synonyms[0].length > 0 ? synonyms[0] : undefined) ||
      id;

    const descriptionParts = [
      typeof molecule?.molecule_type === "string" ? molecule.molecule_type : "",
      ...synonyms,
    ].filter((part) => part.length > 0);
    const description = descriptionParts.length > 0 ? descriptionParts.join("; ") : undefined;

    const current = out.get(id);
    const maxPhase =
      typeof molecule?.max_phase === "number" && Number.isFinite(molecule.max_phase)
        ? molecule.max_phase
        : undefined;
    const next: ChEMBLDrugHit = {
      id,
      name,
      description,
      maxPhase,
    };
    if (!current) {
      out.set(id, next);
      continue;
    }
    if ((next.maxPhase ?? -1) > (current.maxPhase ?? -1)) {
      out.set(id, next);
    }
  }

  return [...out.values()].slice(0, cap);
}

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

async function resolveTargetHint(targetChemblId: string): Promise<DrugTargetHint | null> {
  try {
    const payload = await fetchJson<any>(
      `https://www.ebi.ac.uk/chembl/api/data/target/${encodeURIComponent(targetChemblId)}.json`,
    );

    const components = Array.isArray(payload?.target_components)
      ? payload.target_components
      : [];
    const first = components[0];
    const synonyms = Array.isArray(first?.target_component_synonyms)
      ? first.target_component_synonyms
      : [];
    const symbolCandidate = synonyms.find(
      (item: any) =>
        typeof item?.syn_type === "string" &&
        item.syn_type.toLowerCase().includes("gene") &&
        typeof item?.component_synonym === "string",
    );
    const symbol =
      (typeof symbolCandidate?.component_synonym === "string"
        ? symbolCandidate.component_synonym
        : undefined) ||
      (typeof first?.accession === "string" ? first.accession : undefined) ||
      targetChemblId;

    const name =
      (typeof payload?.pref_name === "string" && payload.pref_name.trim().length > 0
        ? payload.pref_name
        : undefined) ||
      symbol;

    return {
      id: symbol,
      symbol,
      name,
      targetChemblId,
      description:
        typeof payload?.target_type === "string" ? payload.target_type : undefined,
      confidence: 0.64,
    };
  } catch {
    return null;
  }
}

function isGenericTargetHint(hint: DrugTargetHint): boolean {
  const text = `${hint.symbol} ${hint.name}`.toLowerCase();
  return (
    text.includes("no relevant target") ||
    text.includes("admet") ||
    text.includes("unknown") ||
    text.includes("not available") ||
    text.includes("dummy target")
  );
}

function scoreActivityPotency(activity: any): number {
  const pchembl = Number(activity?.pchembl_value);
  if (Number.isFinite(pchembl)) {
    if (pchembl >= 7) return 1;
    if (pchembl >= 6) return 0.8;
    if (pchembl >= 5) return 0.55;
  }

  const standardValue = Number(activity?.standard_value);
  const units = String(activity?.standard_units ?? "").toLowerCase();
  if (Number.isFinite(standardValue) && standardValue > 0 && units.includes("nm")) {
    if (standardValue <= 100) return 1;
    if (standardValue <= 1000) return 0.7;
    if (standardValue <= 10_000) return 0.4;
  }

  return 0.15;
}

function rankTargetIdsFromActivities(activities: any[], maxRows: number): string[] {
  const byTarget = new Map<string, { count: number; potency: number }>();
  for (const activity of activities) {
    const targetId =
      typeof activity?.target_chembl_id === "string"
        ? activity.target_chembl_id.trim()
        : "";
    if (!targetId) continue;
    const prior = byTarget.get(targetId) ?? { count: 0, potency: 0 };
    prior.count += 1;
    prior.potency += scoreActivityPotency(activity);
    byTarget.set(targetId, prior);
  }

  return [...byTarget.entries()]
    .sort((a, b) => {
      if (b[1].potency !== a[1].potency) return b[1].potency - a[1].potency;
      return b[1].count - a[1].count;
    })
    .slice(0, Math.max(1, maxRows * 3))
    .map(([targetId]) => targetId);
}

export async function getDrugTargetHints(
  moleculeChemblId: string,
  maxRows = 6,
): Promise<DrugTargetHint[]> {
  const normalized = moleculeChemblId.trim().toUpperCase();
  if (!normalized) return [];

  const cacheKey = `${normalized}::${maxRows}`;
  const cached = drugTargetCache.get(cacheKey);
  if (cached) return cached;

  let targetIds: string[] = [];

  try {
    const mechanismPayload = await mcp.callTool<any>("get_mechanism_of_action", {
      chembl_id: normalized,
    });
    targetIds = (mechanismPayload?.mechanisms ?? [])
      .map((item: any) =>
        typeof item?.target_chembl_id === "string" ? item.target_chembl_id : "",
      )
      .filter((value: string) => value.length > 0);
  } catch {
    // fall through to activity lookup
  }

  if (targetIds.length === 0) {
    const mechanismFallback = await fetchJson<any>(
      `https://www.ebi.ac.uk/chembl/api/data/mechanism.json?molecule_chembl_id=${encodeURIComponent(
        normalized,
      )}&limit=20`,
    ).catch(() => null);
    targetIds = (mechanismFallback?.mechanisms ?? [])
      .map((item: any) =>
        typeof item?.target_chembl_id === "string" ? item.target_chembl_id : "",
      )
      .filter((value: string) => value.length > 0);
  }

  if (targetIds.length === 0) {
    let payload: any;
    try {
      payload = await mcp.callTool<any>("search_activities", {
        molecule_chembl_id: normalized,
        limit: 60,
      });
    } catch {
      payload = await fetchJson<any>(
        `https://www.ebi.ac.uk/chembl/api/data/activity.json?molecule_chembl_id=${encodeURIComponent(
          normalized,
        )}&limit=60`,
      );
    }

    targetIds = rankTargetIdsFromActivities(payload?.activities ?? [], maxRows);
  }

  const uniqueTargetIds = [...new Set(targetIds)] as string[];
  const cappedTargetIds = uniqueTargetIds.slice(0, Math.max(1, maxRows));
  if (cappedTargetIds.length === 0) {
    drugTargetCache.set(cacheKey, []);
    return [];
  }

  const hints = await Promise.all(cappedTargetIds.map((targetId) => resolveTargetHint(targetId)));
  const resolved = hints
    .filter((item): item is DrugTargetHint => Boolean(item))
    .filter((item) => !isGenericTargetHint(item))
    .slice(0, maxRows)
    .map((item, index) => ({
      ...item,
      confidence: Number(Math.max(0.35, 0.82 - index * 0.07).toFixed(3)),
    }));
  drugTargetCache.set(cacheKey, resolved);
  return resolved;
}
