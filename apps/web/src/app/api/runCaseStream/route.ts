import { NextRequest } from "next/server";
import type { GraphEdge, GraphNode, RankingResponse } from "@/lib/contracts";
import { makeEdgeId, makeNodeId } from "@/lib/graph";
import { buildEvidenceTable } from "@/components/targetgraph/evidence";
import { rankTargetsFallback } from "@/server/openai/ranking";
import { getDiseaseTargetsSummary, searchDiseases } from "@/server/mcp/opentargets";
import { findPathwaysByGene } from "@/server/mcp/reactome";
import { getInteractionNetwork } from "@/server/mcp/stringdb";
import {
  resolveQueryEntitiesBundle,
} from "@/server/agent/entity-resolution";
import {
  runDeepDiscoverer,
  type DiscoverJourneyEntry,
  type DiscovererFinal,
} from "@/server/agent/deep-discoverer";
import { extractRelationMentionsFast } from "@/server/agent/relation-mention-extractor";
import { type ResolvedQueryPlan } from "@/server/agent/query-plan";
import { type DiseaseCandidate } from "@/server/openai/disease-resolver";
import {
  endRequestLog,
  errorRequestLog,
  startRequestLog,
  stepRequestLog,
  warnRequestLog,
} from "@/server/telemetry";
import {
  beginOpenAiRun,
  getOpenAiRunSummary,
  withOpenAiOperationContext,
  withOpenAiRunContext,
} from "@/server/openai/cost-tracker";
import { appConfig } from "@/server/config";
import {
  createTrackedOpenAIClient,
  withOpenAiApiKeyContext,
} from "@/server/openai/client";

export const runtime = "nodejs";

type RunMode = "multihop";

type SourceHealth = Record<string, "green" | "yellow" | "red">;

type EnrichmentSnippet = {
  id?: unknown;
  title?: unknown;
  source?: unknown;
  url?: unknown;
  status?: unknown;
};

type EnrichmentLinksByNodeId = Record<
  string,
  {
    articles: EnrichmentSnippet[];
    trials: EnrichmentSnippet[];
  }
>;

type CaseStatusEvent = {
  phase: string;
  message: string;
  pct: number;
  elapsedMs: number;
  counts: Record<string, number>;
  sourceHealth: SourceHealth;
  partial?: boolean;
};

type GraphPatchEvent = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
};

const encoder = new TextEncoder();
const diseaseIdPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;
const DISEASE_SEARCH_TIMEOUT_MS = 20_000;
const BUNDLED_RESOLUTION_TIMEOUT_MS = 120_000;
const INTERNAL_STREAM_CONNECT_TIMEOUT_MS = 35_000;
const SESSION_RUN_STALE_MS = 15 * 60 * 1000;
const SESSION_API_KEY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_JOURNEY_EVENTS = 300;
const DISCOVERER_TIMEOUT_MS = Math.max(
  10 * 60 * 1000,
  appConfig.deepDiscover.maxRunMs + 30_000,
);
const FALLBACK_SYNTHESIS_TIMEOUT_MS = 180_000;
const FINAL_GROUNDING_TIMEOUT_MS = 180_000;

type FinalBriefSnapshot = {
  recommendation?: {
    target?: string;
    pathway?: string;
    drugHook?: string;
    why?: string;
    score?: number;
    interactionHook?: string;
  } | null;
  alternatives?: Array<{
    symbol?: string;
    score?: number;
    reason?: string;
    caveat?: string;
  }>;
  caveats?: string[];
  citations?: Array<{
    index: number;
    kind: "article" | "trial" | "metric";
    label: string;
    source: string;
    url?: string;
  }>;
  evidenceSummary?: {
    targetsWithEvidence?: number;
    articleSnippets?: number;
    trialSnippets?: number;
  };
};

type SupplementalEvidenceCitation = {
  kind: "article" | "trial";
  label: string;
  source: string;
  url?: string;
};

type SupplementalEvidenceAccumulator = {
  articleSnippets: number;
  trialSnippets: number;
  citations: SupplementalEvidenceCitation[];
  citationKeys: Set<string>;
};

type ActiveSessionRun = {
  runId: string;
  sessionKey: string;
  startedAt: number;
  abortController: AbortController;
};

type SessionApiKeyState = {
  apiKey: string;
  updatedAt: number;
};

const activeSessionRuns = new Map<string, ActiveSessionRun>();
const sessionApiKeys = new Map<string, SessionApiKeyState>();

function normalizeApiKey(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!/^sk-[A-Za-z0-9._-]{12,}$/.test(value)) return null;
  return value;
}

function setSessionApiKey(sessionKey: string, apiKey: string): void {
  sessionApiKeys.set(sessionKey, {
    apiKey,
    updatedAt: Date.now(),
  });
}

function clearSessionApiKey(sessionKey: string): void {
  sessionApiKeys.delete(sessionKey);
}

function resolveSessionApiKey(sessionKey: string): string | undefined {
  const row = sessionApiKeys.get(sessionKey);
  if (!row) return undefined;
  if (Date.now() - row.updatedAt > SESSION_API_KEY_TTL_MS) {
    sessionApiKeys.delete(sessionKey);
    return undefined;
  }
  row.updatedAt = Date.now();
  return row.apiKey;
}

async function readPostedApiKey(request: NextRequest): Promise<string | null> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const payload = (await request.json()) as { apiKey?: unknown };
      if (typeof payload?.apiKey === "string") {
        return payload.apiKey;
      }
    } catch {
      return null;
    }
    return null;
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const formData = await request.formData();
      const value = formData.get("apiKey");
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  return request.nextUrl.searchParams.get("apiKey");
}

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function modeConfig() {
  return {
    maxTargets: 20,
    pathways: 1,
    drugs: 1,
    interactions: 1,
    literature: 1,
  };
}

function resolveSessionKey(request: NextRequest, explicitSessionId?: string | null): string {
  const explicit = explicitSessionId?.trim();
  if (explicit) return `session:${explicit}`;

  const cookieSession = request.cookies.get("targetgraph_session_id")?.value?.trim();
  if (cookieSession) return `cookie:${cookieSession}`;

  const forwarded =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const userAgent = (request.headers.get("user-agent") ?? "ua").slice(0, 64);
  return `anon:${forwarded}:${userAgent}`;
}

function cleanupStaleSessionRuns(now = Date.now()) {
  for (const [sessionKey, run] of activeSessionRuns.entries()) {
    if (now - run.startedAt > SESSION_RUN_STALE_MS) {
      run.abortController.abort("stale session run");
      activeSessionRuns.delete(sessionKey);
    }
  }
  for (const [sessionKey, keyState] of sessionApiKeys.entries()) {
    if (now - keyState.updatedAt > SESSION_API_KEY_TTL_MS) {
      sessionApiKeys.delete(sessionKey);
    }
  }
}

function clearSessionRunLock(sessionKey: string, runId: string) {
  const current = activeSessionRuns.get(sessionKey);
  if (current && current.runId === runId) {
    activeSessionRuns.delete(sessionKey);
  }
}

function candidateInternalOrigins(request: NextRequest): string[] {
  const origins = new Set<string>();
  if (request.nextUrl.origin) {
    origins.add(request.nextUrl.origin);
  }

  try {
    const parsed = new URL(request.url);
    if (parsed.origin) origins.add(parsed.origin);
  } catch {
    // no-op
  }

  const protocol = request.nextUrl.protocol || "http:";
  const port = request.nextUrl.port || (protocol === "https:" ? "443" : "80");
  if (port) {
    origins.add(`${protocol}//127.0.0.1:${port}`);
    origins.add(`${protocol}//localhost:${port}`);
  }

  return [...origins];
}

async function fetchInternalStream(
  request: NextRequest,
  pathWithQuery: string,
  externalSignal?: AbortSignal,
  apiKeyOverride?: string,
): Promise<{ response: Response; origin: string }> {
  let lastError: unknown = new Error("streamGraph unavailable");
  const origins = candidateInternalOrigins(request);

  for (const origin of origins) {
    if (externalSignal?.aborted) {
      throw new Error("client disconnected");
    }
    const url = new URL(pathWithQuery, origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("connect timeout"), INTERNAL_STREAM_CONNECT_TIMEOUT_MS);
    const onAbort = () => controller.abort("client disconnected");
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "text/event-stream",
          ...(apiKeyOverride
            ? {
                "x-targetgraph-api-key": apiKeyOverride,
              }
            : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`streamGraph unavailable: ${response.status}`);
      }
      return { response, origin };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("streamGraph unavailable");
}

function mapBaselineProgress(rawPct: number): number {
  const clamped = Math.max(0, Math.min(100, Number(rawPct) || 0));
  return Math.max(2, Math.min(84, Math.round((clamped / 100) * 84)));
}

function compactText(value: string, max = 110): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function querySyntheticDiseaseId(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 58);
  return `QUERY_${slug || "unknown"}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function cleanAnswerMarkdown(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function expandInlineCitationRanges(text: string): string {
  return text.replace(/\[(\d{1,3})\s*[–-]\s*(\d{1,3})\]/g, (_full, leftRaw, rightRaw) => {
    const left = Number(leftRaw);
    const right = Number(rightRaw);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return _full;
    }
    const start = Math.min(left, right);
    const end = Math.max(left, right);
    if (end - start > 12) {
      return _full;
    }
    return Array.from({ length: end - start + 1 }, (_, index) => `[${start + index}]`).join("");
  });
}

function normalizeAnswerEnding(text: string): string {
  const normalized = cleanAnswerMarkdown(expandInlineCitationRanges(text));
  if (!normalized) return normalized;
  if (/[.!?](?:\s*\[\d+\])*\s*$/.test(normalized)) {
    return normalized;
  }
  return `${normalized}.`;
}

function hasInlineCitationMarker(text: string): boolean {
  return /\[\d+\]/.test(text);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ").trim()}...`;
}

function capUncertaintySection(
  text: string,
  options?: { maxBullets?: number; maxWords?: number },
): string {
  const maxBullets = Math.max(1, Math.min(5, options?.maxBullets ?? 3));
  const maxWords = Math.max(20, Math.min(160, options?.maxWords ?? 72));
  const marker = /###\s*What remains uncertain/i;
  const match = marker.exec(text);
  if (!match) return text;

  const sectionStart = match.index;
  const before = text.slice(0, sectionStart).trimEnd();
  const heading = text.slice(sectionStart, sectionStart + match[0].length);
  const afterHeading = text.slice(sectionStart + match[0].length).trimStart();
  const lines = afterHeading
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return `${before}\n\n${heading}`;

  const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line));
  const selectedBullets = bulletLines.slice(0, maxBullets).map((line) => {
    const bulletBody = line.replace(/^[-*]\s+/, "");
    return `- ${truncateWords(bulletBody, 26)}`;
  });

  if (selectedBullets.length > 0) {
    return `${before}\n\n${heading}\n${selectedBullets.join("\n")}`.trim();
  }

  return `${before}\n\n${heading}\n${truncateWords(lines.join(" "), maxWords)}`.trim();
}

function queryTokensForCitationRanking(query: string): string[] {
  const stop = new Set([
    "what",
    "which",
    "how",
    "why",
    "is",
    "are",
    "the",
    "and",
    "for",
    "with",
    "between",
    "connect",
    "connected",
    "affect",
    "affecting",
    "effect",
    "effects",
    "via",
    "through",
    "into",
    "from",
    "of",
    "to",
    "in",
    "on",
  ]);
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !stop.has(item));
}

function prioritizeCitationsForGrounding(
  citations: NonNullable<FinalBriefSnapshot["citations"]>,
  query: string,
  limit = 28,
): NonNullable<FinalBriefSnapshot["citations"]> {
  if (citations.length <= limit) return citations;
  const tokens = queryTokensForCitationRanking(query);
  const scored = citations
    .map((citation, index) => {
      const label = normalizeCitationText(citation.label, "").toLowerCase();
      const source = normalizeCitationText(citation.source, "").toLowerCase();
      const url = normalizeCitationText(citation.url, "").toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (label.includes(token)) score += 3;
        if (source.includes(token)) score += 1;
      }
      if (citation.kind === "article") score += 1.5;
      if (citation.kind === "trial") score += 1.3;
      if (source.includes("pubmed") || url.includes("pubmed")) score += 1.5;
      if (source.includes("clinicaltrials") || url.includes("clinicaltrials")) score += 1.3;
      if (/:\s*(pmid|doi)\b/i.test(citation.label)) score -= 2.1;
      if (label.length < 12) score -= 0.8;
      return {
        citation,
        score,
        index,
      };
    })
    .sort((left, right) => {
      const delta = right.score - left.score;
      if (Math.abs(delta) > 0.0001) return delta;
      return left.index - right.index;
    });

  const picked = scored.slice(0, limit).map((row) => row.citation);
  const pickedIndices = new Set(picked.map((item) => item.index));
  for (const citation of citations) {
    if (picked.length >= limit) break;
    if (pickedIndices.has(citation.index)) continue;
    picked.push(citation);
    pickedIndices.add(citation.index);
  }
  return picked;
}

function ensureInlineCitations(text: string, citations: NonNullable<FinalBriefSnapshot["citations"]>): string {
  const normalized = capUncertaintySection(normalizeAnswerEnding(text));
  if (!normalized) return normalized;
  if (hasInlineCitationMarker(normalized)) return normalized;
  const refs = citations
    .slice(0, 6)
    .map((item) => `[${item.index}]`);
  if (refs.length === 0) return normalized;
  return `${normalized}\n\nSupporting references: ${refs.join(", ")}`;
}

function buildGraphPathContext(input: {
  pathUpdate: DerivedPathUpdate | null;
  nodeMap: Map<string, GraphNode>;
  edgeMap: Map<string, GraphEdge>;
}) {
  if (!input.pathUpdate) return null;
  const nodeLabels = input.pathUpdate.nodeIds
    .map((nodeId) => input.nodeMap.get(nodeId)?.label ?? nodeId)
    .filter((value) => value.trim().length > 0);
  const edgeTrail = input.pathUpdate.edgeIds
    .map((edgeId) => input.edgeMap.get(edgeId))
    .filter((edge): edge is GraphEdge => Boolean(edge))
    .map((edge) => ({
      source: input.nodeMap.get(edge.source)?.label ?? edge.source,
      target: input.nodeMap.get(edge.target)?.label ?? edge.target,
      type: edge.type,
      sourceTag: typeof edge.meta.source === "string" ? edge.meta.source : null,
      status: typeof edge.meta.status === "string" ? edge.meta.status : null,
      weight: edge.weight ?? null,
    }));

  return {
    summary: input.pathUpdate.summary,
    nodeLabels: [...new Set(nodeLabels)],
    edgeTrail,
    connectedAcrossAnchors: Boolean(input.pathUpdate.connectedAcrossAnchors),
    unresolvedAnchorPairs: input.pathUpdate.unresolvedAnchorPairs ?? [],
  };
}

async function groundFinalAnswerWithInlineCitations(input: {
  query: string;
  draft: DiscovererFinal;
  brief: FinalBriefSnapshot;
  activePathSummary: string | null;
  graphPathContext?: ReturnType<typeof buildGraphPathContext> | null;
  queryPlan?: ResolvedQueryPlan | null;
}): Promise<DiscovererFinal> {
  const synthesisClient = createTrackedOpenAIClient();
  const citations = prioritizeCitationsForGrounding(input.brief.citations ?? [], input.query, 32);
  if (!synthesisClient || citations.length === 0) {
    return {
      ...input.draft,
      answer: ensureInlineCitations(input.draft.answer, citations),
    };
  }

  try {
    const response = await withOpenAiOperationContext(
      "run_case.inline_citation_grounding",
      () =>
        withTimeout(
          synthesisClient.responses.create({
            model: appConfig.openai.smallModel,
            reasoning: { effort: "minimal" },
            max_output_tokens: 1280,
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: [
                      "Rewrite the biomedical answer to be strictly evidence-grounded.",
                      "Use only claims supported by the provided evidence snapshot and citation ledger.",
                      "The first paragraph must answer the user question directly in concrete biomedical terms.",
                      "Prioritize the graph-supported mechanism path as the primary answer thread when a path context is provided.",
                      "Do not assert a primary mechanism hop that is absent from the provided graph path edge trail.",
                      "Do not treat association scores, pathway annotations, or druggability hooks alone as causal evidence.",
                      "If the mapped evidence does not provide a complete end-to-end path between the query entities, state that the link remains incomplete.",
                      "Insert inline numeric citation markers like [12] directly after factual claims.",
                      "Do not use citation ranges like [6-10] or [6–10]; cite each number explicitly as [6][7][8][9][10].",
                      "Use only citation indices present in the ledger; do not invent citation numbers.",
                      "Use markdown headings in this order: '### Direct answer', '### Mechanistic support', '### What remains uncertain'.",
                      "Target a final length of roughly 200-300 words.",
                      "Under '### Mechanistic support' include concrete mechanism bullets tied to evidence with citations.",
                      "Under '### What remains uncertain' list unresolved links, missing data, and contradictory signals, but keep this concise.",
                      "Allocate uncertainty to at most 10% of total answer length.",
                      "If uncertainty remains, state it explicitly and specifically.",
                      "End with a complete sentence; do not stop mid-sentence.",
                      "Do not expose internal field names in prose (for example connectedAcrossAnchors or graphPathContext).",
                      "Do not mention internal workflow words (bridge, branch, planner, pipeline, run status).",
                      "Avoid meta phrasing such as 'this dataset' or 'provided evidence snapshot'; answer directly in biomedical language.",
                      "Keep the answer substantive, scientifically rigorous, and mechanistic (target/pathway/intermediate hops).",
                      "Return markdown text only.",
                    ].join(" "),
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: JSON.stringify(
                      {
                        query: input.query,
                        draftAnswer: input.draft.answer,
                        focusThread: input.draft.focusThread,
                        keyFindings: input.draft.keyFindings.slice(0, 6),
                        caveats: input.draft.caveats.slice(0, 4),
                        activePathSummary: input.activePathSummary,
                        graphPathContext: input.graphPathContext ?? null,
                        recommendation: input.brief.recommendation ?? null,
                        evidenceSummary: input.brief.evidenceSummary ?? null,
                        queryAnchors: (input.queryPlan?.anchors ?? []).slice(0, 8).map((row) => ({
                          mention: row.mention,
                          entityType: row.entityType,
                          id: row.id,
                          name: row.name,
                        })),
                        citations: citations.map((row) => ({
                          index: row.index,
                          kind: row.kind,
                          label: compactText(row.label, 140),
                          source: row.source,
                        })),
                      },
                      null,
                      2,
                    ),
                  },
                ],
              },
            ],
          }),
          FINAL_GROUNDING_TIMEOUT_MS,
        ),
    );

    const grounded = normalizeAnswerEnding(String(response.output_text ?? ""));
    if (!grounded) {
      return {
        ...input.draft,
        answer: ensureInlineCitations(input.draft.answer, citations),
      };
    }

    return {
      ...input.draft,
      answer: ensureInlineCitations(grounded, citations),
    };
  } catch {
    return {
      ...input.draft,
      answer: ensureInlineCitations(input.draft.answer, citations),
    };
  }
}

