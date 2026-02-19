import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { searchDrugCandidates } from "@/server/mcp/chembl";
import { McpClient } from "@/server/mcp/client";
import { searchDrugs } from "@/server/mcp/opentargets";
import { getPubmedArticles, searchPubmedByQuery } from "@/server/mcp/pubmed";

export type MedicalSnippetKind = "literature" | "drug" | "statistic";

export type MedicalSnippet = {
  id: string;
  kind: MedicalSnippetKind;
  title: string;
  source: string;
  url?: string;
  summary?: string;
};

export type MedicalEvidenceBundle = {
  literature: MedicalSnippet[];
  drugs: MedicalSnippet[];
  stats: MedicalSnippet[];
};

const cache = createTTLCache<string, MedicalEvidenceBundle>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);

const mcp = new McpClient(appConfig.mcp.medical);
const ENABLE_MEDICAL_JOURNAL_SCRAPE =
  process.env.MEDICAL_MCP_ENABLE_JOURNAL_SCRAPE === "1";

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slugify(value: string, max = 72): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
  return slug || "unknown";
}

function normalizeSource(
  kind: MedicalSnippetKind,
  explicit?: string,
): string {
  const value = clean(explicit);
  if (value) return value;
  if (kind === "drug") return "FDA";
  if (kind === "statistic") return "WHO";
  return "PubMed";
}

function isNoisyLine(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    normalized.length === 0 ||
    /^found\s+\d+/.test(normalized) ||
    /critical safety warning/.test(normalized) ||
    /dynamic data sources/.test(normalized) ||
    /no hardcoded data/.test(normalized) ||
    /cache:/i.test(line)
  );
}

