/* eslint-disable @typescript-eslint/no-explicit-any */
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";
import { fetchJson } from "@/server/http";
import { McpClient } from "@/server/mcp/client";

export type ArticleSnippet = {
  id: string;
  title: string;
  source: string;
  url: string;
};

export type TrialSnippet = {
  id: string;
  title: string;
  source: string;
  url: string;
  status?: string;
};

const enrichmentCache = createTTLCache<
  string,
  {
    articles: ArticleSnippet[];
    trials: TrialSnippet[];
  }
>(appConfig.cache.ttlMs, appConfig.cache.maxEntries);

const mcp = new McpClient(appConfig.mcp.biomcp);

async function runBioMcpThink(context: string): Promise<void> {
  try {
    await mcp.callToolRaw(
      "think",
      {
        thought: context,
        thoughtNumber: 1,
        totalThoughts: 1,
        nextThoughtNeeded: false,
      },
      8_000,
    );
  } catch {
    // Non-blocking: BioMCP think tool is advisory for structured analysis.
  }
}

function parseMcpArticleLines(raw: string): ArticleSnippet[] {
  const lines = raw.split("\n").map((line) => line.trim());
  const snippets: ArticleSnippet[] = [];

  for (const line of lines) {
    const pmidMatch = line.match(/PMID[:\s]+(\d+)/i);
    const doiMatch = line.match(/10\.\d{4,9}\/[\w.\-;()/:]+/i);

    if (!pmidMatch && !doiMatch) continue;

    const id = pmidMatch?.[1] ?? doiMatch?.[0] ?? `article-${snippets.length + 1}`;
    const title = line.replace(/^[-*]\s*/, "").slice(0, 180);
    const url = pmidMatch
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmidMatch[1]}/`
      : `https://doi.org/${doiMatch?.[0]}`;

    snippets.push({
      id,
      title,
      source: "BioMCP",
      url,
    });

    if (snippets.length >= 5) break;
  }

  return snippets;
}

function parseMcpTrialLines(raw: string): TrialSnippet[] {
  const lines = raw.split("\n").map((line) => line.trim());
  const trials: TrialSnippet[] = [];

  for (const line of lines) {
    const match = line.match(/(NCT\d{8})/i);
    if (!match) continue;

    const id = match[1].toUpperCase();
    trials.push({
      id,
      title: line.replace(/^[-*]\s*/, "").slice(0, 180),
      source: "BioMCP",
      url: `https://clinicaltrials.gov/study/${id}`,
    });

    if (trials.length >= 5) break;
  }

  return trials;
}

export async function getLiteratureAndTrials(
  disease: string,
  targetSymbol: string,
  interventionHint?: string,
): Promise<{ articles: ArticleSnippet[]; trials: TrialSnippet[] }> {
  const cacheKey = `${disease.toLowerCase()}::${targetSymbol.toUpperCase()}::${
    interventionHint ?? ""
  }`;

  const cached = enrichmentCache.get(cacheKey);
  if (cached) return cached;

  await runBioMcpThink(
    `Plan BioMCP evidence search for ${disease} with target ${targetSymbol}${
      interventionHint ? ` and intervention ${interventionHint}` : ""
    }.`,
  );

  let articleResults: ArticleSnippet[] = [];
  let trialResults: TrialSnippet[] = [];

  try {
    const rawArticle = await mcp.callToolRaw("article_searcher", {
      diseases: [disease],
      genes: [targetSymbol],
      page_size: 5,
      include_preprints: false,
    });
    articleResults = parseMcpArticleLines(rawArticle);
  } catch {
    // fallback below
  }

  try {
    const rawTrial = await mcp.callToolRaw("trial_searcher", {
      conditions: [disease],
      interventions: interventionHint ? [interventionHint] : undefined,
      page_size: 5,
    });
    trialResults = parseMcpTrialLines(rawTrial);
  } catch {
    // fallback below
  }

  if (articleResults.length === 0) {
    const epmc = await fetchJson<any>(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(
        `${targetSymbol} ${disease}`,
      )}&format=json&pageSize=5&resultType=core`,
    );

    articleResults = (epmc?.resultList?.result ?? []).slice(0, 5).map((item: any) => ({
      id: item?.pmid ?? item?.doi ?? item?.id,
      title: item?.title ?? "Untitled article",
      source: item?.journalTitle ?? "Europe PMC",
      url: item?.pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/`
        : item?.doi
          ? `https://doi.org/${item.doi}`
          : "https://europepmc.org/",
    }));
  }

  if (trialResults.length === 0) {
    const ctgov = await fetchJson<any>(
      `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(
        `${disease} ${targetSymbol}`,
      )}&pageSize=5`,
    );

    trialResults = (ctgov?.studies ?? []).slice(0, 5).map((study: any) => ({
      id: study?.protocolSection?.identificationModule?.nctId ?? "Unknown",
      title: study?.protocolSection?.identificationModule?.briefTitle ?? "Untitled trial",
      source: "ClinicalTrials.gov",
      url: `https://clinicaltrials.gov/study/${study?.protocolSection?.identificationModule?.nctId ?? ""}`,
      status:
        study?.protocolSection?.statusModule?.overallStatus ??
        study?.protocolSection?.statusModule?.studyStatus,
    }));
  }

  const result = {
    articles: articleResults.slice(0, 5),
    trials: trialResults.slice(0, 5),
  };

  enrichmentCache.set(cacheKey, result);
  return result;
}