async function synthesizeFallbackFinalAnswer(input: {
  query: string;
  selectedDiseaseName: string;
  activePathSummary: string | null;
  brief: FinalBriefSnapshot;
}): Promise<DiscovererFinal | null> {
  const synthesisClient = createTrackedOpenAIClient();
  if (!synthesisClient) return null;

  const recommendation = input.brief.recommendation ?? null;
  const focusPathway = recommendation?.pathway?.trim() || input.activePathSummary || "not provided";
  const focusTarget = recommendation?.target?.trim() || "not provided";
  const focusDrug = recommendation?.drugHook?.trim() || "not provided";
  const prioritizedCitations = prioritizeCitationsForGrounding(
    input.brief.citations ?? [],
    input.query,
    28,
  );
  const citationCount = Array.isArray(input.brief.citations) ? input.brief.citations.length : 0;
  const evidenceSummary = input.brief.evidenceSummary ?? {};

  try {
    const response = await withOpenAiOperationContext(
      "run_case.fallback_final_synthesis",
      () =>
        withTimeout(
          synthesisClient.responses.create({
            model: appConfig.openai.smallModel,
            reasoning: { effort: "minimal" },
            max_output_tokens: 1200,
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: [
                      "You are a biomedical synthesis assistant.",
                      "Write the final user-facing scientific answer from the evidence snapshot.",
                      "Use markdown headings in this order: '### Direct answer', '### Mechanistic support', '### What remains uncertain'.",
                      "Start with a direct answer sentence to the query under '### Direct answer'.",
                      "Write a substantive summary (~180-280 words), not a one-liner.",
                      "Use concrete biomedical entities and mechanism hops when available.",
                      "Under '### Mechanistic support', include evidence-grounded bullets with entities and intermediates.",
                      "Do not present association scores, pathway hooks, or druggability hooks as causal proof on their own.",
                      "Under '### What remains uncertain', include unresolved links and missing evidence; keep this section concise (at most 10% of the answer).",
                      "Do not use citation ranges like [6-10] or [6–10]; cite each number explicitly as [6][7][8][9][10].",
                      "End with a complete sentence.",
                      "Do not include references section headings; keep only the answer body.",
                      "Do not echo JSON field names (for example activePathSummary or recommendation).",
                      "Do not mention workflow internals (bridge, branch, planner, pipeline, run status).",
                      "Avoid meta phrasing such as 'this dataset' or 'provided evidence snapshot'; answer directly in biomedical language.",
                      "Do not fabricate claims.",
                    ].join(" "),
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: JSON.stringify(
                      {
                        query: input.query,
                        selectedDisease: input.selectedDiseaseName,
                        activePathSummary: input.activePathSummary,
                        recommendation,
                        alternatives: (input.brief.alternatives ?? []).slice(0, 3),
                        caveats: (input.brief.caveats ?? []).slice(0, 4),
                        evidenceSummary: {
                          targetsWithEvidence: evidenceSummary.targetsWithEvidence ?? null,
                          articleSnippets: evidenceSummary.articleSnippets ?? null,
                          trialSnippets: evidenceSummary.trialSnippets ?? null,
                          citationCount,
                        },
                        citationPreview: prioritizedCitations.slice(0, 10).map((item) => ({
                          index: item.index,
                          kind: item.kind,
                          label: item.label,
                          source: item.source,
                        })),
                      },
                      null,
                      2,
                    ),
                  },
                ],
              },
            ],
          }),
          FALLBACK_SYNTHESIS_TIMEOUT_MS,
        ),
    );

    const answer = capUncertaintySection(normalizeAnswerEnding(String(response.output_text ?? "")));
    if (!answer) return null;
    const keyFindings = [
      recommendation?.why?.trim() || "",
      recommendation?.interactionHook?.trim() || "",
      `Citations mapped: ${citationCount}`,
    ].filter(Boolean).slice(0, 6);
    const caveats = (input.brief.caveats ?? [])
      .map((row) => String(row ?? "").trim())
      .filter(Boolean)
      .slice(0, 4);
    const nextActions = [
      "Prioritize validation experiments on the strongest thread.",
      "Test whether the proposed mechanism is reproduced across independent cohorts.",
      "Review high-confidence citations and contradictory signals before actioning.",
    ];

    return {
      answer,
      biomedicalCase: {
        title: `${compactText(input.query, 86)}: fallback synthesis`,
        whyAgentic:
          "Generated from streamed MCP evidence, ranked mechanism threads, and citation snapshot.",
      },
      focusThread: {
        pathway: focusPathway,
        target: focusTarget,
        drug: focusDrug,
      },
      keyFindings:
        keyFindings.length > 0
          ? keyFindings
          : [
              `Top target: ${focusTarget}`,
              `Lead pathway context: ${focusPathway}`,
              `Citations mapped: ${citationCount}`,
            ],
      caveats:
        caveats.length > 0
          ? caveats
          : ["Evidence is preclinical and should be interpreted as hypothesis-supporting."],
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ["Prioritize validation experiments on the highest-confidence mechanism thread."],
    };
  } catch {
    return null;
  }
}

function extractDiseasePhrase(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimDiseaseNoise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeDiseaseText(value: string): string[] {
  return trimDiseaseNoise(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function tokenSetOverlapScore(left: string, right: string): number {
  const leftTokens = tokenizeDiseaseText(left);
  const rightTokens = tokenizeDiseaseText(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token)).length;
  if (shared === 0) return 0;
  const precision = shared / Math.max(1, leftTokens.length);
  const recall = shared / Math.max(1, rightTokens.length);
  return (2 * precision * recall) / Math.max(0.001, precision + recall);
}

function scoreDiseaseCandidate(query: string, candidate: DiseaseCandidate): number {
  const queryNorm = trimDiseaseNoise(query);
  const candidateNorm = trimDiseaseNoise(candidate.name);
  if (!queryNorm || !candidateNorm) return -2;

  let score = 0;
  if (queryNorm === candidateNorm) score += 6.5;
  if (queryNorm.includes(candidateNorm)) score += 2.2;
  if (candidateNorm.includes(queryNorm) && queryNorm.length >= 4) score += 1.4;
  score += tokenSetOverlapScore(queryNorm, candidateNorm) * 4.2;

  const queryTokens = new Set(tokenizeDiseaseText(queryNorm));
  const candidateTokens = tokenizeDiseaseText(candidateNorm);
  const unmatched = candidateTokens.filter((token) => !queryTokens.has(token)).length;
  score -= unmatched * 0.45;

  if (/^(EFO|MONDO|DOID|ORPHANET)_/i.test(candidate.id)) score += 0.5;
  if (/^HP_/i.test(candidate.id)) score -= 0.3;
  return score;
}

function rerankDiseaseCandidates(query: string, candidates: DiseaseCandidate[], limit = 14): DiseaseCandidate[] {
  const ranked = rankDiseaseCandidates(query, candidates, limit);
  return ranked.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
  }));
}

function rankDiseaseCandidates(
  query: string,
  candidates: DiseaseCandidate[],
  limit = 14,
): Array<DiseaseCandidate & { score: number }> {
  return candidates
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      score: scoreDiseaseCandidate(query, item),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function extractDiseaseAnchorMentions(query: string): string[] {
  const normalized = trimDiseaseNoise(query);
  if (!normalized) return [];

  const mentions = new Set<string>();
  const isGenericMechanismMention = (value: string): boolean => {
    const normalizedValue = trimDiseaseNoise(value);
    if (!normalizedValue) return false;
    const tokens = normalizedValue.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 4) return false;
    const hasDiseaseCue = /\b(?:disease|disorder|syndrome|cancer|carcinoma|tumou?r|diabetes|obesity|lupus|arthritis|sclerosis|colitis|asthma|fibrosis|infection|infarction)\b/i.test(
      normalizedValue,
    );
    if (hasDiseaseCue) return false;
    const hasSymbolLikeToken = tokens.some((token) => /^[a-z]{1,6}\d{1,3}[a-z]?$/i.test(token.replace(/-/g, "")));
    if (hasSymbolLikeToken) return false;
    const genericTokens = tokens.filter((token) =>
      /^(?:inflammatory|immune|metabolic|cellular|molecular|inflammation|signaling|signal|pathway|pathways|mechanism|mechanistic|network|cascade|axis|events?)$/i.test(
        token,
      ),
    ).length;
    if (genericTokens === tokens.length) return true;
    return (
      genericTokens >= Math.max(1, tokens.length - 1) &&
      /\b(?:signaling|signal|pathway|pathways|mechanism|mechanistic|network|cascade|axis|events?)\b/i.test(
        normalizedValue,
      )
    );
  };
  const normalizeMention = (value: string) =>
    trimDiseaseNoise(value)
      .replace(/^(?:through|via|by|using)\s+/i, "")
      .replace(/^(?:how|what|which|why)\s+(?:might|may|does|do|did|is|are|can|could|would|will|should)\s+/i, "")
      .replace(/^(?:how|what|which|why)\s+/i, "")
      .replace(/^(?:might|may|does|do|did|is|are|can|could|would|will|should)\s+/i, "")
      .replace(/^(?:the|a|an)\s+/i, "")
      .trim();
  const normalizeMentionParts = (value: string): string[] => {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    const parts = raw
      .split(/\s*,\s*|\s+(?:and|&)\s+/i)
      .map((item) => normalizeMention(item))
      .filter(Boolean);
    if (parts.length > 1) return parts;
    const single = normalizeMention(raw);
    return single ? [single] : [];
  };
  const addMention = (value: string) => {
    for (const mention of normalizeMentionParts(String(value ?? ""))) {
      if (mention.length < 3) continue;
      if (mention.split(/\s+/).filter(Boolean).length > 6) continue;
      if (isGenericMechanismMention(mention)) continue;
      mentions.add(mention);
    }
  };

  const betweenMatch = normalized.match(
    /\bbetween\s+(.+?)\s+and\s+(.+?)(?:\s+(?:through|via|with|using)\s+.+)?$/,
  );
  if (betweenMatch) {
    addMention(String(betweenMatch[1] ?? ""));
    addMention(String(betweenMatch[2] ?? ""));
  }

  const connectPatterns = [
    /(.+?)\s+connect(?:ion|ed|s)?\s+(?:to|with|and)\s+(.+?)(?:\s+(?:through|via|using)\s+.+)?$/i,
    /\bconnect(?:ion|ed|s)?\s+(?:between\s+)?(.+?)\s+(?:to|with|and|vs|versus)\s+(.+?)(?:\s+(?:through|via|using)\s+.+)?$/i,
    /\b(.+?)\s+(?:vs|versus)\s+(.+?)$/i,
  ] as const;
  for (const pattern of connectPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    addMention(String(match[1] ?? ""));
    addMention(String(match[2] ?? ""));
  }

  const causalPatterns = [
    /\b(.+?)\s+(?:lead|leads|leading|drives?|driven|contributes?|causes?|triggers?|promotes?|predisposes?)\s+(?:to\s+)?(.+?)(?:\s+(?:through|via|using|with|by)\s+(.+))?$/i,
    /\b(.+?)\s+(?:results?\s+in|linked\s+to|associated\s+with|correlat(?:ed|es?|ion)\s+with)\s+(.+?)(?:\s+(?:through|via|using|with|by)\s+(.+))?$/i,
  ] as const;
  for (const pattern of causalPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    addMention(String(match[1] ?? ""));
    addMention(String(match[2] ?? ""));
    addMention(String(match[3] ?? ""));
  }

  return [...mentions].slice(0, 4);
}

function allowWholeQueryDiseaseSearch(query: string): boolean {
  const normalized = trimDiseaseNoise(query);
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  if (tokenCount === 0) return false;
  if (tokenCount > 5) return false;
  const relationPattern = /\bbetween\b|\bconnect(?:ion)?\b|\brelationship\b|\blink\b|\boverlap\b|\bvs\b|\bversus\b/i;
  if (relationPattern.test(normalized) && tokenCount > 3) return false;
  return true;
}

function pickLiteralDiseaseCandidate(query: string, candidates: DiseaseCandidate[]): DiseaseCandidate | null {
  const scored = rankDiseaseCandidates(query, candidates, 14);
  const top = scored[0];
  if (!top) return null;
  if (top.score < 1.6) return null;
  return {
    id: top.id,
    name: top.name,
    description: top.description,
  };
}

function toDiseaseCandidates(
  rows: Awaited<ReturnType<typeof searchDiseases>>,
): DiseaseCandidate[] {
  const isMeasurementLike = (name: string, description?: string) => {
    const text = `${name} ${description ?? ""}`.toLowerCase();
    return (
      text.includes("measurement") ||
      text.includes("quantification") ||
      text.includes("metabolite ratio") ||
      text.includes("in a sample") ||
      text.includes("concentration")
    );
  };

  return rows
    .filter((item) => diseaseIdPattern.test(item.id))
    .filter((item) => !isMeasurementLike(item.name, item.description))
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
    }));
}