function parseNumberedItems(
  raw: string,
  kind: MedicalSnippetKind,
  limit: number,
): MedicalSnippet[] {
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/\r/g, ""))
    .map((line) => line.trimEnd());
  const entries: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const itemMatch = trimmed.match(/^\d+\.\s+\*\*(.+?)\*\*/);
    if (itemMatch) {
      if (current) entries.push(current);
      current = {
        title: clean(itemMatch[1]),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(trimmed);
  }
  if (current) entries.push(current);

  const parsed: MedicalSnippet[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const facts: string[] = [];
    let source: string | undefined;
    let url: string | undefined;
    let id: string | undefined;
    let country: string | undefined;
    let value: string | undefined;

    for (const rawLine of entry.lines) {
      const line = clean(rawLine.replace(/^\*\*|\*\*$/g, ""));
      if (!line || isNoisyLine(line)) continue;
      const pmid = line.match(/^PMID:\s*(\d+)/i);
      const indicatorCode = line.match(/^Indicator Code:\s*([A-Za-z0-9._-]+)/i);
      const urlMatch = line.match(/^URL:\s*(https?:\/\/\S+)/i);
      const journal = line.match(/^Journal:\s*(.+)$/i);
      const manufacturer = line.match(/^Manufacturer:\s*(.+)$/i);
      const countryMatch = line.match(/^Country:\s*(.+)$/i);
      const valueMatch = line.match(/^Value:\s*(.+)$/i);

      if (pmid) {
        id = pmid[1];
        url = url ?? `https://pubmed.ncbi.nlm.nih.gov/${pmid[1]}/`;
        continue;
      }
      if (indicatorCode) {
        id = indicatorCode[1];
        continue;
      }
      if (urlMatch) {
        url = urlMatch[1];
        continue;
      }
      if (journal) {
        source = journal[1];
        continue;
      }
      if (manufacturer && !source) {
        source = manufacturer[1];
        continue;
      }
      if (countryMatch) {
        country = countryMatch[1];
      }
      if (valueMatch) {
        value = valueMatch[1];
      }

      if (
        /^(authors?|publication date|year|route|dosage form|purpose|range|context|last updated):/i.test(
          line,
        )
      ) {
        facts.push(line);
      }
    }

    const baseTitle = clean(entry.title);
    const enrichedTitle =
      kind === "statistic" && (country || value)
        ? `${baseTitle} (${[country, value].filter(Boolean).join(", ")})`
        : baseTitle;
    if (!enrichedTitle) continue;

    const snippetId =
      id ??
      (url ? slugify(url, 80) : `${kind}_${slugify(`${enrichedTitle}_${source ?? ""}`, 80)}`);
    const dedupeKey = `${kind}::${snippetId}::${url ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    parsed.push({
      id: snippetId,
      kind,
      title: enrichedTitle.slice(0, 220),
      source: normalizeSource(kind, source),
      url,
      summary: facts.slice(0, 3).join(" | ") || undefined,
    });

    if (parsed.length >= limit) break;
  }

  return parsed;
}

async function callMedicalTool(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 18_000,
): Promise<string> {
  try {
    return await mcp.callToolRaw(toolName, args, timeoutMs);
  } catch {
    return "";
  }
}

function mergeAndDedupe(
  rows: MedicalSnippet[],
  limit: number,
): MedicalSnippet[] {
  const out: MedicalSnippet[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.kind}::${row.id}::${row.url ?? ""}::${row.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function compactSummary(parts: Array<string | undefined>, max = 240): string | undefined {
  const text = parts
    .map((part) => clean(part))
    .filter(Boolean)
    .join(" | ")
    .trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function pushUnique<T>(target: T[], rows: T[], keyFor: (row: T) => string): void {
  const seen = new Set(target.map((row) => keyFor(row)));
  for (const row of rows) {
    const key = keyFor(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.push(row);
  }
}

async function collectFallbackLiterature(input: {
  query: string;
  diseaseName: string;
  targetSymbol: string;
  limit: number;
}): Promise<MedicalSnippet[]> {
  const limit = Math.max(1, Math.min(6, input.limit));
  const rows: MedicalSnippet[] = [];

  if (input.diseaseName && input.targetSymbol) {
    const pairArticles = await getPubmedArticles(
      input.diseaseName,
      input.targetSymbol,
      Math.max(limit, 3),
    ).catch(() => []);

    pushUnique(
      rows,
      pairArticles.map((article) => ({
        id: article.pmid || article.id,
        kind: "literature" as const,
        title: clean(article.title).slice(0, 220),
        source: clean(article.source) || "PubMed",
        url: article.url,
        summary: compactSummary([article.journal, article.year]),
      })),
      (row) => `${row.kind}::${row.id}::${row.url ?? ""}`,
    );
  }

  if (rows.length < limit) {
    const broadArticles = await searchPubmedByQuery(
      input.query || [input.diseaseName, input.targetSymbol].filter(Boolean).join(" "),
      Math.max(limit + 2, 4),
    ).catch(() => []);

    pushUnique(
      rows,
      broadArticles.map((article) => ({
        id: article.pmid || article.id,
        kind: "literature" as const,
        title: clean(article.title).slice(0, 220),
        source: clean(article.source) || "PubMed",
        url: article.url,
        summary: compactSummary([article.journal, article.year]),
      })),
      (row) => `${row.kind}::${row.id}::${row.url ?? ""}`,
    );
  }

  return rows.slice(0, limit);
}

async function collectFallbackDrugSnippets(input: {
  query: string;
  diseaseName: string;
  targetSymbol: string;
  interventionHint: string;
  limit: number;
}): Promise<MedicalSnippet[]> {
  const limit = Math.max(1, Math.min(4, input.limit));
  const candidateQueries = [
    input.interventionHint,
    input.targetSymbol,
    input.diseaseName,
    input.query,
  ]
    .map(clean)
    .filter(Boolean)
    .slice(0, 3);

  if (candidateQueries.length === 0) return [];

  const rows: MedicalSnippet[] = [];

  for (const candidate of candidateQueries) {
    if (rows.length >= limit) break;

    const [openTargetsHits, chemblHits] = await Promise.all([
      searchDrugs(candidate, Math.max(limit, 2) * 2).catch(() => []),
      searchDrugCandidates(candidate, Math.max(limit, 2) * 2).catch(() => []),
    ]);

    pushUnique(
      rows,
      openTargetsHits.map((hit) => ({
        id: `ot_${slugify(hit.id || hit.name, 72)}`,
        kind: "drug" as const,
        title: clean(hit.name || hit.id).slice(0, 220),
        source: "OpenTargets",
        summary: compactSummary([typeof hit.description === "string" ? hit.description : undefined]),
      })),
      (row) => `${row.kind}::${row.id}::${row.title.toLowerCase()}`,
    );

    pushUnique(
      rows,
      chemblHits.map((hit) => ({
        id: `chembl_${slugify(hit.id || hit.name, 72)}`,
        kind: "drug" as const,
        title: clean(hit.name || hit.id).slice(0, 220),
        source: "ChEMBL",
        summary: compactSummary([
          typeof hit.description === "string" ? hit.description : undefined,
          Number.isFinite(hit.maxPhase) ? `max phase ${hit.maxPhase}` : undefined,
        ]),
      })),
      (row) => `${row.kind}::${row.id}::${row.title.toLowerCase()}`,
    );
  }

  return rows.slice(0, limit);
}

async function collectFallbackStatsSnippets(input: {
  query: string;
  diseaseName: string;
  targetSymbol: string;
  limit: number;
}): Promise<MedicalSnippet[]> {
  const limit = Math.max(1, Math.min(4, input.limit));
  const statsQuery = [
    input.diseaseName || input.query,
    input.targetSymbol,
    "prevalence incidence epidemiology United States",
  ]
    .filter(Boolean)
    .join(" ");

  const articles = await searchPubmedByQuery(statsQuery, Math.max(limit + 2, 4)).catch(
    () => [],
  );

  const rows = articles.map((article) => ({
    id: `epi_${slugify(article.pmid || article.id, 72)}`,
    kind: "statistic" as const,
    title: clean(article.title).slice(0, 220),
    source: "PubMed epidemiology",
    url: article.url,
    summary: compactSummary([article.journal, article.year, "Population-level epidemiology"]),
  }));

  return mergeAndDedupe(rows, limit);
}

export async function collectMedicalEvidence(input: {
  query: string;
  diseaseName?: string;
  targetSymbol?: string;
  interventionHint?: string;
  maxLiterature?: number;
  maxDrug?: number;
  maxStats?: number;
}): Promise<MedicalEvidenceBundle> {
  const maxLiterature = Math.max(1, Math.min(6, input.maxLiterature ?? 4));
  const maxDrug = Math.max(1, Math.min(4, input.maxDrug ?? 2));
  const maxStats = Math.max(1, Math.min(4, input.maxStats ?? 2));
  const query = clean(input.query);
  const diseaseName = clean(input.diseaseName);
  const targetSymbol = clean(input.targetSymbol).toUpperCase();
  const interventionHint = clean(input.interventionHint);

  const evidenceQuery = clean(
    [query, diseaseName, targetSymbol].filter(Boolean).join(" "),
  ).slice(0, 220);
  const drugQuery = clean(interventionHint || targetSymbol || query).slice(0, 120);
  const statsIndicator = clean(diseaseName || query).slice(0, 120);
  const cacheKey = `${evidenceQuery}::${drugQuery}::${statsIndicator}::${maxLiterature}:${maxDrug}:${maxStats}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const [literatureRaw, journalRaw, drugRaw, statsRaw] = await Promise.all([
    callMedicalTool("search-medical-literature", {
      query: evidenceQuery || query,
      max_results: Math.max(maxLiterature, 3),
    }),
    ENABLE_MEDICAL_JOURNAL_SCRAPE
      ? callMedicalTool("search-medical-journals", {
          query: evidenceQuery || query,
        })
      : Promise.resolve(""),
    drugQuery
      ? callMedicalTool("search-drugs", {
          query: drugQuery,
          limit: Math.max(maxDrug, 2),
        })
      : Promise.resolve(""),
    statsIndicator
      ? callMedicalTool("get-health-statistics", {
          indicator: statsIndicator,
          country: "USA",
          limit: Math.max(maxStats, 2),
        })
      : Promise.resolve(""),
  ]);

  let literature = mergeAndDedupe(
    [
      ...parseNumberedItems(literatureRaw, "literature", maxLiterature),
      ...parseNumberedItems(journalRaw, "literature", Math.max(1, maxLiterature - 1)),
    ],
    maxLiterature,
  );
  let drugs = mergeAndDedupe(
    parseNumberedItems(drugRaw, "drug", maxDrug),
    maxDrug,
  );
  let stats = mergeAndDedupe(
    parseNumberedItems(statsRaw, "statistic", maxStats),
    maxStats,
  );

  const needsFallback = literature.length === 0 || drugs.length === 0 || stats.length === 0;
  if (needsFallback) {
    const [fallbackLiterature, fallbackDrugs, fallbackStats] = await Promise.all([
      literature.length === 0
        ? collectFallbackLiterature({
            query: evidenceQuery || query,
            diseaseName,
            targetSymbol,
            limit: maxLiterature,
          })
        : Promise.resolve([]),
      drugs.length === 0
        ? collectFallbackDrugSnippets({
            query: evidenceQuery || query,
            diseaseName,
            targetSymbol,
            interventionHint,
            limit: maxDrug,
          })
        : Promise.resolve([]),
      stats.length === 0
        ? collectFallbackStatsSnippets({
            query: evidenceQuery || query,
            diseaseName,
            targetSymbol,
            limit: maxStats,
          })
        : Promise.resolve([]),
    ]);

    literature = mergeAndDedupe([...literature, ...fallbackLiterature], maxLiterature);
    drugs = mergeAndDedupe([...drugs, ...fallbackDrugs], maxDrug);
    stats = mergeAndDedupe([...stats, ...fallbackStats], maxStats);
  }

  const result: MedicalEvidenceBundle = {
    literature,
    drugs,
    stats,
  };

  cache.set(cacheKey, result);
  return result;
}
