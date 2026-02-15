import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { fetchJson } from "@/server/http";
import { McpClient } from "@/server/mcp/client";

export type PubmedArticle = {
  id: string;
  pmid?: string;
  title: string;
  source: string;
  url: string;
  journal?: string;
  year?: string;
};

const cache = createTTLCache<string, PubmedArticle[]>(
  appConfig.cache.ttlMs,
  appConfig.cache.maxEntries,
);
const mcp = new McpClient(appConfig.mcp.pubmed);

function parsePubmedServerArticles(payload: unknown, limit: number): PubmedArticle[] {
  const objectPayload =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!objectPayload) return [];

  const rows = Array.isArray(objectPayload.articles) ? objectPayload.articles : [];
  const parsed: PubmedArticle[] = [];
  for (const row of rows) {
    const article = row && typeof row === "object" ? (row as Record<string, unknown>) : null;
    if (!article) continue;
    const pmid = typeof article.pmid === "string" ? article.pmid.trim() : "";
    const id = pmid || (typeof article.doi === "string" ? article.doi.trim() : "");
    const title = typeof article.title === "string" ? article.title.trim() : "";
    if (!id || !title) continue;

    const journal =
      typeof article.journal === "string" && article.journal.trim().length > 0
        ? article.journal.trim()
        : undefined;
    const year =
      typeof article.publicationDate === "string" && article.publicationDate.trim().length >= 4
        ? article.publicationDate.trim().slice(0, 4)
        : undefined;
    parsed.push({
      id,
      pmid: pmid || undefined,
      title: title.slice(0, 220),
      source: journal ?? "PubMed MCP",
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "https://pubmed.ncbi.nlm.nih.gov/",
      journal,
      year,
    });
    if (parsed.length >= limit) break;
  }
  return parsed;
}

async function fetchPubmedViaMcpServer(
  query: string,
  limit: number,
): Promise<PubmedArticle[]> {
  const payload = await mcp.callTool<Record<string, unknown>>(
    "search_articles",
    {
      query,
      max_results: Math.min(60, Math.max(6, limit * 3)),
      sort: "relevance",
    },
    10_000,
  );
  const parsed = parsePubmedServerArticles(payload, limit);
  return parsed;
}

function parsePubmedLines(raw: string, limit: number): PubmedArticle[] {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: PubmedArticle[] = [];

  for (const line of lines) {
    const pmidMatch = line.match(/PMID[:\s]+(\d+)/i);
    const doiMatch = line.match(/10\.\d{4,9}\/[\w.\-;()/:]+/i);
    if (!pmidMatch && !doiMatch) continue;

    const pmid = pmidMatch?.[1];
    const id = pmid ?? doiMatch?.[0] ?? `pubmed-${entries.length + 1}`;
    const url = pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      : `https://doi.org/${doiMatch?.[0]}`;

    entries.push({
      id,
      pmid,
      title: line.replace(/^[-*]\s*/, "").slice(0, 220),
      source: "PubMed MCP",
      url,
    });

    if (entries.length >= limit) break;
  }

  return entries;
}

async function fetchPubmedViaEutilsQuery(term: string, limit: number): Promise<PubmedArticle[]> {
  const search = await fetchJson<{
    esearchresult?: {
      idlist?: string[];
    };
  }>(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&sort=relevance&term=${encodeURIComponent(
      term,
    )}`,
  );

  const ids = search.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  const summary = await fetchJson<{
    result?: Record<
      string,
      {
        uid?: string;
        title?: string;
        fulljournalname?: string;
        pubdate?: string;
      }
    > & {
      uids?: string[];
    };
  }>(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`,
  );

  const table = summary.result ?? {};
  const rows: PubmedArticle[] = [];
  for (const id of ids) {
    const row = table[id];
    if (!row) continue;
    rows.push({
      id,
      pmid: id,
      title: (row.title ?? "Untitled article").slice(0, 220),
      source: row.fulljournalname ?? "PubMed",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      journal: row.fulljournalname,
      year: row.pubdate ? String(row.pubdate).slice(0, 4) : undefined,
    });
  }

  return rows.slice(0, limit);
}

export async function getPubmedArticles(
  disease: string,
  targetSymbol: string,
  limit = 5,
): Promise<PubmedArticle[]> {
  const normalizedDisease = disease.trim();
  const normalizedTarget = targetSymbol.trim().toUpperCase();
  const capped = Math.max(1, Math.min(10, limit));
  if (!normalizedDisease || !normalizedTarget) return [];

  const query = `${normalizedTarget}[Title/Abstract] AND ${normalizedDisease}[Title/Abstract]`;
  const cacheKey = `pair::${query.toLowerCase()}::${capped}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const parsed = await fetchPubmedViaMcpServer(query, capped);
    if (parsed.length > 0) {
      cache.set(cacheKey, parsed);
      return parsed;
    }
  } catch {
    // fall through to legacy MCP/eutils fallback
  }

  try {
    const raw = await mcp.callToolRaw("article_searcher", {
      diseases: [normalizedDisease],
      genes: [normalizedTarget],
      page_size: capped,
      include_preprints: false,
    });
    const parsed = parsePubmedLines(raw, capped);
    if (parsed.length > 0) {
      cache.set(cacheKey, parsed);
      return parsed;
    }
  } catch {
    // fall through to PubMed E-utilities
  }

  const fallback = await fetchPubmedViaEutilsQuery(query, capped);
  cache.set(cacheKey, fallback);
  return fallback;
}

export async function searchPubmedByQuery(
  query: string,
  limit = 5,
): Promise<PubmedArticle[]> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const capped = Math.max(1, Math.min(10, limit));
  if (!normalizedQuery) return [];

  const cacheKey = `query::${normalizedQuery.toLowerCase()}::${capped}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const parsed = await fetchPubmedViaMcpServer(normalizedQuery, capped);
    if (parsed.length > 0) {
      cache.set(cacheKey, parsed);
      return parsed;
    }
  } catch {
    // fall through to eutils fallback
  }

  const fallback = await fetchPubmedViaEutilsQuery(normalizedQuery, capped);
  cache.set(cacheKey, fallback);
  return fallback;
}