function mergeDiseaseCandidates(primary: DiseaseCandidate[], secondary: DiseaseCandidate[]) {
  const merged = new Map<string, DiseaseCandidate>();
  for (const item of [...primary, ...secondary]) {
    if (!merged.has(item.id)) {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchDiseaseCandidates(
  searchQuery: string,
  limit = 12,
  retries = 1,
): Promise<DiseaseCandidate[]> {
  const normalized = searchQuery.trim();
  if (!normalized) return [];

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const rows = await withTimeout(
      searchDiseases(normalized, limit).then((items) => toDiseaseCandidates(items)),
      DISEASE_SEARCH_TIMEOUT_MS,
    ).catch(() => []);
    if (rows.length > 0) return rows;
    if (attempt < retries) {
      await sleep(140 * (attempt + 1));
    }
  }

  return [];
}

type MentionAnchoredDisease = {
  mention: string;
  disease: DiseaseCandidate;
  score: number;
};

async function resolveMentionAnchoredDiseases(
  mentions: string[],
  limit = 3,
): Promise<MentionAnchoredDisease[]> {
  const ordered: MentionAnchoredDisease[] = [];
  const seen = new Set<string>();

  for (const mentionRaw of mentions) {
    const mention = trimDiseaseNoise(mentionRaw);
    if (mention.length < 3) continue;
    const mentionVariants = [...new Set([
      mention,
      mention.replace(/'/g, ""),
      mention.split(/\s+/).length === 1 && mention.length >= 5
        ? mention.replace(/s$/i, "")
        : "",
      /^[a-z0-9+\-]{2,10}$/i.test(mention) ? mention.toUpperCase() : "",
    ])]
      .map((value) => trimDiseaseNoise(value))
      .filter((value) => value.length >= 3)
      .slice(0, 4);

    let rows: DiseaseCandidate[] = [];
    for (const variant of mentionVariants) {
      const variantRows = await searchDiseaseCandidates(variant, 10, 1).catch(() => []);
      rows = mergeDiseaseCandidates(rows, variantRows);
      if (rows.length >= 10) break;
    }
    if (rows.length === 0) continue;
    const ranked = rankDiseaseCandidates(mention, rows, 6);
    const top = ranked[0];
    if (!top) continue;
    const mentionTokenCount = mention.split(/\s+/).filter(Boolean).length;
    const minimumScore = mentionTokenCount <= 1 ? 1.15 : 1.35;
    if (top.score < minimumScore) continue;
    if (seen.has(top.id)) continue;
    seen.add(top.id);
    ordered.push({
      mention,
      disease: {
        id: top.id,
        name: top.name,
        description: top.description,
      },
      score: top.score,
    });
    if (ordered.length >= limit) break;
  }

  return ordered;
}

type DerivedPathUpdate = {
  nodeIds: string[];
  edgeIds: string[];
  summary: string;
  connectedAcrossAnchors?: boolean;
  unresolvedAnchorPairs?: string[];
};

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isQueryProxyEdge(edge: GraphEdge): boolean {
  if (edge.type !== "disease_disease") return false;
  const source = String(edge.meta.source ?? "").toLowerCase();
  return source === "query_anchor" || source === "query_gap";
}

function buildGraphAdjacency(
  edges: GraphEdge[],
  options: { allowQueryProxyEdges: boolean },
): Map<string, Array<{ nodeId: string; edgeId: string }>> {
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>();
  for (const edge of edges) {
    if (!options.allowQueryProxyEdges && isQueryProxyEdge(edge)) continue;
    const left = adjacency.get(edge.source) ?? [];
    left.push({ nodeId: edge.target, edgeId: edge.id });
    adjacency.set(edge.source, left);
    const right = adjacency.get(edge.target) ?? [];
    right.push({ nodeId: edge.source, edgeId: edge.id });
    adjacency.set(edge.target, right);
  }
  return adjacency;
}

function findShortestGraphPath(
  startNodeId: string,
  endNodeId: string,
  edges: GraphEdge[],
  options: { allowQueryProxyEdges: boolean },
): { nodeIds: string[]; edgeIds: string[] } | null {
  if (startNodeId === endNodeId) {
    return { nodeIds: [startNodeId], edgeIds: [] };
  }

  const adjacency = buildGraphAdjacency(edges, options);
  const queue: string[] = [startNodeId];
  const visited = new Set<string>([startNodeId]);
  const parent = new Map<string, { nodeId: string; edgeId: string }>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const neighbors = adjacency.get(current) ?? [];
    for (const next of neighbors) {
      if (visited.has(next.nodeId)) continue;
      visited.add(next.nodeId);
      parent.set(next.nodeId, { nodeId: current, edgeId: next.edgeId });
      if (next.nodeId === endNodeId) {
        const nodeIds: string[] = [endNodeId];
        const edgeIds: string[] = [];
        let cursor = endNodeId;
        while (cursor !== startNodeId) {
          const step = parent.get(cursor);
          if (!step) break;
          edgeIds.push(step.edgeId);
          nodeIds.push(step.nodeId);
          cursor = step.nodeId;
        }
        return {
          nodeIds: nodeIds.reverse(),
          edgeIds: edgeIds.reverse(),
        };
      }
      queue.push(next.nodeId);
    }
  }

  return null;
}

function resolveAnchorNodeId(
  anchor: ResolvedQueryPlan["anchors"][number],
  nodeMap: Map<string, GraphNode>,
): string | null {
  const preferredType: GraphNode["type"] =
    anchor.entityType === "target"
      ? "target"
      : anchor.entityType === "drug"
        ? "drug"
        : "disease";
  const exactCandidates = [
    makeNodeId(preferredType, anchor.id),
    anchor.entityType === "target" ? makeNodeId("target", anchor.name.toUpperCase()) : null,
    anchor.entityType === "drug" ? makeNodeId("drug", anchor.name.toUpperCase()) : null,
  ].filter((value): value is string => Boolean(value));
  for (const candidateId of exactCandidates) {
    if (nodeMap.has(candidateId)) return candidateId;
  }

  const mentionNorm = normalizeForMatch(anchor.mention ?? "");
  const nameNorm = normalizeForMatch(anchor.name);
  const idNorm = normalizeForMatch(anchor.id);
  const queryTokens = new Set(
    [mentionNorm, nameNorm, idNorm]
      .flatMap((value) => value.split(/\s+/).filter(Boolean))
      .filter((value) => value.length > 1),
  );
  let best: { nodeId: string; score: number } | null = null;
  for (const node of nodeMap.values()) {
    if (node.type !== preferredType) continue;
    const candidates = [
      normalizeForMatch(node.label),
      normalizeForMatch(String(node.meta.displayName ?? "")),
      normalizeForMatch(String(node.meta.targetSymbol ?? "")),
      normalizeForMatch(node.primaryId),
    ].filter(Boolean);
    const directMatch = candidates.some(
      (value) => value === mentionNorm || value === nameNorm || value === idNorm,
    );
    if (directMatch) {
      return node.id;
    }
    let score = 0;
    for (const candidate of candidates) {
      const candidateTokens = candidate.split(/\s+/).filter(Boolean);
      const shared = candidateTokens.filter((token) => queryTokens.has(token)).length;
      if (shared > 0) {
        score = Math.max(score, shared / Math.max(candidateTokens.length, queryTokens.size || 1));
      }
      if (candidate && (candidate.includes(nameNorm) || nameNorm.includes(candidate))) {
        score = Math.max(score, 0.76);
      }
    }
    if (score >= 0.55 && (!best || score > best.score)) {
      best = { nodeId: node.id, score };
    }
  }
  return best?.nodeId ?? null;
}

function deriveAnchorPathUpdate(
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
  queryPlan?: ResolvedQueryPlan | null,
): DerivedPathUpdate | null {
  const anchors = (queryPlan?.anchors ?? []).slice(0, 5);
  if (anchors.length < 2) return null;

  const anchorNodeIds = anchors
    .map((anchor) => resolveAnchorNodeId(anchor, nodeMap))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index);
  if (anchorNodeIds.length < 2) return null;

  const edges = [...edgeMap.values()];
  const pairPaths: Array<{ from: string; to: string; path: { nodeIds: string[]; edgeIds: string[] } }> = [];
  const unresolved: string[] = [];

  for (let index = 0; index < anchorNodeIds.length - 1; index += 1) {
    const left = anchorNodeIds[index]!;
    const right = anchorNodeIds[index + 1]!;
    const path =
      findShortestGraphPath(left, right, edges, { allowQueryProxyEdges: false }) ??
      findShortestGraphPath(left, right, edges, { allowQueryProxyEdges: true });
    if (!path) {
      const leftLabel = nodeMap.get(left)?.label ?? left;
      const rightLabel = nodeMap.get(right)?.label ?? right;
      unresolved.push(`${leftLabel} -> ${rightLabel}`);
      continue;
    }
    pairPaths.push({ from: left, to: right, path });
  }

  if (pairPaths.length === 0) return null;

  if (pairPaths.length === anchorNodeIds.length - 1 && unresolved.length === 0) {
    const nodeIds: string[] = [];
    const edgeIds: string[] = [];
    for (const item of pairPaths) {
      if (nodeIds.length === 0) {
        nodeIds.push(...item.path.nodeIds);
      } else {
        const last = nodeIds[nodeIds.length - 1];
        if (last === item.path.nodeIds[0]) {
          nodeIds.push(...item.path.nodeIds.slice(1));
        } else {
          nodeIds.push(...item.path.nodeIds);
        }
      }
      edgeIds.push(...item.path.edgeIds);
    }
    const uniqueNodeIds = nodeIds.filter((value, index, all) => all.indexOf(value) === index);
    const uniqueEdgeIds = edgeIds.filter((value, index, all) => all.indexOf(value) === index);
    const summary = uniqueNodeIds
      .map((nodeId) => nodeMap.get(nodeId)?.label ?? nodeId)
      .join(" -> ");
    return {
      nodeIds: uniqueNodeIds,
      edgeIds: uniqueEdgeIds,
      summary,
      connectedAcrossAnchors: true,
      unresolvedAnchorPairs: [],
    };
  }

  const bestPair = [...pairPaths].sort((left, right) => {
    const hops = left.path.edgeIds.length - right.path.edgeIds.length;
    if (hops !== 0) return hops;
    return right.path.nodeIds.length - left.path.nodeIds.length;
  })[0];
  if (!bestPair) return null;
  const bestSummary = bestPair.path.nodeIds
    .map((nodeId) => nodeMap.get(nodeId)?.label ?? nodeId)
    .join(" -> ");
  return {
    nodeIds: bestPair.path.nodeIds,
    edgeIds: bestPair.path.edgeIds,
    summary: bestSummary,
    connectedAcrossAnchors: false,
    unresolvedAnchorPairs: unresolved,
  };
}

function derivePathUpdate(
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
  queryPlan?: ResolvedQueryPlan | null,
): DerivedPathUpdate | null {
  const anchorPath = deriveAnchorPathUpdate(nodeMap, edgeMap, queryPlan);
  if (anchorPath) {
    return anchorPath;
  }

  const diseases = [...nodeMap.values()].filter((node) => node.type === "disease");
  const disease = diseases[0];
  if (!disease) return null;

  if (diseases.length >= 2) {
    const diseaseTargetEdges = [...edgeMap.values()].filter((edge) => edge.type === "disease_target");
    const targetEdgesByTarget = new Map<string, GraphEdge[]>();
    for (const edge of diseaseTargetEdges) {
      const list = targetEdgesByTarget.get(edge.target) ?? [];
      list.push(edge);
      targetEdgesByTarget.set(edge.target, list);
    }

    let bestBridge:
      | {
          targetId: string;
          sourceEdge: GraphEdge;
          secondaryEdge: GraphEdge;
          score: number;
        }
      | null = null;

    for (const [targetId, edges] of targetEdgesByTarget.entries()) {
      if (edges.length < 2) continue;
      const sorted = [...edges].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      const first = sorted[0];
      const second = sorted.find((edge) => edge.source !== first.source);
      if (!first || !second) continue;
      const bridgeScore = (first.weight ?? 0.4) + (second.weight ?? 0.4);
      if (!bestBridge || bridgeScore > bestBridge.score) {
        bestBridge = {
          targetId,
          sourceEdge: first,
          secondaryEdge: second,
          score: bridgeScore,
        };
      }
    }

    if (bestBridge) {
      const target = nodeMap.get(bestBridge.targetId);
      const leftDisease = nodeMap.get(bestBridge.sourceEdge.source);
      const rightDisease = nodeMap.get(bestBridge.secondaryEdge.source);
      if (target && leftDisease && rightDisease) {
        return {
          nodeIds: [leftDisease.id, target.id, rightDisease.id],
          edgeIds: [bestBridge.sourceEdge.id, bestBridge.secondaryEdge.id],
          summary: `${leftDisease.label} -> ${target.label} -> ${rightDisease.label}`,
        };
      }
    }
  }

  const diseaseEdges = [...edgeMap.values()]
    .filter((edge) => edge.type === "disease_target" && edge.source === disease.id)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  const topTargetEdge = diseaseEdges[0];
  if (!topTargetEdge) {
    return {
      nodeIds: [disease.id],
      edgeIds: [],
      summary: `${disease.label} resolved. Building target evidence...`,
    };
  }

  const targetId = topTargetEdge.target;
  const target = nodeMap.get(targetId);
  if (!target) return null;

  const topPathwayEdge = [...edgeMap.values()]
    .filter((edge) => edge.type === "target_pathway" && edge.source === targetId)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];

  const topDrugEdge = [...edgeMap.values()]
    .filter((edge) => edge.type === "target_drug" && edge.source === targetId)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];

  const nodeIds = new Set<string>([disease.id, targetId]);
  const edgeIds = new Set<string>([topTargetEdge.id]);
  let summary = `${disease.label} -> ${target.label}`;

  if (topPathwayEdge) {
    nodeIds.add(topPathwayEdge.target);
    edgeIds.add(topPathwayEdge.id);
    const pathway = nodeMap.get(topPathwayEdge.target);
    if (pathway) summary += ` -> ${pathway.label}`;
  }

  if (topDrugEdge) {
    nodeIds.add(topDrugEdge.target);
    edgeIds.add(topDrugEdge.id);
    const drug = nodeMap.get(topDrugEdge.target);
    if (drug) summary += ` -> ${drug.label}`;
  }

  return {
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
    summary,
  };
}

function extractPathFocusTargetSymbols(
  pathUpdate: DerivedPathUpdate | null,
  nodeMap: Map<string, GraphNode>,
): string[] {
  if (!pathUpdate) return [];
  const symbols: string[] = [];
  for (const nodeId of pathUpdate.nodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== "target") continue;
    const symbol = String(node.meta.targetSymbol ?? node.label ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) continue;
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  return symbols;
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSymbolSeedTargets(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of query.split(/\s+/)) {
    const cleaned = rawToken.replace(/[^A-Za-z0-9+-]/g, "").trim();
    if (cleaned.length < 2 || cleaned.length > 12) continue;
    if (!/[A-Za-z]/.test(cleaned)) continue;
    const isSymbolLike =
      /\d/.test(cleaned) ||
      (/^[A-Z0-9+-]+$/.test(cleaned) && cleaned.length <= 8);
    if (!isSymbolLike) continue;
    const normalized = cleaned.toUpperCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, 12);
}

function diseaseNameSimilarity(a: string, b: string): number {
  const left = normalizeToken(a).split(" ").filter(Boolean);
  const right = normalizeToken(b).split(" ").filter(Boolean);
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = left.filter((token) => rightSet.has(token)).length;
  if (intersection === 0) return 0;
  const union = new Set([...leftSet, ...rightSet]).size;
  return intersection / Math.max(1, union);
}

function isSameDiseaseCandidate(a: DiseaseCandidate, b: DiseaseCandidate): boolean {
  if (a.id === b.id) return true;
  const left = normalizeToken(a.name);
  const right = normalizeToken(b.name);
  if (left && right && left === right) return true;
  return diseaseNameSimilarity(a.name, b.name) >= 0.86;
}

function dedupeDistinctDiseases(candidates: DiseaseCandidate[]): DiseaseCandidate[] {
  const out: DiseaseCandidate[] = [];
  for (const candidate of candidates) {
    if (out.some((existing) => isSameDiseaseCandidate(existing, candidate))) continue;
    out.push(candidate);
  }
  return out;
}

function compactName(value: string, max = 42): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function buildCrossDiseaseBridgePatch(
  primaryDisease: DiseaseCandidate,
  secondaryDiseases: DiseaseCandidate[],
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bridgeEdgeIds: string[];
  secondaryNodeIds: string[];
} {
  if (secondaryDiseases.length === 0) {
    return { nodes: [], edges: [], bridgeEdgeIds: [], secondaryNodeIds: [] };
  }

  const primaryNodeId = makeNodeId("disease", primaryDisease.id);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const bridgeEdgeIds: string[] = [];
  const secondaryNodeIds: string[] = [];

  nodes.push({
    id: primaryNodeId,
    type: "disease",
    primaryId: primaryDisease.id,
    label: compactName(primaryDisease.name, 44),
    score: 1,
    size: 64,
    meta: {
      displayName: primaryDisease.name,
      description: primaryDisease.description,
      role: "query_anchor_primary",
    },
  });

  for (const disease of secondaryDiseases.slice(0, 3)) {
    const nodeId = makeNodeId("disease", disease.id);
    secondaryNodeIds.push(nodeId);
    nodes.push({
      id: nodeId,
      type: "disease",
      primaryId: disease.id,
      label: compactName(disease.name, 44),
      score: 0.44,
      size: 44,
      meta: {
        displayName: disease.name,
        description: disease.description,
        role: "query_anchor_secondary",
      },
    });

    const edgeId = makeEdgeId(primaryNodeId, nodeId, "disease_disease");
    bridgeEdgeIds.push(edgeId);
    edges.push({
      id: edgeId,
      source: primaryNodeId,
      target: nodeId,
      type: "disease_disease",
      weight: 0.2,
      meta: {
        source: "query_anchor",
        status: "candidate",
        note: "Searching for mechanistic bridge between query anchors.",
      },
    });
  }

  return { nodes, edges, bridgeEdgeIds, secondaryNodeIds };
}

type BridgePathwayLink = {
  pathwayId: string;
  pathwayName: string;
  primaryTarget: string;
  secondaryTarget: string;
};

type BridgeInteractionLink = {
  primaryTarget: string;
  secondaryTarget: string;
  viaTarget?: string;
  score: number;
};

type CrossDiseaseBridgeOutcome = {
  disease: DiseaseCandidate;
  connected: boolean;
  sharedTargets: string[];
  pathwayLinks: BridgePathwayLink[];
  interactionLinks: BridgeInteractionLink[];
};

function uniqueNormalizedSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const symbol of symbols) {
    const normalized = normalizeToken(symbol).toUpperCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

async function evaluateCrossDiseaseBridge(options: {
  primaryTargetSymbols: string[];
  secondaryDiseases: DiseaseCandidate[];
}): Promise<CrossDiseaseBridgeOutcome[]> {
  const primarySymbols = uniqueNormalizedSymbols(options.primaryTargetSymbols);
  const primarySet = new Set(primarySymbols);
  if (primarySet.size === 0 || options.secondaryDiseases.length === 0) return [];

  const pathwayCache = new Map<string, Array<{ id: string; name: string }>>();
  const getPathwaysCached = async (symbol: string) => {
    const cached = pathwayCache.get(symbol);
    if (cached) return cached;
    const pathways = await withTimeout(findPathwaysByGene(symbol), 2_600)
      .then((rows) =>
        rows
          .map((row) => ({
            id: String(row.id ?? "").trim(),
            name: Array.isArray(row.name)
              ? row.name.map((item) => String(item)).join(", ")
              : String(row.name ?? "").trim(),
          }))
          .filter((row) => row.id.length > 0 && row.name.length > 0)
          .slice(0, 4),
      )
      .catch(() => []);
    pathwayCache.set(symbol, pathways);
    return pathways;
  };

  const outcomes = await Promise.all(
    options.secondaryDiseases.slice(0, 3).map(async (secondary) => {
      try {
        const rows = await withTimeout(getDiseaseTargetsSummary(secondary.id, 30), 3_200);
        const secondarySymbols = uniqueNormalizedSymbols(
          rows
            .map((row) => row.targetSymbol?.trim() ?? "")
            .filter((symbol) => symbol.length > 0),
        );
        const secondarySet = new Set(secondarySymbols);
        const sharedTargets = secondarySymbols
          .filter((symbol) => primarySet.has(symbol))
          .slice(0, 8);

        const pathwayLinks: BridgePathwayLink[] = [];
        const interactionLinks: BridgeInteractionLink[] = [];

        if (sharedTargets.length === 0 && primarySymbols.length > 0 && secondarySymbols.length > 0) {
          const primaryFrontier = primarySymbols.slice(0, 6);
          const secondaryFrontier = secondarySymbols.slice(0, 6);
          const allPathwaySymbols = uniqueNormalizedSymbols([...primaryFrontier, ...secondaryFrontier]).slice(0, 10);
          const pathwayRows = await Promise.all(
            allPathwaySymbols.map(async (symbol) => ({
              symbol,
              pathways: await getPathwaysCached(symbol),
            })),
          );

          const primaryPathways = new Map<string, { pathwayName: string; symbol: string }>();
          const secondaryPathways = new Map<string, { pathwayName: string; symbol: string }>();
          for (const row of pathwayRows) {
            const collectors: Array<Map<string, { pathwayName: string; symbol: string }>> = [];
            if (primarySet.has(row.symbol)) collectors.push(primaryPathways);
            if (secondarySet.has(row.symbol)) collectors.push(secondaryPathways);
            for (const collector of collectors) {
              for (const pathway of row.pathways) {
                if (!collector.has(pathway.id)) {
                  collector.set(pathway.id, {
                    pathwayName: pathway.name,
                    symbol: row.symbol,
                  });
                }
              }
            }
          }
          for (const [pathwayId, primaryEntry] of primaryPathways.entries()) {
            const secondaryEntry = secondaryPathways.get(pathwayId);
            if (!secondaryEntry) continue;
            pathwayLinks.push({
              pathwayId,
              pathwayName: primaryEntry.pathwayName,
              primaryTarget: primaryEntry.symbol,
              secondaryTarget: secondaryEntry.symbol,
            });
            if (pathwayLinks.length >= 4) break;
          }

          const interactionSeeds = uniqueNormalizedSymbols([...primaryFrontier, ...secondaryFrontier]).slice(0, 12);
          const interaction = await withTimeout(
            getInteractionNetwork(interactionSeeds, 0.72, 80),
            3_000,
          ).catch(() => ({ nodes: [], edges: [] }));

          const directInteraction = interaction.edges
            .map((edge) => ({
              source: normalizeToken(edge.sourceSymbol).toUpperCase(),
              target: normalizeToken(edge.targetSymbol).toUpperCase(),
              score: edge.score ?? 0,
            }))
            .filter(
              (edge) =>
                (primarySet.has(edge.source) && secondarySet.has(edge.target)) ||
                (primarySet.has(edge.target) && secondarySet.has(edge.source)),
            )
            .slice(0, 4);

          if (directInteraction.length > 0) {
            for (const edge of directInteraction) {
              const primaryTarget = primarySet.has(edge.source) ? edge.source : edge.target;
              const secondaryTarget = primarySet.has(edge.source) ? edge.target : edge.source;
              interactionLinks.push({
                primaryTarget,
                secondaryTarget,
                score: edge.score,
              });
            }
          } else if (interaction.edges.length > 0) {
            const primaryToNeighbors = new Map<string, Set<string>>();
            const secondaryToNeighbors = new Map<string, Set<string>>();
            const addNeighbor = (map: Map<string, Set<string>>, key: string, value: string) => {
              const existing = map.get(key) ?? new Set<string>();
              existing.add(value);
              map.set(key, existing);
            };

            for (const edge of interaction.edges) {
              const source = normalizeToken(edge.sourceSymbol).toUpperCase();
              const target = normalizeToken(edge.targetSymbol).toUpperCase();
              if (primarySet.has(source)) addNeighbor(primaryToNeighbors, source, target);
              if (primarySet.has(target)) addNeighbor(primaryToNeighbors, target, source);
              if (secondarySet.has(source)) addNeighbor(secondaryToNeighbors, source, target);
              if (secondarySet.has(target)) addNeighbor(secondaryToNeighbors, target, source);
            }

            outer: for (const [primaryTarget, primaryNeighbors] of primaryToNeighbors.entries()) {
              for (const [secondaryTarget, secondaryNeighbors] of secondaryToNeighbors.entries()) {
                const viaTarget = [...primaryNeighbors].find((candidate) =>
                  secondaryNeighbors.has(candidate),
                );
                if (!viaTarget) continue;
                interactionLinks.push({
                  primaryTarget,
                  secondaryTarget,
                  viaTarget,
                  score: 0.64,
                });
                if (interactionLinks.length >= 3) break outer;
              }
            }
          }
        }

        return {
          disease: secondary,
          connected:
            sharedTargets.length > 0 ||
            pathwayLinks.length > 0 ||
            interactionLinks.length > 0,
          sharedTargets,
          pathwayLinks,
          interactionLinks,
        };
      } catch {
        return {
          disease: secondary,
          connected: false,
          sharedTargets: [],
          pathwayLinks: [],
          interactionLinks: [],
        };
      }
    }),
  );

  return outcomes;
}

function normalizeTargetSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function getTargetSymbolFromNode(node: GraphNode): string | null {
  if (node.type !== "target") return null;
  const symbol = String(node.meta.targetSymbol ?? node.label ?? "").trim();
  return symbol.length > 0 ? normalizeTargetSymbol(symbol) : null;
}

function findTargetNodeBySymbol(nodeMap: Map<string, GraphNode>, symbol: string): GraphNode | null {
  const normalized = normalizeTargetSymbol(symbol);
  for (const node of nodeMap.values()) {
    const nodeSymbol = getTargetSymbolFromNode(node);
    if (nodeSymbol && nodeSymbol === normalized) {
      return node;
    }
  }
  return null;
}

function normalizeCitationText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, 180);
  }
  return fallback;
}

function normalizeCitationUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed.slice(0, 300);
}

function humanizeEvidenceField(field: string): string {
  switch (field) {
    case "openTargetsEvidence":
      return "OpenTargets evidence";
    case "drugActionability":
      return "Drug actionability";
    case "networkCentrality":
      return "Network centrality";
    case "literatureSupport":
      return "Literature support";
    case "drugCount":
      return "Drug links";
    case "interactionCount":
      return "Interaction links";
    case "articleCount":
      return "Article snippets";
    case "trialCount":
      return "Trial snippets";
    default:
      return field;
  }
}

function createSupplementalEvidenceAccumulator(): SupplementalEvidenceAccumulator {
  return {
    articleSnippets: 0,
    trialSnippets: 0,
    citations: [],
    citationKeys: new Set<string>(),
  };
}

function toPubmedUrlFromId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d{5,10}$/.test(trimmed)) {
    return `https://pubmed.ncbi.nlm.nih.gov/${trimmed}/`;
  }
  return undefined;
}

function toTrialUrlFromId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const match = trimmed.match(/NCT\d{8}/i);
  if (!match) return undefined;
  return `https://clinicaltrials.gov/study/${match[0].toUpperCase()}`;
}

function addSupplementalCitation(
  accumulator: SupplementalEvidenceAccumulator,
  citation: SupplementalEvidenceCitation,
) {
  const label = normalizeCitationText(citation.label, "").slice(0, 180);
  if (!label) return;
  const source = normalizeCitationText(citation.source, "Evidence");
  const key = [
    citation.kind,
    citation.url ?? "",
    source.toLowerCase(),
    label.toLowerCase(),
  ].join("::");
  if (accumulator.citationKeys.has(key)) return;
  accumulator.citationKeys.add(key);
  accumulator.citations.push({
    kind: citation.kind,
    label,
    source,
    url: citation.url,
  });
}

function ingestDiscovererJourneyEvidence(
  entry: DiscoverJourneyEntry,
  accumulator: SupplementalEvidenceAccumulator,
) {
  const detail = String(entry.detail ?? "");
  if (entry.source === "pubmed") {
    const articleMatch = detail.match(/(\d+)\s+articles?/i);
    if (articleMatch) {
      accumulator.articleSnippets += Number(articleMatch[1] ?? "0");
    }
    for (const entity of entry.entities ?? []) {
      const label = normalizeCitationText(entity.label, "");
      if (!label) continue;
      const id = typeof entity.primaryId === "string" ? entity.primaryId : undefined;
      addSupplementalCitation(accumulator, {
        kind: "article",
        label,
        source: "PubMed",
        url: toPubmedUrlFromId(id),
      });
    }
    return;
  }

  if (entry.source !== "biomcp") return;

  const snippetMatch = detail.match(/(\d+)\s+article snippets?\s+and\s+(\d+)\s+trial snippets?/i);
  if (snippetMatch) {
    accumulator.articleSnippets += Number(snippetMatch[1] ?? "0");
    accumulator.trialSnippets += Number(snippetMatch[2] ?? "0");
  }

  for (const entity of entry.entities ?? []) {
    const label = normalizeCitationText(entity.label, "");
    if (!label) continue;
    const id = typeof entity.primaryId === "string" ? entity.primaryId : undefined;
    const trialUrl = toTrialUrlFromId(id) ?? toTrialUrlFromId(label);
    if (trialUrl) {
      addSupplementalCitation(accumulator, {
        kind: "trial",
        label,
        source: "ClinicalTrials.gov",
        url: trialUrl,
      });
      continue;
    }
    addSupplementalCitation(accumulator, {
      kind: "article",
      label,
      source: "BioMCP",
      url: normalizeCitationUrl(id) ?? toPubmedUrlFromId(id),
    });
  }
}

function ingestDiscovererFinalEvidenceBundle(
  bundle: DiscovererFinal["evidenceBundle"] | undefined,
  accumulator: SupplementalEvidenceAccumulator,
) {
  if (!bundle) return;
  accumulator.articleSnippets = Math.max(
    accumulator.articleSnippets,
    Number(bundle.articleSnippets ?? 0),
  );
  accumulator.trialSnippets = Math.max(
    accumulator.trialSnippets,
    Number(bundle.trialSnippets ?? 0),
  );
  for (const citation of bundle.citations ?? []) {
    if (citation.kind !== "article" && citation.kind !== "trial") continue;
    addSupplementalCitation(accumulator, {
      kind: citation.kind,
      label: citation.label,
      source: citation.source,
      url: citation.url,
    });
  }
}

function mergeSupplementalEvidenceIntoBrief<T extends FinalBriefSnapshot & Record<string, unknown>>(
  brief: T,
  supplemental: SupplementalEvidenceAccumulator,
): T {
  if (supplemental.articleSnippets <= 0 && supplemental.trialSnippets <= 0 && supplemental.citations.length === 0) {
    return brief;
  }

  const existingCitations = Array.isArray(brief.citations) ? [...brief.citations] : [];
  const existingCitationKey = new Set(
    existingCitations.map((citation) =>
      [
        citation.kind,
        citation.url ?? "",
        normalizeCitationText(citation.source, "").toLowerCase(),
        normalizeCitationText(citation.label, "").toLowerCase(),
      ].join("::"),
    ),
  );
  let nextIndex =
    existingCitations.reduce((max, citation) => Math.max(max, citation.index), 0) + 1;
  for (const citation of supplemental.citations) {
    const key = [
      citation.kind,
      citation.url ?? "",
      normalizeCitationText(citation.source, "").toLowerCase(),
      normalizeCitationText(citation.label, "").toLowerCase(),
    ].join("::");
    if (existingCitationKey.has(key)) continue;
    existingCitationKey.add(key);
    existingCitations.push({
      index: nextIndex,
      kind: citation.kind,
      label: citation.label,
      source: citation.source,
      url: citation.url,
    });
    nextIndex += 1;
    if (existingCitations.length >= 60) break;
  }

  const evidenceSummaryCurrent = (brief.evidenceSummary ?? {}) as Record<string, unknown>;
  const articleCitationCount = existingCitations.filter((item) => item.kind === "article").length;
  const trialCitationCount = existingCitations.filter((item) => item.kind === "trial").length;
  const metricCitationCount = existingCitations.filter((item) => item.kind === "metric").length;
  const articleSnippets = Math.max(
    Number(evidenceSummaryCurrent.articleSnippets ?? 0),
    supplemental.articleSnippets,
    articleCitationCount,
  );
  const trialSnippets = Math.max(
    Number(evidenceSummaryCurrent.trialSnippets ?? 0),
    supplemental.trialSnippets,
    trialCitationCount,
  );
  const caveats = (brief.caveats ?? []).filter((item) => {
    const normalized = item.toLowerCase();
    if (articleSnippets > 0 && normalized.includes("no literature snippets")) return false;
    if (trialSnippets > 0 && normalized.includes("no trial snippets")) return false;
    return true;
  });

  return {
    ...brief,
    citations: existingCitations,
    caveats,
    evidenceSummary: {
      ...evidenceSummaryCurrent,
      articleSnippets,
      trialSnippets,
      citationCount: existingCitations.length,
      citationBreakdown: {
        article: articleCitationCount,
        trial: trialCitationCount,
        metric: metricCitationCount,
      },
    },
  } as T;
}

function summarizeEvidenceCoverage(
  enrichmentLinksByNodeId: EnrichmentLinksByNodeId,
  citations: Array<{ kind: "article" | "trial" | "metric" }>,
) {
  let targetsWithEvidence = 0;
  let articleSnippets = 0;
  let trialSnippets = 0;

  for (const links of Object.values(enrichmentLinksByNodeId)) {
    const articleCount = Array.isArray(links.articles) ? links.articles.length : 0;
    const trialCount = Array.isArray(links.trials) ? links.trials.length : 0;
    articleSnippets += articleCount;
    trialSnippets += trialCount;
    if (articleCount > 0 || trialCount > 0) {
      targetsWithEvidence += 1;
    }
  }

  const citationBreakdown = citations.reduce(
    (acc, citation) => {
      acc[citation.kind] += 1;
      return acc;
    },
    { article: 0, trial: 0, metric: 0 },
  );

  return {
    targetsWithEvidence,
    articleSnippets,
    trialSnippets,
    citationCount: citations.length,
    citationBreakdown,
  };
}

function buildVerdictCitations(options: {
  selectedSymbol: string | null;
  evidenceTrace: Array<{
    symbol: string;
    refs: Array<{ field: string; value: string | number | boolean }>;
  }>;
  nodeMap: Map<string, GraphNode>;
  selectedTargetNodeId: string | null;
  enrichmentLinksByNodeId: EnrichmentLinksByNodeId;
}) {
  const citations: Array<{
    index: number;
    kind: "article" | "trial" | "metric";
    label: string;
    source: string;
    url?: string;
  }> = [];

  let index = 1;
  const pushCitation = (entry: {
    kind: "article" | "trial" | "metric";
    label: string;
    source: string;
    url?: string;
  }) => {
    citations.push({
      index,
      ...entry,
    });
    index += 1;
  };

  const targetNodeIds: string[] = [];
  const pushTargetNodeId = (value: string | null | undefined) => {
    if (!value) return;
    if (!targetNodeIds.includes(value)) {
      targetNodeIds.push(value);
    }
  };

  pushTargetNodeId(options.selectedTargetNodeId);
  for (const row of options.evidenceTrace.slice(0, 10)) {
    const targetNode = findTargetNodeBySymbol(options.nodeMap, row.symbol);
    pushTargetNodeId(targetNode?.id ?? null);
  }

  if (targetNodeIds.length === 0) {
    for (const nodeId of Object.keys(options.enrichmentLinksByNodeId)) {
      pushTargetNodeId(nodeId);
    }
  }

  const seenEvidence = new Set<string>();
  const addEvidenceCitation = (
    kind: "article" | "trial",
    entry: EnrichmentSnippet,
    targetLabel: string,
  ) => {
    const label = normalizeCitationText(
      entry.title,
      kind === "article" ? "Article evidence" : "Clinical trial evidence",
    );
    const url = normalizeCitationUrl(entry.url);
    const source = normalizeCitationText(
      entry.source,
      kind === "article" ? "PubMed" : "ClinicalTrials.gov",
    );
    const statusSuffix =
      kind === "trial" && typeof entry.status === "string" && entry.status.trim().length > 0
        ? ` (${entry.status.trim()})`
        : "";
    const dedupeKey = [
      kind,
      url ?? "",
      typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "",
      label.toLowerCase(),
    ].join("::");
    if (seenEvidence.has(dedupeKey)) return;
    seenEvidence.add(dedupeKey);
    pushCitation({
      kind,
      label: `${targetLabel}: ${label}${statusSuffix}`.slice(0, 180),
      source,
      url,
    });
  };

  for (const nodeId of targetNodeIds) {
    const links = options.enrichmentLinksByNodeId[nodeId];
    if (!links) continue;
    const targetNode = options.nodeMap.get(nodeId);
    const targetLabel = normalizeCitationText(
      targetNode?.meta?.targetSymbol ?? targetNode?.label,
      "target",
    );
    for (const article of links.articles ?? []) {
      addEvidenceCitation("article", article, targetLabel);
      if (citations.length >= 30) break;
    }
    if (citations.length >= 30) break;
    for (const trial of links.trials ?? []) {
      addEvidenceCitation("trial", trial, targetLabel);
      if (citations.length >= 40) break;
    }
    if (citations.length >= 40) break;
  }

  const selectedTrace =
    (options.selectedSymbol &&
      options.evidenceTrace.find(
        (item) => item.symbol.toUpperCase() === options.selectedSymbol?.toUpperCase(),
      )) ??
    options.evidenceTrace[0];
  if (selectedTrace) {
    const preferredMetricRefs = selectedTrace.refs
      .filter((ref) =>
        [
          "openTargetsEvidence",
          "networkCentrality",
          "drugActionability",
          "literatureSupport",
        ].includes(ref.field),
      )
      .slice(0, 5);

    for (const ref of preferredMetricRefs) {
      if (citations.length >= 48) break;
      pushCitation({
        kind: "metric",
        label: `${humanizeEvidenceField(ref.field)} = ${String(ref.value)}`,
        source: "Ranked evidence trace",
      });
    }
  }

  return citations;
}

function generateBriefSections(options: {
  ranking: RankingResponse | null;
  nodeMap: Map<string, GraphNode>;
  edgeMap: Map<string, GraphEdge>;
  sourceHealth: SourceHealth;
  semanticConceptMentions: string[];
  semanticTargetSymbols: string[];
  hasInterventionConcept: boolean;
  queryAnchorCount?: number;
  pathFocusTargetSymbols?: string[];
  enrichmentLinksByNodeId: EnrichmentLinksByNodeId;
}) {
  const {
    ranking,
    nodeMap,
    edgeMap,
    sourceHealth,
    semanticConceptMentions,
    semanticTargetSymbols,
    hasInterventionConcept,
    queryAnchorCount,
    pathFocusTargetSymbols,
    enrichmentLinksByNodeId,
  } = options;
  const nodes = [...nodeMap.values()];
  const edges = [...edgeMap.values()];

  const evidenceRows = buildEvidenceTable(nodes, edges);
  const rankingInputRows = evidenceRows.map((row) => ({
    id: row.targetId,
    symbol: row.symbol,
    pathwayIds: row.pathwayIds,
    openTargetsEvidence: row.openTargetsEvidence,
    drugActionability: row.drugActionability,
    networkCentrality: row.networkCentrality,
    literatureSupport: row.literatureSupport,
    drugCount: row.drugCount,
    interactionCount: row.interactionCount,
    articleCount: row.articleCount,
    trialCount: row.trialCount,
  }));
  const resolvedRanking =
    ranking ?? (rankingInputRows.length > 0 ? rankTargetsFallback(rankingInputRows) : null);

  if (!resolvedRanking) {
    const evidenceSummary = summarizeEvidenceCoverage(enrichmentLinksByNodeId, []);
    return {
      recommendation: null,
      alternatives: [],
      evidenceTrace: [],
      citations: [],
      evidenceSummary,
      caveats: ["No ranked target evidence available yet."],
      nextActions: [
        "Increase run depth or retry with more specific disease phrasing.",
        "Inspect source health to identify degraded inputs.",
      ],
    };
  }

  const semanticTargetSet = new Set(
    semanticTargetSymbols.map((value) => value.toUpperCase()),
  );
  const pathFocusSet = new Set(
    (pathFocusTargetSymbols ?? []).map((value) => value.trim().toUpperCase()),
  );
  const normalizedQueryAnchorCount = Math.max(1, queryAnchorCount ?? 1);
  const boostedRanking = [...resolvedRanking.rankedTargets]
    .map((item) => ({
      item,
      boost:
        (semanticTargetSet.has(item.symbol.toUpperCase()) ? 0.06 : 0) +
        (pathFocusSet.has(item.symbol.toUpperCase()) ? 0.12 : 0),
    }))
    .sort((a, b) => b.item.score + b.boost - (a.item.score + a.boost))
    .map((row, index) => ({
      ...row.item,
      rank: index + 1,
    }));

  const baselineTop = boostedRanking[0];
  const matchedQueryTarget = boostedRanking.find((item) =>
    semanticTargetSet.has(item.symbol.toUpperCase()),
  );
  const pathFocusedTarget = boostedRanking.find((item) =>
    pathFocusSet.has(item.symbol.toUpperCase()),
  );

  const shouldAnchorToQuery =
    hasInterventionConcept &&
    !!matchedQueryTarget &&
    (matchedQueryTarget.score >= 0.32 || matchedQueryTarget.rank <= 12) &&
    (baselineTop?.score ?? 0) - matchedQueryTarget.score <= 0.26;
  const shouldPreferPathFocused =
    normalizedQueryAnchorCount >= 2 &&
    !shouldAnchorToQuery &&
    !!pathFocusedTarget &&
    (pathFocusedTarget.score >= 0.28 || pathFocusedTarget.rank <= 12);

  const selectedTop = shouldAnchorToQuery
    ? matchedQueryTarget
    : shouldPreferPathFocused
      ? pathFocusedTarget
      : baselineTop;

  const pathways = selectedTop?.pathwayHooks ?? [];
  const dataGaps = resolvedRanking.systemSummary.dataGaps;

  const alternatives = boostedRanking
    .filter((item) => item.symbol !== selectedTop?.symbol)
    .slice(0, 5)
    .map((item) => ({
      symbol: item.symbol,
      score: item.score,
      reason: item.reasons[0] ?? "not provided",
      caveat: item.caveats[0] ?? "not provided",
    }));

  const evidenceTrace = boostedRanking.slice(0, 8).map((item) => ({
    symbol: item.symbol,
    score: item.score,
    refs: item.evidenceRefs,
  }));
  const selectedTargetNode = selectedTop
    ? findTargetNodeBySymbol(nodeMap, selectedTop.symbol)
    : null;
  const citations = buildVerdictCitations({
    selectedSymbol: selectedTop?.symbol ?? null,
    evidenceTrace,
    nodeMap,
    selectedTargetNodeId: selectedTargetNode?.id ?? null,
    enrichmentLinksByNodeId,
  });
  const evidenceSummary = summarizeEvidenceCoverage(enrichmentLinksByNodeId, citations);

  const degradedSources = Object.entries(sourceHealth)
    .filter(([, health]) => health !== "green")
    .map(([source]) => source);

  const caveats = [
    ...(selectedTop?.caveats?.slice(0, 2) ?? []),
    ...(shouldAnchorToQuery &&
    matchedQueryTarget &&
    baselineTop &&
    matchedQueryTarget.symbol !== baselineTop.symbol
      ? [
          `Query-anchored recommendation selected (${matchedQueryTarget.symbol}) while baseline top was ${baselineTop.symbol}; compare both before nomination.`,
        ]
      : []),
    ...(shouldPreferPathFocused &&
    pathFocusedTarget &&
    baselineTop &&
    pathFocusedTarget.symbol !== baselineTop.symbol
      ? [
          `Path-consistent recommendation selected (${pathFocusedTarget.symbol}) while baseline top was ${baselineTop.symbol}; compare both threads before nomination.`,
        ]
      : []),
    ...(semanticTargetSet.size > 0 &&
    selectedTop &&
    !semanticTargetSet.has(selectedTop.symbol.toUpperCase())
      ? [
          `Query concept mismatch: requested target/intervention mentions (${semanticConceptMentions.join(
            ", ",
          )}) were not top-ranked in this disease graph.`,
        ]
      : []),
    ...dataGaps.slice(0, 2),
    ...(degradedSources.length > 0
      ? [`Degraded inputs during this run: ${degradedSources.join(", ")}.`] 
      : []),
  ];

  const nextActions = [
    `Validate perturbation of ${selectedTop?.symbol ?? "top target"} in pathway-relevant assay.`,
    "Compare top 3 alternatives for tractability and mechanistic orthogonality.",
    "Run Deep mode for richer interaction and literature context before program decision.",
  ];

  const queryAlignment: {
    status: "matched" | "anchored" | "mismatch" | "none";
    requestedMentions: string[];
    requestedTargetSymbols: string[];
    matchedTarget?: string;
    baselineTop?: string;
    note: string;
  } = semanticConceptMentions.length
    ? semanticTargetSet.size > 0
      ? matchedQueryTarget
        ? shouldAnchorToQuery
          ? {
              status: matchedQueryTarget.symbol === baselineTop?.symbol ? "matched" : "anchored",
              requestedMentions: semanticConceptMentions,
              requestedTargetSymbols: [...semanticTargetSet],
              matchedTarget: matchedQueryTarget.symbol,
              baselineTop: baselineTop?.symbol,
              note:
                matchedQueryTarget.symbol === baselineTop?.symbol
                  ? `Query concept aligns with the strongest ranked target (${matchedQueryTarget.symbol}).`
                  : `Recommendation anchored to query concept target (${matchedQueryTarget.symbol}) with explicit caveats.`,
            }
          : {
              status: "mismatch",
              requestedMentions: semanticConceptMentions,
              requestedTargetSymbols: [...semanticTargetSet],
              matchedTarget: matchedQueryTarget.symbol,
              baselineTop: baselineTop?.symbol,
              note: `Requested concept target (${matchedQueryTarget.symbol}) was found but not selected as top recommendation.`,
            }
        : {
            status: "mismatch",
            requestedMentions: semanticConceptMentions,
            requestedTargetSymbols: [...semanticTargetSet],
            baselineTop: baselineTop?.symbol,
            note: "Requested concept target was not present in ranked disease evidence.",
          }
      : {
          status: "none",
          requestedMentions: semanticConceptMentions,
          requestedTargetSymbols: [],
          baselineTop: baselineTop?.symbol,
          note: "No explicit target-level concept extracted from query.",
        }
    : {
        status: "none",
        requestedMentions: [],
        requestedTargetSymbols: [],
        baselineTop: baselineTop?.symbol,
        note: "No semantic query concepts extracted.",
      };

  return {
    recommendation: {
      target: selectedTop?.symbol ?? "not provided",
      score: selectedTop?.score ?? 0,
      why: selectedTop?.reasons?.[0] ?? "not provided",
      pathway: pathways[0] ?? "not provided",
      drugHook: selectedTop?.drugHooks?.[0] ?? "not provided",
      interactionHook: selectedTop?.interactionHooks?.[0] ?? "not provided",
    },
    alternatives,
    evidenceTrace,
    citations,
    evidenceSummary,
    caveats,
    nextActions,
    queryAlignment,
  };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const action = params.get("action")?.trim().toLowerCase();
  const rawSessionId = params.get("sessionId")?.trim();
  const sessionKey = resolveSessionKey(request, rawSessionId);
  const requestApiKey = resolveSessionApiKey(sessionKey);
  cleanupStaleSessionRuns();

  if (action === "interrupt") {
    const active = activeSessionRuns.get(sessionKey);
    if (active) {
      active.abortController.abort("interrupted by user");
      activeSessionRuns.delete(sessionKey);
      return Response.json({ ok: true, interrupted: true });
    }
    return Response.json({ ok: true, interrupted: false });
  }
  if (action === "status") {
    const active = activeSessionRuns.get(sessionKey);
    return Response.json({
      ok: true,
      active: Boolean(active),
      runId: active?.runId ?? null,
      hasSessionApiKey: Boolean(requestApiKey),
    });
  }
  const query = params.get("query")?.trim();
  const mode: RunMode = "multihop";
  const diseaseIdHint = params.get("diseaseId")?.trim();
  const diseaseNameHint = params.get("diseaseName")?.trim();
  const runId =
    params.get("runId")?.trim() ??
    `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const log = startRequestLog("/api/runCaseStream", {
    mode,
    queryLength: query?.length ?? 0,
    query: query?.slice(0, 180),
    hasDiseaseIdHint: Boolean(diseaseIdHint),
    hasSessionApiKey: Boolean(requestApiKey),
    runId,
    sessionKey: sessionKey.slice(0, 64),
  });

  if (!query) {
    endRequestLog(log, { rejected: true, reason: "missing_query" });
    return new Response("Missing query", { status: 400 });
  }

  const existingRun = activeSessionRuns.get(sessionKey);
  if (existingRun && existingRun.runId !== runId) {
    warnRequestLog(log, "run_case.rejected_active_session", {
      existingRunId: existingRun.runId,
    });
    endRequestLog(log, { rejected: true, reason: "active_query_exists" });
    return new Response("Active query exists for this session. Interrupt it first.", {
      status: 409,
    });
  }

  const streamState = { closed: false };
  const streamAbort = new AbortController();
  activeSessionRuns.set(sessionKey, {
    runId,
    sessionKey,
    startedAt: Date.now(),
    abortController: streamAbort,
  });
  const cleanupSessionRun = () => {
    clearSessionRunLock(sessionKey, runId);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      const nodeMap = new Map<string, GraphNode>();
      const edgeMap = new Map<string, GraphEdge>();
      let ranking: RankingResponse | null = null;
      let enrichmentLinksByNodeId: EnrichmentLinksByNodeId = {};
      let sourceHealth: SourceHealth = {
        opentargets: "green",
        reactome: "green",
        string: "green",
        chembl: "green",
        biomcp: "green",
        pubmed: "green",
        openai: "green",
      };
      let lastPathSignature = "";
      let lastRecommendationSignature = "";
      let lastProvisionalEmitMs = 0;
      let lastAgentStepSignature = "";
      let preStreamHeartbeatMessage = "Resolving biomedical anchors";
      let preStreamHeartbeatPct = 2;
      let preStreamHeartbeat: ReturnType<typeof setInterval> | null = null;
      let discovererPromise: Promise<DiscovererFinal | null> | null = null;
      let discovererFinal: DiscovererFinal | null = null;
      let discovererAnswerEmitted = false;
      let journeyEventCount = 0;
      const supplementalEvidence = createSupplementalEvidenceAccumulator();

      const emit = (event: string, data: unknown) => {
        if (streamState.closed) return;
        try {
          controller.enqueue(encodeEvent(event, data));
        } catch {
          streamState.closed = true;
        }
      };

      const emitGraphDelta = (nodes: GraphNode[], edges: GraphEdge[]) => {
        const payload = {
          nodes,
          edges,
          stats: {
            totalNodes: nodeMap.size,
            totalEdges: edgeMap.size,
          },
        };
        emit("graph_patch", payload);
        emit("graph_delta", payload);
      };

      const emitJourney = (entry: DiscoverJourneyEntry) => {
        journeyEventCount += 1;
        if (journeyEventCount > MAX_JOURNEY_EVENTS) return;

        const basePayload = {
          id: entry.id,
          ts: entry.ts,
          kind: entry.kind,
          title: entry.title,
          detail: entry.detail,
          source: entry.source,
          pathState: entry.pathState,
          entities: entry.entities,
          graphPatch: entry.graphPatch,
        };

        emit("narration_delta", basePayload);
        if (entry.pathState) {
          emit("branch_update", basePayload);
        }
        if (entry.kind === "tool_start") {
          emit("tool_call", basePayload);
        }
        if (entry.kind === "tool_result" || entry.kind === "handoff") {
          emit("tool_result", basePayload);
        }
        emit("agent_step", {
          phase: "A",
          title: compactText(entry.title, 110),
          detail: compactText(entry.detail, 180),
        });

        ingestDiscovererJourneyEvidence(entry, supplementalEvidence);

        const patch = entry.graphPatch;
        if (patch && (patch.nodes.length > 0 || patch.edges.length > 0)) {
          for (const node of patch.nodes) {
            nodeMap.set(node.id, node);
          }
          for (const edge of patch.edges) {
            edgeMap.set(edge.id, edge);
          }
          emitGraphDelta(patch.nodes, patch.edges);
        }
      };

      const close = () => {
        if (streamState.closed) return;
        streamState.closed = true;
        try {
          controller.close();
        } catch {
          // no-op
        }
        cleanupSessionRun();
      };

      beginOpenAiRun(runId, query);

      await withOpenAiApiKeyContext(requestApiKey, async () =>
        withOpenAiRunContext(runId, async () => {
      try {
        let resolvedQueryPlan: ResolvedQueryPlan | null = null;
        const emitPreStreamStatus = () => {
          emit("status", {
            phase: "P0",
            message: preStreamHeartbeatMessage,
            pct: preStreamHeartbeatPct,
            elapsedMs: Date.now() - startedAt,
            partial: true,
            counts: {
              nodes: nodeMap.size,
              edges: edgeMap.size,
            },
            sourceHealth,
          });
        };

        emit("run_started", {
          runId,
          mode,
          query,
          startedAt: new Date(startedAt).toISOString(),
        });

        emit("status", {
          phase: "P0",
          message: "Resolving disease entity",
          pct: 2,
        });
        emitPreStreamStatus();
        preStreamHeartbeat = setInterval(() => {
          emitPreStreamStatus();
        }, 2500);
        const llmRelationMentions = (await extractRelationMentionsFast(query, {
          maxMentions: 6,
          timeoutMs: 1_700,
        }).catch(() => []))
          .map((value) => trimDiseaseNoise(value))
          .filter((value) => value.length >= 3)
          .slice(0, 8);

        let bundled: Awaited<ReturnType<typeof resolveQueryEntitiesBundle>>;
        preStreamHeartbeatMessage = "Resolving entities and canonical anchors";
        preStreamHeartbeatPct = 5;
        try {
          bundled = await withOpenAiOperationContext(
            "run_case.resolve_entities_bundle",
            () =>
              withTimeout(
                resolveQueryEntitiesBundle(query),
                BUNDLED_RESOLUTION_TIMEOUT_MS,
              ),
          );
        } catch {
          const fallbackDiseasePhrase = trimDiseaseNoise(extractDiseasePhrase(query));
          const relationMentions =
            llmRelationMentions.length > 0
              ? llmRelationMentions
              : extractDiseaseAnchorMentions(query);
          const includeWholeQueryFallback = allowWholeQueryDiseaseSearch(query);
          let timeoutFallbackCandidates: DiseaseCandidate[] = [];
          const timeoutMentions = [
            ...new Set([
              ...relationMentions,
              includeWholeQueryFallback ? fallbackDiseasePhrase : "",
            ]),
          ]
            .map((value) => trimDiseaseNoise(value))
            .filter((value) => value.length >= 3)
            .slice(0, 8);

          for (const mention of timeoutMentions) {
            const mentionCandidates = await searchDiseaseCandidates(mention, 8, 1).catch(() => []);
            if (mentionCandidates.length > 0) {
              timeoutFallbackCandidates = mergeDiseaseCandidates(timeoutFallbackCandidates, mentionCandidates);
            }
            if (timeoutFallbackCandidates.length >= 14) break;
          }
          timeoutFallbackCandidates = rerankDiseaseCandidates(query, timeoutFallbackCandidates, 14);
          bundled = {
            query,
            queryPlan: {
              query,
              intent: "multihop-discovery",
              anchors: timeoutFallbackCandidates.slice(0, 2).map((candidate) => ({
                mention: fallbackDiseasePhrase,
                requestedType: "unknown",
                entityType: "disease",
                id: candidate.id,
                name: candidate.name,
                description: candidate.description,
                confidence: 0.62,
                source: "opentargets",
              })),
              constraints: [],
              unresolvedMentions: [],
              followups: [],
              rationale:
                "Bundled resolver timeout; fallback to deterministic disease search on query phrase.",
            },
            selectedDisease: null,
            diseaseCandidates: timeoutFallbackCandidates,
            rationale:
              "Bundled resolver timeout; deterministic disease search fallback applied.",
            openAiCalls: 0,
          };
        }
        preStreamHeartbeatMessage = "Refining semantic query plan";
        preStreamHeartbeatPct = 10;

        stepRequestLog(log, "run_case.entity_bundle", {
          anchors: bundled.queryPlan.anchors.length,
          diseaseCandidates: bundled.diseaseCandidates.length,
          openAiCalls: bundled.openAiCalls,
          semanticPlanAnchors: bundled.queryPlan.anchors.length,
        });

        resolvedQueryPlan = bundled.queryPlan;
        emit("query_plan", bundled.queryPlan);
        emit("entity_candidates", {
          anchors: bundled.queryPlan.anchors,
          unresolvedMentions: bundled.queryPlan.unresolvedMentions,
        });

        let candidates: DiseaseCandidate[] = mergeDiseaseCandidates(
          bundled.diseaseCandidates,
          bundled.queryPlan.anchors
            .filter((anchor) => anchor.entityType === "disease")
            .map((anchor) => ({
              id: anchor.id,
              name: anchor.name,
              description: anchor.description,
            })),
        );

        if (candidates.length === 0) {
          const diseasePhrase = extractDiseasePhrase(query);
          const diseasePhraseNormalized = trimDiseaseNoise(diseasePhrase);
          const queryHasRelationPattern =
            /\bbetween\b|\bconnect(?:ion)?\b|\brelationship\b|\blink\b|\boverlap\b|\bvs\b|\bversus\b/i.test(
              query,
            );
          const hasNonDiseasePlanAnchor = (resolvedQueryPlan?.anchors ?? []).some(
            (anchor) => anchor.entityType !== "disease",
          );
          const useDiseasePhrase =
            !queryHasRelationPattern &&
            !hasNonDiseasePlanAnchor &&
            diseasePhraseNormalized.split(/\s+/).filter(Boolean).length <= 4
              ? diseasePhraseNormalized
              : "";
          const anchorMentions = [
            ...new Set([
              ...(resolvedQueryPlan?.anchors ?? [])
                .filter((anchor) => anchor.entityType === "disease")
                .flatMap((anchor) => [anchor.mention, anchor.name]),
              ...(llmRelationMentions.length > 0
                ? llmRelationMentions
                : extractDiseaseAnchorMentions(query)),
              allowWholeQueryDiseaseSearch(query) ? useDiseasePhrase : "",
            ]),
          ]
            .map((value) => value.trim())
            .filter((value) => value.length >= 3)
            .slice(0, 8);
          for (const mention of anchorMentions) {
            const mentionCandidates = await searchDiseaseCandidates(mention, 8, 1);
            if (mentionCandidates.length > 0) {
              candidates = mergeDiseaseCandidates(candidates, mentionCandidates);
            }
            if (candidates.length >= 12) break;
          }
        }
        const relationQueryLexical =
          /\b(and|between|vs|versus|connect|connection|relationship|link|overlap|common|shared|affect|impact|influence|modulate|mediate|associated|correlated)\b/i.test(
            query,
          );
        const queryPlanAnchorCount = (resolvedQueryPlan?.anchors ?? []).length;
        const relationQuery =
          relationQueryLexical ||
          queryPlanAnchorCount >= 2 ||
          (resolvedQueryPlan?.intent ?? "").toLowerCase().includes("multihop");
        const diseaseAnchorCountInPlan = (resolvedQueryPlan?.anchors ?? []).filter(
          (anchor) => anchor.entityType === "disease",
        ).length;
        const allowMentionAnchoredDiseaseExpansion =
          relationQuery &&
          diseaseAnchorCountInPlan < 2;
        const typedDiseaseMentions = (resolvedQueryPlan?.anchors ?? [])
          .filter((anchor) => anchor.entityType === "disease")
          .flatMap((anchor) => [anchor.mention, anchor.name])
          .map((value) => trimDiseaseNoise(value))
          .filter((value) => value.length >= 3)
          .slice(0, 8);
        const relationMentions = [
          ...typedDiseaseMentions,
          ...llmRelationMentions,
          ...extractDiseaseAnchorMentions(query),
        ]
          .map((value) => trimDiseaseNoise(value))
          .filter((value) => value.length >= 3)
          .filter((value, index, all) => all.indexOf(value) === index)
          .slice(0, 10);
        const mentionAnchoredMatches = allowMentionAnchoredDiseaseExpansion
          ? await resolveMentionAnchoredDiseases(relationMentions, 3)
          : [];
        const mentionAnchoredDiseasesRaw = mentionAnchoredMatches.map((item) => item.disease);
        candidates = rerankDiseaseCandidates(
          query,
          mergeDiseaseCandidates(candidates, mentionAnchoredDiseasesRaw),
          14,
        );
        const scoredCandidates = rankDiseaseCandidates(query, candidates, 14);
        const diseaseScoreById = new Map(scoredCandidates.map((item) => [item.id, item.score]));
        candidates = scoredCandidates.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
        }));
        const topCandidateScore = scoredCandidates[0]?.score ?? -Infinity;
        const literalDiseaseCandidate = pickLiteralDiseaseCandidate(query, candidates);
        const mentionAnchoredDiseases = mentionAnchoredMatches
          .filter((item) =>
            candidates.some((candidate) => candidate.id === item.disease.id),
          )
          .map((item) => item.disease);
        const rankedMentionAnchoredDiseases = mentionAnchoredDiseases
          .map((item) => ({
            disease: item,
            score: diseaseScoreById.get(item.id) ?? scoreDiseaseCandidate(query, item),
          }))
          .sort((a, b) => b.score - a.score);

        emit("resolver_candidates", {
          query,
          candidates,
        });

        const semanticTargetSymbolsEarly = (resolvedQueryPlan?.anchors ?? [])
          .filter((anchor) => anchor.entityType === "target")
          .map((anchor) => anchor.name);
        const semanticConceptMentionsEarly = [
          ...(resolvedQueryPlan?.anchors ?? []).map((anchor) => anchor.mention),
          ...llmRelationMentions,
        ]
          .map((value) => value.trim())
          .filter((value) => value.length >= 2)
          .filter((value, index, all) => all.indexOf(value) === index);
        const hasInterventionConceptEarly = (resolvedQueryPlan?.anchors ?? []).some(
          (anchor) => anchor.requestedType === "intervention" || anchor.entityType === "drug",
        );
        preStreamHeartbeatMessage = "Selecting primary disease anchor";
        preStreamHeartbeatPct = 13;
        const hasDiseaseAnchorInPlan = (resolvedQueryPlan?.anchors ?? []).some(
          (anchor) => anchor.entityType === "disease",
        );
        const hasNonDiseaseAnchorInPlan = (resolvedQueryPlan?.anchors ?? []).some(
          (anchor) => anchor.entityType !== "disease",
        );
        const planDiseaseAnchors = (resolvedQueryPlan?.anchors ?? []).filter(
          (anchor) => anchor.entityType === "disease",
        );
        const planOntologyDiseaseAnchors = planDiseaseAnchors.filter(
          (anchor) => !/^HP_/i.test(anchor.id),
        );
        const topPlanDiseaseAnchor =
          (planOntologyDiseaseAnchors.length > 0
            ? planOntologyDiseaseAnchors
            : planDiseaseAnchors
          ).sort((a, b) => b.confidence - a.confidence)[0] ?? null;
        const topPlanDiseaseCandidate =
          (topPlanDiseaseAnchor
            ? candidates.find((candidate) => candidate.id === topPlanDiseaseAnchor.id) ?? null
            : null) ??
          (topPlanDiseaseAnchor
            ? {
                id: topPlanDiseaseAnchor.id,
                name: topPlanDiseaseAnchor.name,
                description: topPlanDiseaseAnchor.description,
              }
            : null);
        let chosen:
          | {
              selected: DiseaseCandidate;
              rationale: string;
            }
          | undefined;

        if (diseaseIdHint) {
          const pinned =
            candidates.find((item) => item.id === diseaseIdHint) ??
            (diseaseNameHint
              ? {
                  id: diseaseIdHint,
                  name: diseaseNameHint,
                }
              : null);

          if (pinned) {
            chosen = {
              selected: pinned,
              rationale: "User-pinned disease entity.",
            };
          }
        }

        const planAnchorSelectionThreshold =
          relationQuery || hasNonDiseaseAnchorInPlan ? 0.42 : 0.6;
        if (!chosen) {
          if (
            topPlanDiseaseCandidate &&
            (topPlanDiseaseAnchor?.confidence ?? 0) >= planAnchorSelectionThreshold
          ) {
            chosen = {
              selected: topPlanDiseaseCandidate,
              rationale: "Selected highest-confidence disease anchor from canonical entity resolution.",
            };
          } else if (
            relationQuery &&
            rankedMentionAnchoredDiseases.length > 0 &&
            rankedMentionAnchoredDiseases[0]!.score >= 1.4
          ) {
            chosen = {
              selected: rankedMentionAnchoredDiseases[0]!.disease,
              rationale:
                "Selected primary disease from mention-level anchor resolution for multi-anchor query.",
            };
          } else if (literalDiseaseCandidate && topCandidateScore >= 1.6) {
            chosen = {
              selected: literalDiseaseCandidate,
              rationale: "Selected strongest lexical disease candidate from the query phrase.",
            };
          }
        }

        if (!chosen) {
          const topCandidate = candidates[0] ?? null;
          const bundledSelectionRank = bundled.selectedDisease
            ? candidates.findIndex((item) => item.id === bundled.selectedDisease?.id)
            : -1;
          if (bundled.selectedDisease) {
            if (hasNonDiseaseAnchorInPlan && !hasDiseaseAnchorInPlan) {
              const nonDiseaseAnchorName =
                (resolvedQueryPlan?.anchors ?? []).find((anchor) => anchor.entityType !== "disease")?.name ??
                extractDiseasePhrase(query) ??
                query;
              chosen = {
                selected: {
                  id: querySyntheticDiseaseId(query),
                  name: nonDiseaseAnchorName.trim() || query,
                },
                rationale:
                  "Query is anchored on non-disease entities; running concept-centric multihop discovery.",
              };
            } else if (
              bundledSelectionRank >= 0 &&
              (bundledSelectionRank <= 2 || topCandidateScore < 2.8)
            ) {
              chosen = {
                selected: bundled.selectedDisease,
                rationale: bundled.rationale,
              };
            } else if (literalDiseaseCandidate && topCandidateScore >= 1.6) {
              chosen = {
                selected: literalDiseaseCandidate,
                rationale:
                  "Bundled primary disease conflicted with lexical ranking; selected strongest query-literal candidate.",
              };
            } else if (topCandidate && topCandidateScore >= 1.8) {
              chosen = {
                selected: topCandidate,
                rationale:
                  "Bundled primary disease conflicted with lexical ranking; selected strongest canonical candidate.",
              };
            } else {
              const syntheticDiseaseName =
                (resolvedQueryPlan?.anchors ?? []).find((item) => item.entityType !== "disease")?.name ??
                extractDiseasePhrase(query) ??
                query;
              chosen = {
                selected: {
                  id: querySyntheticDiseaseId(query),
                  name: syntheticDiseaseName.trim() || query,
                },
                rationale:
                  "Disease evidence is weak relative to non-disease anchors; proceeding with query-seeded multihop discovery.",
              };
            }
          } else if (
            candidates.length > 0 &&
            topCandidateScore >= 1.8 &&
            !(hasNonDiseaseAnchorInPlan && !hasDiseaseAnchorInPlan)
          ) {
            chosen = {
              selected: literalDiseaseCandidate ?? candidates[0]!,
              rationale: "Bundled resolver returned no primary disease; selected top candidate.",
            };
          } else {
            const syntheticDiseaseName =
              resolvedQueryPlan?.anchors.find((item) => item.entityType === "disease")?.name ??
              extractDiseasePhrase(query) ??
              query;
            chosen = {
              selected: {
                id: querySyntheticDiseaseId(query),
                name: syntheticDiseaseName.trim() || query,
              },
              rationale:
                "No disease ontology match found; proceeding with query-seeded multihop discovery.",
            };
          }
        }

        if (chosen && literalDiseaseCandidate && chosen.selected.id !== literalDiseaseCandidate.id) {
          const chosenScore =
            diseaseScoreById.get(chosen.selected.id) ??
            scoreDiseaseCandidate(query, chosen.selected);
          const literalScore =
            diseaseScoreById.get(literalDiseaseCandidate.id) ??
            scoreDiseaseCandidate(query, literalDiseaseCandidate);
          const preservePlanAnchorSelection = Boolean(
            topPlanDiseaseAnchor &&
              chosen.selected.id === topPlanDiseaseAnchor.id &&
              (topPlanDiseaseAnchor.confidence ?? 0) >=
                (relationQuery || hasNonDiseaseAnchorInPlan ? 0.45 : 0.65),
          );
          if (!preservePlanAnchorSelection && literalScore - chosenScore >= 0.8) {
            chosen = {
              selected: literalDiseaseCandidate,
              rationale:
                "Resolver arbitration corrected to the strongest query-literal disease candidate.",
            };
          }
        }

        emit("resolver_selected", {
          query,
          selected: chosen.selected,
          rationale: chosen.rationale,
          candidates,
        });
        emit("plan_ready", {
          runId,
          query,
          queryPlan: bundled.queryPlan,
          resolver: {
            selected: chosen.selected,
            rationale: chosen.rationale,
            candidates,
          },
        });
        stepRequestLog(log, "run_case.resolver_selected", {
          selectedDiseaseId: chosen.selected.id,
          selectedDiseaseName: chosen.selected.name,
          candidateCount: candidates.length,
        });

        emit("narration_delta", {
          id: `run-${runId}-planner-ready`,
          ts: new Date().toISOString(),
          kind: "phase",
          title: "Planner ready",
          detail: `Anchors resolved for ${chosen.selected.name}. Launching agentic branch exploration.`,
          source: "planner",
          pathState: "active",
          entities: [
            {
              type: "disease",
              label: chosen.selected.name,
              primaryId: chosen.selected.id,
            },
          ],
        });

        discovererPromise = withTimeout(
          runDeepDiscoverer({
            diseaseQuery: chosen.selected.name,
            diseaseIdHint: chosen.selected.id,
            question: query,
            emitJourney,
          }),
          DISCOVERER_TIMEOUT_MS,
        )
          .then((final) => {
            discovererFinal = final;
            return final;
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : "agent discoverer failed";
            warnRequestLog(log, "run_case.agent_discoverer_failed", {
              message,
            });
            emit("run_error", {
              phase: "agent_discoverer",
              message,
              recoverable: true,
            });
            emit("narration_delta", {
              id: `run-${runId}-agent-warning`,
              ts: new Date().toISOString(),
              kind: "warning",
              title: "Agent branch degraded",
              detail: message,
              source: "agent",
              pathState: "candidate",
              entities: [],
            });
            return null;
          });

        const plannedTargetSeeds = [
          ...(resolvedQueryPlan?.anchors ?? [])
            .filter((anchor) => anchor.entityType === "target")
            .map((anchor) => anchor.name.trim().toUpperCase())
            .filter((value) => value.length >= 2),
          ...extractSymbolSeedTargets(query),
        ]
          .filter((value, index, all) => all.indexOf(value) === index)
          .slice(0, 12);
        const diseaseAnchorsFromPlan = (resolvedQueryPlan?.anchors ?? [])
          .filter((anchor) => anchor.entityType === "disease")
          .map((anchor) => ({
            id: anchor.id,
            name: anchor.name,
            description: anchor.description,
          }));
        const planSecondaryCandidates = diseaseAnchorsFromPlan.filter(
          (candidate) =>
            candidate.id !== chosen.selected.id &&
            !/^HP_/i.test(candidate.id),
        );
        const mentionSecondaryCandidates = mentionAnchoredMatches
          .filter(
            (item) =>
              item.disease.id !== chosen.selected.id &&
              item.score >= 1.25 &&
              !/^HP_/i.test(item.disease.id),
          )
          .map((item) => item.disease);
        const secondaryDiseaseCandidates = (
          relationQuery
            ? dedupeDistinctDiseases(
                mergeDiseaseCandidates(planSecondaryCandidates, mentionSecondaryCandidates),
              )
            : []
        )
          .filter((candidate) => !isSameDiseaseCandidate(candidate, chosen.selected))
          .slice(0, 3);

        const bridgePatch = buildCrossDiseaseBridgePatch(chosen.selected, secondaryDiseaseCandidates);
        if (bridgePatch.nodes.length > 0 || bridgePatch.edges.length > 0) {
          for (const node of bridgePatch.nodes) {
            nodeMap.set(node.id, node);
          }
          for (const edge of bridgePatch.edges) {
            edgeMap.set(edge.id, edge);
          }
          emitGraphDelta(bridgePatch.nodes, bridgePatch.edges);
          emit("path_update", {
            nodeIds: [
              makeNodeId("disease", chosen.selected.id),
              ...bridgePatch.secondaryNodeIds,
            ],
            edgeIds: bridgePatch.bridgeEdgeIds,
            summary:
              secondaryDiseaseCandidates.length > 0
                ? `Cross-disease mechanism hypothesis: ${chosen.selected.name} ↔ ${secondaryDiseaseCandidates
                    .map((item) => item.name)
                    .join(" / ")}`
                : `Disease anchor set: ${chosen.selected.name}`,
          });
        }

        const profile = modeConfig();
        const internalParams = new URLSearchParams({
          runId,
          diseaseQuery: chosen.selected.name,
          diseaseId: chosen.selected.id,
          maxTargets: String(profile.maxTargets),
          pathways: String(profile.pathways),
          drugs: String(profile.drugs),
          interactions: String(profile.interactions),
          literature: String(profile.literature),
        });
        if (plannedTargetSeeds.length > 0) {
          internalParams.set("seedTargets", [...new Set(plannedTargetSeeds)].slice(0, 12).join(","));
        }

        preStreamHeartbeatMessage = "Connecting evidence graph stream";
        preStreamHeartbeatPct = 16;
        const { response, origin: internalOrigin } = await fetchInternalStream(
          request,
          `/api/streamGraph?${internalParams.toString()}`,
          streamAbort.signal,
          requestApiKey,
        );
        if (preStreamHeartbeat) {
          clearInterval(preStreamHeartbeat);
          preStreamHeartbeat = null;
        }
        stepRequestLog(log, "run_case.internal_stream_connected", {
          origin: internalOrigin,
        });
        if (!response.body) {
          throw new Error("streamGraph stream body missing");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const emitRecommendationFromCurrentState = (
          currentRanking: RankingResponse | null,
          provisional: boolean,
        ) => {
          const livePathUpdate = derivePathUpdate(nodeMap, edgeMap, resolvedQueryPlan);
          const brief = generateBriefSections({
            ranking: currentRanking,
            nodeMap,
            edgeMap,
            sourceHealth,
            semanticConceptMentions: semanticConceptMentionsEarly,
            semanticTargetSymbols: semanticTargetSymbolsEarly,
            hasInterventionConcept: hasInterventionConceptEarly,
            queryAnchorCount: (resolvedQueryPlan?.anchors ?? []).length,
            pathFocusTargetSymbols: extractPathFocusTargetSymbols(livePathUpdate, nodeMap),
            enrichmentLinksByNodeId,
          });

          if (!brief.recommendation || brief.recommendation.target === "not provided") {
            return;
          }

          const signature = [
            provisional ? "provisional" : "final",
            brief.recommendation.target,
            brief.recommendation.pathway,
            brief.recommendation.score.toFixed(3),
          ].join("::");
          if (signature === lastRecommendationSignature) return;
          lastRecommendationSignature = signature;
          if (provisional) {
            lastProvisionalEmitMs = Date.now();
          }

          emit("brief_section", {
            section: "recommendation",
            data: {
              ...brief.recommendation,
              provisional,
            },
          });
        };

        while (true) {
          if (streamState.closed || streamAbort.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            break;
          }
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let splitIdx = buffer.indexOf("\n\n");
          while (splitIdx !== -1) {
            const block = buffer.slice(0, splitIdx);
            buffer = buffer.slice(splitIdx + 2);
            splitIdx = buffer.indexOf("\n\n");

            const parsed = parseSseBlock(block);
            if (!parsed) continue;

            try {
              const payload = JSON.parse(parsed.data) as unknown;

              if (parsed.event === "status") {
                const status = payload as CaseStatusEvent;
                sourceHealth = status.sourceHealth ?? sourceHealth;
                const pct = Math.max(0, Math.min(100, Number(status.pct) || 0));
                const forwardedPct = pct >= 100 ? 84 : mapBaselineProgress(pct);
                const forwardedMessage =
                  pct >= 100
                    ? "Baseline graph build complete; consolidating evidence and generating final answer"
                    : status.message;
                const absoluteElapsedMs = Date.now() - startedAt;

                emit("status", {
                  phase: status.phase,
                  message: forwardedMessage,
                  pct: forwardedPct,
                  elapsedMs: absoluteElapsedMs,
                  partial: status.partial ?? false,
                  counts: status.counts,
                  sourceHealth: status.sourceHealth,
                });

                const stepTitle = compactText(
                  forwardedMessage
                    .replace(/\s+/g, " ")
                    .split(/[.!?]/)[0]
                    ?.trim() || status.phase,
                  110,
                );
                const stepDetail = [
                  forwardedMessage,
                  status.counts && Object.keys(status.counts).length > 0
                    ? Object.entries(status.counts)
                        .map(([key, val]) => `${key}:${val}`)
                        .join(" • ")
                    : null,
                ]
                  .filter(Boolean)
                  .join(" • ");
                const stepSignature = `${status.phase}::${stepTitle}::${stepDetail
                  .toLowerCase()
                  .replace(/\d+/g, "#")}`;
                if (stepSignature !== lastAgentStepSignature) {
                  lastAgentStepSignature = stepSignature;
                  emit("agent_step", {
                    phase: status.phase,
                    title: stepTitle,
                    detail: stepDetail,
                  });
                  emit("narration_delta", {
                    id: `run-${runId}-status-${status.phase}-${absoluteElapsedMs}`,
                    ts: new Date().toISOString(),
                    kind: "phase",
                    title: stepTitle,
                    detail: stepDetail,
                    source: "agent",
                    pathState: "active",
                    entities: [],
                  });
                }
              } else if (parsed.event === "partial_graph") {
                const graph = payload as GraphPatchEvent;
                for (const node of graph.nodes) {
                  nodeMap.set(node.id, node);
                }
                for (const edge of graph.edges) {
                  edgeMap.set(edge.id, edge);
                }

                emitGraphDelta(graph.nodes, graph.edges);

                const pathUpdate = derivePathUpdate(nodeMap, edgeMap, resolvedQueryPlan);
                if (pathUpdate) {
                  const signature = `${pathUpdate.nodeIds.join("|")}::${pathUpdate.edgeIds.join("|")}`;
                  if (signature !== lastPathSignature) {
                    lastPathSignature = signature;
                    const pathSummary =
                      pathUpdate.connectedAcrossAnchors === false
                        ? `Partial anchor path: ${pathUpdate.summary}`
                        : pathUpdate.summary;
                    emit("path_update", {
                      ...pathUpdate,
                      summary: compactText(pathSummary, 150),
                    });
                  }
                }

                if (!ranking && Date.now() - lastProvisionalEmitMs >= 650) {
                  emitRecommendationFromCurrentState(null, true);
                }
              } else if (parsed.event === "ranking") {
                ranking = payload as RankingResponse;
                emitRecommendationFromCurrentState(ranking, false);
              } else if (parsed.event === "enrichment_ready") {
                const data = payload as {
                  linksByNodeId?: EnrichmentLinksByNodeId;
                };
                if (data.linksByNodeId && typeof data.linksByNodeId === "object") {
                  enrichmentLinksByNodeId = data.linksByNodeId;
                }
              } else if (parsed.event === "error") {
                const errorPayload = payload as { phase?: string; message?: string };
                if ((payload as { recoverable?: boolean }).recoverable) {
                  emit("agent_step", {
                    phase: errorPayload.phase ?? "PX",
                    title: "Source degraded",
                    detail: errorPayload.message ?? "Recoverable degradation",
                  });
                  emit("run_error", {
                    phase: errorPayload.phase ?? "PX",
                    message: errorPayload.message ?? "Recoverable degradation",
                    recoverable: true,
                  });
                  warnRequestLog(log, "run_case.internal_warning", {
                    phase: errorPayload.phase,
                    message: errorPayload.message,
                    recoverable: true,
                  });
                  continue;
                }

                emit("error", payload);
                emit("run_error", {
                  phase: errorPayload.phase ?? "PX",
                  message: errorPayload.message ?? "unknown run error",
                  recoverable: false,
                });
                warnRequestLog(log, "run_case.internal_warning", {
                  phase: errorPayload.phase,
                  message: errorPayload.message,
                });
              } else if (parsed.event === "done") {
                if (secondaryDiseaseCandidates.length > 0) {
                  const primaryNodeId = makeNodeId("disease", chosen.selected.id);
                  const primaryTargetSymbols = [...nodeMap.values()]
                    .filter((node) => node.type === "target")
                    .map((node) => String(node.meta.targetSymbol ?? node.label));
                  const outcomes = await evaluateCrossDiseaseBridge({
                    primaryTargetSymbols,
                    secondaryDiseases: secondaryDiseaseCandidates,
                  });

                  if (outcomes.length > 0) {
                    const bridgeEdges = new Map<string, GraphEdge>();
                    const bridgeNodes = new Map<string, GraphNode>();
                    const bridgeSupportEdges = new Map<string, GraphEdge>();
                    const connectedOutcomes = outcomes.filter((item) => item.connected);
                    const connectedSegments: Array<{
                      nodeIds: string[];
                      edgeIds: string[];
                      summary: string;
                      score: number;
                    }> = [];

                    const ensureDiseaseNode = (disease: DiseaseCandidate, role: "query_anchor_primary" | "query_anchor_secondary") => {
                      const nodeId = makeNodeId("disease", disease.id);
                      if (nodeMap.has(nodeId)) return nodeId;
                      const node: GraphNode = {
                        id: nodeId,
                        type: "disease",
                        primaryId: disease.id,
                        label: compactName(disease.name, 44),
                        score: role === "query_anchor_primary" ? 1 : 0.42,
                        size: role === "query_anchor_primary" ? 64 : 44,
                        meta: {
                          displayName: disease.name,
                          description: disease.description,
                          role,
                        },
                      };
                      nodeMap.set(nodeId, node);
                      bridgeNodes.set(node.id, node);
                      return nodeId;
                    };

                    const ensureBridgeTargetNode = (
                      symbolRaw: string,
                      context: {
                        fromDisease: string;
                        toDisease: string;
                        bridgeType: "shared_target" | "pathway" | "interaction";
                      },
                    ) => {
                      const symbol = normalizeTargetSymbol(symbolRaw);
                      if (!symbol) return null;
                      const existingTargetNode = findTargetNodeBySymbol(nodeMap, symbol);
                      if (existingTargetNode) return existingTargetNode;

                      const targetNodeId = makeNodeId("target", symbol);
                      const created: GraphNode = {
                        id: targetNodeId,
                        type: "target",
                        primaryId: symbol,
                        label: symbol,
                        score: 0.46,
                        size: 34,
                        meta: {
                          targetSymbol: symbol,
                          displayName: symbol,
                          source: "query_bridge",
                          bridgeType: context.bridgeType,
                          note:
                            context.bridgeType === "shared_target"
                              ? `Shared target bridge intermediate between ${context.fromDisease} and ${context.toDisease}.`
                              : context.bridgeType === "pathway"
                                ? `Pathway bridge target candidate between ${context.fromDisease} and ${context.toDisease}.`
                                : `Interaction bridge target candidate between ${context.fromDisease} and ${context.toDisease}.`,
                        },
                      };
                      nodeMap.set(created.id, created);
                      bridgeNodes.set(created.id, created);
                      return created;
                    };

                    const ensureBridgePathwayNode = (pathwayId: string, pathwayName: string) => {
                      const id = pathwayId.trim();
                      if (!id) return null;
                      const nodeId = makeNodeId("pathway", id);
                      const existing = nodeMap.get(nodeId);
                      if (existing) return existing;
                      const created: GraphNode = {
                        id: nodeId,
                        type: "pathway",
                        primaryId: id,
                        label: compactName(pathwayName || id, 40),
                        score: 0.5,
                        size: 30,
                        meta: {
                          displayName: pathwayName || id,
                          source: "query_bridge",
                          bridgeType: "pathway",
                          note: "Shared pathway context discovered while testing cross-anchor bridge.",
                        },
                      };
                      nodeMap.set(created.id, created);
                      bridgeNodes.set(created.id, created);
                      return created;
                    };

                    const upsertDiseaseTargetEdge = (options: {
                      sourceDiseaseNodeId: string;
                      targetNodeId: string;
                      targetSymbol: string;
                      fromDisease: string;
                      toDisease: string;
                      bridgeType: "shared_target" | "pathway" | "interaction";
                      weightFloor?: number;
                    }) => {
                      const edgeId = makeEdgeId(options.sourceDiseaseNodeId, options.targetNodeId, "disease_target");
                      const existing = edgeMap.get(edgeId);
                      const existingWeight = existing?.weight ?? 0;
                      const updated: GraphEdge = {
                        id: edgeId,
                        source: options.sourceDiseaseNodeId,
                        target: options.targetNodeId,
                        type: "disease_target",
                        weight: Math.max(existingWeight, options.weightFloor ?? 0.52),
                        meta: {
                          ...(existing?.meta ?? {}),
                          source: existing?.meta.source ?? "query_bridge",
                          status: "connected",
                          bridgeType: options.bridgeType,
                          bridgeSharedTarget: options.targetSymbol,
                          note: `Bridge evidence (${options.bridgeType}) links ${options.fromDisease} to ${options.toDisease} via ${options.targetSymbol}.`,
                        },
                      };
                      edgeMap.set(edgeId, updated);
                      bridgeSupportEdges.set(edgeId, updated);
                      return updated;
                    };

                    const upsertTargetPathwayEdge = (options: {
                      targetNodeId: string;
                      pathwayNodeId: string;
                      targetSymbol: string;
                      pathwayName: string;
                    }) => {
                      const edgeId = makeEdgeId(options.targetNodeId, options.pathwayNodeId, "target_pathway");
                      const existing = edgeMap.get(edgeId);
                      const next: GraphEdge = {
                        id: edgeId,
                        source: options.targetNodeId,
                        target: options.pathwayNodeId,
                        type: "target_pathway",
                        weight: Math.max(existing?.weight ?? 0, 0.54),
                        meta: {
                          ...(existing?.meta ?? {}),
                          source: existing?.meta.source ?? "query_bridge",
                          status: "connected",
                          bridgeType: "pathway",
                          note: `Pathway bridge: ${options.targetSymbol} maps to ${options.pathwayName}.`,
                        },
                      };
                      edgeMap.set(edgeId, next);
                      bridgeEdges.set(edgeId, next);
                      return next;
                    };

                    const upsertTargetInteractionEdge = (options: {
                      sourceTargetNodeId: string;
                      targetTargetNodeId: string;
                      sourceTargetSymbol: string;
                      targetTargetSymbol: string;
                      bridgeVia?: string;
                      score?: number;
                    }) => {
                      const edgeId = makeEdgeId(
                        options.sourceTargetNodeId,
                        options.targetTargetNodeId,
                        "target_target",
                      );
                      const existing = edgeMap.get(edgeId);
                      const next: GraphEdge = {
                        id: edgeId,
                        source: options.sourceTargetNodeId,
                        target: options.targetTargetNodeId,
                        type: "target_target",
                        weight: Math.max(existing?.weight ?? 0, options.score ?? 0.62),
                        meta: {
                          ...(existing?.meta ?? {}),
                          source: existing?.meta.source ?? "query_bridge",
                          status: "connected",
                          bridgeType: "interaction",
                          bridgeVia: options.bridgeVia,
                          note: options.bridgeVia
                            ? `Interaction bridge: ${options.sourceTargetSymbol} links to ${options.targetTargetSymbol} via ${options.bridgeVia}.`
                            : `Interaction bridge: ${options.sourceTargetSymbol} links to ${options.targetTargetSymbol}.`,
                        },
                      };
                      edgeMap.set(edgeId, next);
                      bridgeEdges.set(edgeId, next);
                      return next;
                    };

                    ensureDiseaseNode(chosen.selected, "query_anchor_primary");
                    for (const outcome of outcomes) {
                      const secondaryNodeId = ensureDiseaseNode(outcome.disease, "query_anchor_secondary");
                      const edgeId = makeEdgeId(primaryNodeId, secondaryNodeId, "disease_disease");
                      const existing = edgeMap.get(edgeId);
                      const sharedSymbols = outcome.sharedTargets
                        .map((symbol) => normalizeTargetSymbol(symbol))
                        .filter((symbol, index, all) => symbol.length > 0 && all.indexOf(symbol) === index)
                        .slice(0, 3);
                      const pathwayLinks = outcome.pathwayLinks
                        .map((item) => ({
                          pathwayId: item.pathwayId.trim(),
                          pathwayName: item.pathwayName.trim(),
                          primaryTarget: normalizeTargetSymbol(item.primaryTarget),
                          secondaryTarget: normalizeTargetSymbol(item.secondaryTarget),
                        }))
                        .filter(
                          (item) =>
                            item.pathwayId.length > 0 &&
                            item.pathwayName.length > 0 &&
                            item.primaryTarget.length > 0 &&
                            item.secondaryTarget.length > 0,
                        )
                        .slice(0, 3);
                      const interactionLinks = outcome.interactionLinks
                        .map((item) => ({
                          primaryTarget: normalizeTargetSymbol(item.primaryTarget),
                          secondaryTarget: normalizeTargetSymbol(item.secondaryTarget),
                          viaTarget: item.viaTarget ? normalizeTargetSymbol(item.viaTarget) : undefined,
                          score: item.score,
                        }))
                        .filter(
                          (item) =>
                            item.primaryTarget.length > 0 &&
                            item.secondaryTarget.length > 0 &&
                            item.primaryTarget !== item.secondaryTarget,
                        )
                        .slice(0, 3);

                      const pairSegments: Array<{
                        nodeIds: string[];
                        edgeIds: string[];
                        summary: string;
                        score: number;
                        bridgeKind: "shared_target" | "pathway" | "interaction";
                      }> = [];

                      if (outcome.connected && sharedSymbols.length > 0) {
                        for (const sharedSymbol of sharedSymbols.slice(0, 2)) {
                          const targetNode = ensureBridgeTargetNode(sharedSymbol, {
                            fromDisease: chosen.selected.name,
                            toDisease: outcome.disease.name,
                            bridgeType: "shared_target",
                          });
                          if (!targetNode) continue;

                          const primaryEdge = upsertDiseaseTargetEdge({
                            sourceDiseaseNodeId: primaryNodeId,
                            targetNodeId: targetNode.id,
                            targetSymbol: sharedSymbol,
                            fromDisease: chosen.selected.name,
                            toDisease: outcome.disease.name,
                            bridgeType: "shared_target",
                            weightFloor: 0.56,
                          });
                          const secondaryEdge = upsertDiseaseTargetEdge({
                            sourceDiseaseNodeId: secondaryNodeId,
                            targetNodeId: targetNode.id,
                            targetSymbol: sharedSymbol,
                            fromDisease: outcome.disease.name,
                            toDisease: chosen.selected.name,
                            bridgeType: "shared_target",
                            weightFloor: 0.56,
                          });

                          pairSegments.push({
                            nodeIds: [primaryNodeId, targetNode.id, secondaryNodeId],
                            edgeIds: [primaryEdge.id, secondaryEdge.id],
                            summary: `${chosen.selected.name} -> ${sharedSymbol} -> ${outcome.disease.name}`,
                            score: (primaryEdge.weight ?? 0.4) + (secondaryEdge.weight ?? 0.4),
                            bridgeKind: "shared_target",
                          });
                        }
                      }

                      for (const link of pathwayLinks) {
                        const primaryTargetNode = ensureBridgeTargetNode(link.primaryTarget, {
                          fromDisease: chosen.selected.name,
                          toDisease: outcome.disease.name,
                          bridgeType: "pathway",
                        });
                        const secondaryTargetNode = ensureBridgeTargetNode(link.secondaryTarget, {
                          fromDisease: outcome.disease.name,
                          toDisease: chosen.selected.name,
                          bridgeType: "pathway",
                        });
                        const pathwayNode = ensureBridgePathwayNode(link.pathwayId, link.pathwayName);
                        if (!primaryTargetNode || !secondaryTargetNode || !pathwayNode) continue;

                        const primaryDiseaseEdge = upsertDiseaseTargetEdge({
                          sourceDiseaseNodeId: primaryNodeId,
                          targetNodeId: primaryTargetNode.id,
                          targetSymbol: link.primaryTarget,
                          fromDisease: chosen.selected.name,
                          toDisease: outcome.disease.name,
                          bridgeType: "pathway",
                          weightFloor: 0.53,
                        });
                        const secondaryDiseaseEdge = upsertDiseaseTargetEdge({
                          sourceDiseaseNodeId: secondaryNodeId,
                          targetNodeId: secondaryTargetNode.id,
                          targetSymbol: link.secondaryTarget,
                          fromDisease: outcome.disease.name,
                          toDisease: chosen.selected.name,
                          bridgeType: "pathway",
                          weightFloor: 0.53,
                        });
                        const primaryPathwayEdge = upsertTargetPathwayEdge({
                          targetNodeId: primaryTargetNode.id,
                          pathwayNodeId: pathwayNode.id,
                          targetSymbol: link.primaryTarget,
                          pathwayName: link.pathwayName,
                        });
                        const secondaryPathwayEdge = upsertTargetPathwayEdge({
                          targetNodeId: secondaryTargetNode.id,
                          pathwayNodeId: pathwayNode.id,
                          targetSymbol: link.secondaryTarget,
                          pathwayName: link.pathwayName,
                        });

                        pairSegments.push({
                          nodeIds: [
                            primaryNodeId,
                            primaryTargetNode.id,
                            pathwayNode.id,
                            secondaryTargetNode.id,
                            secondaryNodeId,
                          ],
                          edgeIds: [
                            primaryDiseaseEdge.id,
                            primaryPathwayEdge.id,
                            secondaryPathwayEdge.id,
                            secondaryDiseaseEdge.id,
                          ],
                          summary: `${chosen.selected.name} -> ${link.primaryTarget} -> ${link.pathwayName} -> ${link.secondaryTarget} -> ${outcome.disease.name}`,
                          score:
                            (primaryDiseaseEdge.weight ?? 0.4) +
                            (primaryPathwayEdge.weight ?? 0.4) +
                            (secondaryPathwayEdge.weight ?? 0.4) +
                            (secondaryDiseaseEdge.weight ?? 0.4),
                          bridgeKind: "pathway",
                        });
                      }

                      for (const link of interactionLinks) {
                        const primaryTargetNode = ensureBridgeTargetNode(link.primaryTarget, {
                          fromDisease: chosen.selected.name,
                          toDisease: outcome.disease.name,
                          bridgeType: "interaction",
                        });
                        const secondaryTargetNode = ensureBridgeTargetNode(link.secondaryTarget, {
                          fromDisease: outcome.disease.name,
                          toDisease: chosen.selected.name,
                          bridgeType: "interaction",
                        });
                        if (!primaryTargetNode || !secondaryTargetNode) continue;

                        const primaryDiseaseEdge = upsertDiseaseTargetEdge({
                          sourceDiseaseNodeId: primaryNodeId,
                          targetNodeId: primaryTargetNode.id,
                          targetSymbol: link.primaryTarget,
                          fromDisease: chosen.selected.name,
                          toDisease: outcome.disease.name,
                          bridgeType: "interaction",
                          weightFloor: 0.52,
                        });
                        const secondaryDiseaseEdge = upsertDiseaseTargetEdge({
                          sourceDiseaseNodeId: secondaryNodeId,
                          targetNodeId: secondaryTargetNode.id,
                          targetSymbol: link.secondaryTarget,
                          fromDisease: outcome.disease.name,
                          toDisease: chosen.selected.name,
                          bridgeType: "interaction",
                          weightFloor: 0.52,
                        });

                        if (link.viaTarget) {
                          const viaNode = ensureBridgeTargetNode(link.viaTarget, {
                            fromDisease: chosen.selected.name,
                            toDisease: outcome.disease.name,
                            bridgeType: "interaction",
                          });
                          if (!viaNode) continue;

                          const primaryVia = upsertTargetInteractionEdge({
                            sourceTargetNodeId: primaryTargetNode.id,
                            targetTargetNodeId: viaNode.id,
                            sourceTargetSymbol: link.primaryTarget,
                            targetTargetSymbol: link.viaTarget,
                            bridgeVia: link.viaTarget,
                            score: Math.max(0.5, link.score || 0.62),
                          });
                          const viaSecondary = upsertTargetInteractionEdge({
                            sourceTargetNodeId: viaNode.id,
                            targetTargetNodeId: secondaryTargetNode.id,
                            sourceTargetSymbol: link.viaTarget,
                            targetTargetSymbol: link.secondaryTarget,
                            bridgeVia: link.viaTarget,
                            score: Math.max(0.5, link.score || 0.62),
                          });

                          pairSegments.push({
                            nodeIds: [
                              primaryNodeId,
                              primaryTargetNode.id,
                              viaNode.id,
                              secondaryTargetNode.id,
                              secondaryNodeId,
                            ],
                            edgeIds: [
                              primaryDiseaseEdge.id,
                              primaryVia.id,
                              viaSecondary.id,
                              secondaryDiseaseEdge.id,
                            ],
                            summary: `${chosen.selected.name} -> ${link.primaryTarget} -> ${link.viaTarget} -> ${link.secondaryTarget} -> ${outcome.disease.name}`,
                            score:
                              (primaryDiseaseEdge.weight ?? 0.4) +
                              (primaryVia.weight ?? 0.4) +
                              (viaSecondary.weight ?? 0.4) +
                              (secondaryDiseaseEdge.weight ?? 0.4),
                            bridgeKind: "interaction",
                          });
                          continue;
                        }

                        const directInteraction = upsertTargetInteractionEdge({
                          sourceTargetNodeId: primaryTargetNode.id,
                          targetTargetNodeId: secondaryTargetNode.id,
                          sourceTargetSymbol: link.primaryTarget,
                          targetTargetSymbol: link.secondaryTarget,
                          score: Math.max(0.5, link.score || 0.62),
                        });
                        pairSegments.push({
                          nodeIds: [
                            primaryNodeId,
                            primaryTargetNode.id,
                            secondaryTargetNode.id,
                            secondaryNodeId,
                          ],
                          edgeIds: [
                            primaryDiseaseEdge.id,
                            directInteraction.id,
                            secondaryDiseaseEdge.id,
                          ],
                          summary: `${chosen.selected.name} -> ${link.primaryTarget} -> ${link.secondaryTarget} -> ${outcome.disease.name}`,
                          score:
                            (primaryDiseaseEdge.weight ?? 0.4) +
                            (directInteraction.weight ?? 0.4) +
                            (secondaryDiseaseEdge.weight ?? 0.4),
                          bridgeKind: "interaction",
                        });
                      }

                      connectedSegments.push(...pairSegments);
                      const strongestPairSegment = [...pairSegments].sort((a, b) => {
                        const hopDelta = b.nodeIds.length - a.nodeIds.length;
                        if (hopDelta !== 0) return hopDelta;
                        const edgeDelta = b.edgeIds.length - a.edgeIds.length;
                        if (edgeDelta !== 0) return edgeDelta;
                        return b.score - a.score;
                      })[0];
                      const hasConnectedEvidence = pairSegments.length > 0;
                      const bridgeKinds = [...new Set(pairSegments.map((item) => item.bridgeKind))];
                      const bridgeKindLabel =
                        bridgeKinds.length > 0 ? bridgeKinds.join(", ") : "none";

                      const updated: GraphEdge = {
                        id: edgeId,
                        source: primaryNodeId,
                        target: secondaryNodeId,
                        type: "disease_disease",
                        weight: hasConnectedEvidence ? 0.16 : 0.1,
                        meta: {
                          ...(existing?.meta ?? {}),
                          source: "query_anchor",
                          status: hasConnectedEvidence ? "connected" : "no_connection",
                          sharedTargets: sharedSymbols,
                          bridgeKinds,
                          note: hasConnectedEvidence
                            ? strongestPairSegment?.summary ??
                              `Mechanism path supported by ${bridgeKindLabel} evidence.`
                            : "No supported multihop mechanism path found in this run.",
                        },
                      };
                      edgeMap.set(edgeId, updated);
                      bridgeEdges.set(edgeId, updated);
                    }

                    const patchNodes = [...bridgeNodes.values()];
                    const patchEdges = [...bridgeSupportEdges.values(), ...bridgeEdges.values()];
                    emitGraphDelta(patchNodes, patchEdges);

                    const secondaryNames = outcomes.map((item) => item.disease.name).join(" / ");
                    const strongestSegment = [...connectedSegments].sort((a, b) => {
                      const hopDelta = b.nodeIds.length - a.nodeIds.length;
                      if (hopDelta !== 0) return hopDelta;
                      const edgeDelta = b.edgeIds.length - a.edgeIds.length;
                      if (edgeDelta !== 0) return edgeDelta;
                      return b.score - a.score;
                    })[0];
                    emit("path_update", {
                      nodeIds: strongestSegment?.nodeIds ?? [primaryNodeId, ...bridgePatch.secondaryNodeIds],
                      edgeIds: strongestSegment?.edgeIds ?? [...bridgeEdges.values()].map((edge) => edge.id),
                      summary:
                        strongestSegment
                          ? `Mechanism path confirmed: ${strongestSegment.summary}. ${Math.max(
                              0,
                              connectedOutcomes.length - 1,
                            )} additional connected anchor pair(s) retained in graph context.`
                          : `No strong multihop mechanism path found between ${chosen.selected.name} and ${secondaryNames} in this run.`,
                    });
                  }
                }

                const semanticTargetSymbols = (resolvedQueryPlan?.anchors ?? [])
                  .filter((anchor) => anchor.entityType === "target")
                  .map((anchor) => anchor.name);
                const semanticConceptMentions = [
                  ...(resolvedQueryPlan?.anchors ?? []).map((anchor) => anchor.mention),
                  ...llmRelationMentions,
                ]
                  .map((value) => value.trim())
                  .filter((value) => value.length >= 2)
                  .filter((value, index, all) => all.indexOf(value) === index);
                const hasInterventionConcept = (resolvedQueryPlan?.anchors ?? []).some(
                  (anchor) => anchor.requestedType === "intervention" || anchor.entityType === "drug",
                );
                const initialPathUpdate = derivePathUpdate(
                  nodeMap,
                  edgeMap,
                  resolvedQueryPlan,
                );

                let brief = mergeSupplementalEvidenceIntoBrief(
                  generateBriefSections({
                    ranking,
                    nodeMap,
                    edgeMap,
                    sourceHealth,
                    semanticConceptMentions,
                    semanticTargetSymbols,
                    hasInterventionConcept,
                    queryAnchorCount: (resolvedQueryPlan?.anchors ?? []).length,
                    pathFocusTargetSymbols: extractPathFocusTargetSymbols(
                      initialPathUpdate,
                      nodeMap,
                    ),
                    enrichmentLinksByNodeId,
                  }),
                  supplementalEvidence,
                );

                const emitBriefSnapshot = (
                  snapshot: ReturnType<typeof generateBriefSections>,
                ) => {
                  emit("brief_section", {
                    section: "final_brief",
                    data: snapshot,
                  });

                  emit("citation_bundle", {
                    sections: [
                      {
                        section: "final_scientific_answer",
                        citationIndices: (snapshot.citations ?? []).map(
                          (citation) => citation.index,
                        ),
                      },
                    ],
                    citations: snapshot.citations ?? [],
                  });
                };

                emit("status", {
                  phase: "P6",
                  message: "Consolidating evidence coverage and scoring mechanism threads",
                  pct: 80,
                  elapsedMs: Date.now() - startedAt,
                  partial: true,
                  counts: {
                    nodes: nodeMap.size,
                    edges: edgeMap.size,
                  },
                  sourceHealth,
                });

                emitBriefSnapshot(brief);

                emit("status", {
                  phase: "P6",
                  message: "Compiling citation ledger and preparing scientific synthesis",
                  pct: 84,
                  elapsedMs: Date.now() - startedAt,
                  partial: true,
                  counts: {
                    nodes: nodeMap.size,
                    edges: edgeMap.size,
                  },
                  sourceHealth,
                });

                if (discovererPromise) {
                  emit("status", {
                    phase: "P6",
                    message: "Generating final scientific answer from mapped evidence",
                    pct: 86,
                    elapsedMs: Date.now() - startedAt,
                    partial: true,
                    counts: {
                      nodes: nodeMap.size,
                      edges: edgeMap.size,
                    },
                    sourceHealth,
                  });

                  const synthesisStartedAt = Date.now();
                  const synthesisBudgetMs = Math.max(
                    90_000,
                    DISCOVERER_TIMEOUT_MS - (synthesisStartedAt - startedAt) - 30_000,
                  );
                  const synthesisProgressWindowMs = Math.max(
                    120_000,
                    Math.min(9 * 60 * 1000, synthesisBudgetMs),
                  );
                  const synthesisHeartbeat = setInterval(() => {
                    if (streamState.closed || streamAbort.signal.aborted) return;
                    const elapsed = Math.max(0, Date.now() - synthesisStartedAt);
                    const waitingSeconds = Math.floor(elapsed / 1000);
                    const ratio = Math.min(0.99, elapsed / synthesisProgressWindowMs);
                    const pct = Math.max(
                      86,
                      Math.min(98, 86 + Math.floor(ratio * 12)),
                    );
                    emit("status", {
                      phase: "P6",
                      message:
                        waitingSeconds >= Math.floor(synthesisProgressWindowMs / 1000) * 0.6
                          ? "Synthesis still running; validating thread quality and caveats"
                          : "Synthesis running; assembling mechanism rationale and caveats",
                      pct,
                      elapsedMs: Date.now() - startedAt,
                      partial: true,
                      counts: {
                        nodes: nodeMap.size,
                        edges: edgeMap.size,
                      },
                      sourceHealth,
                    });
                  }, 5000);

                  try {
                    const final = await withTimeout(
                      discovererPromise,
                      Math.max(90_000, DISCOVERER_TIMEOUT_MS - 5_000),
                    ).catch(() => null);
                    if (final) {
                      discovererFinal = final;
                      ingestDiscovererFinalEvidenceBundle(
                        final.evidenceBundle,
                        supplementalEvidence,
                      );
                    }

                    const finalPathUpdate = derivePathUpdate(
                      nodeMap,
                      edgeMap,
                      resolvedQueryPlan,
                    );
                    brief = mergeSupplementalEvidenceIntoBrief(
                      generateBriefSections({
                        ranking,
                        nodeMap,
                        edgeMap,
                        sourceHealth,
                        semanticConceptMentions,
                        semanticTargetSymbols,
                        hasInterventionConcept,
                        queryAnchorCount: (resolvedQueryPlan?.anchors ?? []).length,
                        pathFocusTargetSymbols: extractPathFocusTargetSymbols(
                          finalPathUpdate,
                          nodeMap,
                        ),
                        enrichmentLinksByNodeId,
                      }),
                      supplementalEvidence,
                    );
                    emitBriefSnapshot(brief);

                    if (!final) {
                      const fallbackFinal = await synthesizeFallbackFinalAnswer({
                        query,
                        selectedDiseaseName: chosen.selected.name,
                        activePathSummary: finalPathUpdate?.summary ?? null,
                        brief,
                      }).catch(() => null);
                      if (fallbackFinal?.answer?.trim()) {
                        discovererFinal = fallbackFinal;
                        if (!discovererAnswerEmitted) {
                          emit("answer_delta", {
                            text: fallbackFinal.answer.trim(),
                            final: true,
                          });
                          emit("final_answer", fallbackFinal);
                          discovererAnswerEmitted = true;
                        }
                        emit("narration_delta", {
                          id: `run-${runId}-fallback-synthesis`,
                          ts: new Date().toISOString(),
                          kind: "warning",
                          title: "Fallback synthesis applied",
                          detail:
                            "Primary deep synthesis exceeded runtime budget; final answer generated from ranked evidence snapshot.",
                          source: "agent",
                          pathState: "candidate",
                          entities: [],
                        });
                      } else {
                        emit("run_error", {
                          phase: "agent_discoverer",
                          message:
                            "Final synthesis exceeded runtime budget; closing with baseline evidence summary.",
                          recoverable: true,
                        });
                      }
                    }

                    if (discovererFinal?.answer?.trim()) {
                      const groundedFinal =
                        (await groundFinalAnswerWithInlineCitations({
                          query,
                          draft: discovererFinal,
                          brief,
                          activePathSummary: finalPathUpdate?.summary ?? null,
                          graphPathContext: buildGraphPathContext({
                            pathUpdate: finalPathUpdate,
                            nodeMap,
                            edgeMap,
                          }),
                          queryPlan: resolvedQueryPlan,
                        }).catch(() => discovererFinal)) ?? discovererFinal;
                      discovererFinal = groundedFinal;
                      if (!discovererAnswerEmitted && groundedFinal.answer.trim().length > 0) {
                        emit("answer_delta", {
                          text: groundedFinal.answer.trim(),
                          final: true,
                        });
                        emit("final_answer", groundedFinal);
                        discovererAnswerEmitted = true;
                      }
                    }
                  } finally {
                    clearInterval(synthesisHeartbeat);
                  }
                }

                emit("status", {
                  phase: "P6",
                  message: "Final scientific answer ready; closing run",
                  pct: 99,
                  elapsedMs: Date.now() - startedAt,
                  partial: true,
                  counts: {
                    nodes: nodeMap.size,
                    edges: edgeMap.size,
                  },
                  sourceHealth,
                });

                const llmCost = getOpenAiRunSummary(runId);
                if (llmCost) {
                  emit("llm_cost", llmCost);
                }

                emit("status", {
                  phase: "P6",
                  message: "Build complete",
                  pct: 100,
                  elapsedMs: Date.now() - startedAt,
                  partial: false,
                  counts: {
                    nodes: nodeMap.size,
                    edges: edgeMap.size,
                  },
                  sourceHealth,
                });

                emit("run_completed", {
                  runId,
                  elapsedMs: Date.now() - startedAt,
                  stats: {
                    nodes: nodeMap.size,
                    edges: edgeMap.size,
                  },
                  finalAnswer: discovererFinal,
                  llmCost,
                });
                const donePayload =
                  payload && typeof payload === "object"
                    ? (payload as Record<string, unknown>)
                    : {};
                emit("done", {
                  ...donePayload,
                  elapsedMs: Date.now() - startedAt,
                  streamStats:
                    donePayload.stats && typeof donePayload.stats === "object"
                      ? donePayload.stats
                      : null,
                  stats: {
                    totalNodes: nodeMap.size,
                    totalEdges: edgeMap.size,
                  },
                  counts: {
                    nodes: nodeMap.size,
                    edges: edgeMap.size,
                  },
                  finalAnswer: discovererFinal,
                  llmCost,
                });
                stepRequestLog(log, "run_case.done", {
                  nodeCount: nodeMap.size,
                  edgeCount: edgeMap.size,
                  llmCalls: llmCost?.totalCalls ?? 0,
                  llmTokens: llmCost?.totals.totalTokens ?? 0,
                  llmCostUsd: llmCost?.totals.estimatedCostUsd,
                });
              }
            } catch {
              // ignore malformed internal event payloads
            }
          }
        }

        if (preStreamHeartbeat) {
          clearInterval(preStreamHeartbeat);
          preStreamHeartbeat = null;
        }
        endRequestLog(log, {
          completed: true,
          nodeCount: nodeMap.size,
          edgeCount: edgeMap.size,
        });
        close();
      } catch (error) {
        if (preStreamHeartbeat) {
          clearInterval(preStreamHeartbeat);
          preStreamHeartbeat = null;
        }
        if (streamAbort.signal.aborted || streamState.closed) {
          endRequestLog(log, {
            completed: false,
            canceled: true,
            nodeCount: nodeMap.size,
            edgeCount: edgeMap.size,
          });
          close();
          return;
        }
        emit("error", {
          phase: "fatal",
          message: error instanceof Error ? error.message : "unknown error",
          recoverable: false,
        });
        emit("run_error", {
          phase: "fatal",
          message: error instanceof Error ? error.message : "unknown error",
          recoverable: false,
        });
        errorRequestLog(log, "run_case.fatal", error, {
          nodeCount: nodeMap.size,
          edgeCount: edgeMap.size,
        });
        endRequestLog(log, { completed: false });
        close();
      }
      }),
      );
    },
    cancel() {
      streamState.closed = true;
      streamAbort.abort("client disconnected");
      cleanupSessionRun();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const action = params.get("action")?.trim().toLowerCase();
  const sessionId = params.get("sessionId")?.trim() || null;
  const sessionKey = resolveSessionKey(request, sessionId);
  cleanupStaleSessionRuns();
  if (!action) {
    return new Response("missing action", { status: 400 });
  }

  if (action === "interrupt") {
    const active = activeSessionRuns.get(sessionKey);
    if (!active) {
      return Response.json({ ok: true, interrupted: false });
    }
    active.abortController.abort("interrupted by user");
    activeSessionRuns.delete(sessionKey);
    return Response.json({ ok: true, interrupted: true });
  }

  if (action === "set_api_key") {
    const posted = await readPostedApiKey(request);
    const normalized = normalizeApiKey(posted ?? "");
    if (!normalized) {
      return Response.json(
        {
          ok: false,
          error: "invalid_api_key_format",
        },
        { status: 400 },
      );
    }
    setSessionApiKey(sessionKey, normalized);
    return Response.json({
      ok: true,
      hasSessionApiKey: true,
    });
  }

  if (action === "clear_api_key") {
    clearSessionApiKey(sessionKey);
    return Response.json({
      ok: true,
      hasSessionApiKey: false,
    });
  }

  return new Response("unsupported action", { status: 400 });
}
