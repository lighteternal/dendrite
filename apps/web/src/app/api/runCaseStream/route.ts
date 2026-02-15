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
import { type ResolvedQueryPlan } from "@/server/agent/query-plan";
import { type DiseaseCandidate } from "@/server/openai/disease-resolver";
import {
  endRequestLog,
  errorRequestLog,
  startRequestLog,
  stepRequestLog,
  warnRequestLog,
} from "@/server/telemetry";

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
const DISEASE_SEARCH_TIMEOUT_MS = 7000;
const BUNDLED_RESOLUTION_TIMEOUT_MS = 45_000;
const INTERNAL_STREAM_CONNECT_TIMEOUT_MS = 12_000;
const SESSION_RUN_STALE_MS = 4 * 60 * 1000;

type ActiveSessionRun = {
  runId: string;
  sessionKey: string;
  startedAt: number;
  abortController: AbortController;
};

const activeSessionRuns = new Map<string, ActiveSessionRun>();

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
  const normalizeMention = (value: string) =>
    trimDiseaseNoise(value)
      .replace(/^(?:how|what|which|why)\s+(?:does|do|is|are|can|could|would|will|should)\s+/i, "")
      .replace(/^(?:how|what|which|why)\s+/i, "")
      .replace(/^(?:the|a|an)\s+/i, "")
      .trim();
  const addMention = (value: string) => {
    const mention = normalizeMention(String(value ?? ""));
    if (mention.length < 3) return;
    if (mention.split(/\s+/).filter(Boolean).length > 6) return;
    mentions.add(mention);
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

function derivePathUpdate(nodeMap: Map<string, GraphNode>, edgeMap: Map<string, GraphEdge>) {
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

function buildVerdictCitations(options: {
  selectedSymbol: string | null;
  evidenceTrace: Array<{
    symbol: string;
    refs: Array<{ field: string; value: string | number | boolean }>;
  }>;
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

  const selectedLinks =
    options.selectedTargetNodeId && options.enrichmentLinksByNodeId[options.selectedTargetNodeId]
      ? options.enrichmentLinksByNodeId[options.selectedTargetNodeId]
      : null;

  if (selectedLinks) {
    for (const article of selectedLinks.articles.slice(0, 3)) {
      pushCitation({
        kind: "article",
        label: normalizeCitationText(article.title, "Article evidence"),
        source: normalizeCitationText(article.source, "PubMed"),
        url: normalizeCitationUrl(article.url),
      });
    }
    for (const trial of selectedLinks.trials.slice(0, 2)) {
      const status =
        typeof trial.status === "string" && trial.status.trim().length > 0
          ? ` (${trial.status.trim()})`
          : "";
      pushCitation({
        kind: "trial",
        label: `${normalizeCitationText(trial.title, "Clinical trial evidence")}${status}`.slice(0, 180),
        source: normalizeCitationText(trial.source, "ClinicalTrials.gov"),
        url: normalizeCitationUrl(trial.url),
      });
    }
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
      .slice(0, 3);

    for (const ref of preferredMetricRefs) {
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
    return {
      recommendation: null,
      alternatives: [],
      evidenceTrace: [],
      citations: [],
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
  const boostedRanking = [...resolvedRanking.rankedTargets]
    .map((item) => ({
      item,
      boost: semanticTargetSet.has(item.symbol.toUpperCase()) ? 0.06 : 0,
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

  const shouldAnchorToQuery =
    hasInterventionConcept &&
    !!matchedQueryTarget &&
    (matchedQueryTarget.score >= 0.32 || matchedQueryTarget.rank <= 12) &&
    (baselineTop?.score ?? 0) - matchedQueryTarget.score <= 0.26;

  const selectedTop = shouldAnchorToQuery ? matchedQueryTarget : baselineTop;

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
    selectedTargetNodeId: selectedTargetNode?.id ?? null,
    enrichmentLinksByNodeId,
  });

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

      const emit = (event: string, data: unknown) => {
        if (streamState.closed) return;
        try {
          controller.enqueue(encodeEvent(event, data));
        } catch {
          streamState.closed = true;
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

        emit("status", {
          phase: "P0",
          message: "Resolving disease entity",
          pct: 2,
        });
        emitPreStreamStatus();
        preStreamHeartbeat = setInterval(() => {
          emitPreStreamStatus();
        }, 2500);

        let bundled: Awaited<ReturnType<typeof resolveQueryEntitiesBundle>>;
        preStreamHeartbeatMessage = "Resolving entities and canonical anchors";
        preStreamHeartbeatPct = 5;
        try {
          bundled = await withTimeout(
            resolveQueryEntitiesBundle(query),
            BUNDLED_RESOLUTION_TIMEOUT_MS,
          );
        } catch {
          const fallbackDiseasePhrase = trimDiseaseNoise(extractDiseasePhrase(query));
          const relationMentions = extractDiseaseAnchorMentions(query);
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
              ...extractDiseaseAnchorMentions(query),
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
        const relationQuery = /\b(and|between|vs|versus|connect|connection|relationship|link|overlap|common|shared)\b/i.test(
          query,
        );
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
        const relationMentions =
          typedDiseaseMentions.length > 0 ? typedDiseaseMentions : extractDiseaseAnchorMentions(query);
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
        const semanticConceptMentionsEarly = (resolvedQueryPlan?.anchors ?? []).map(
          (anchor) => anchor.mention,
        );
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
        stepRequestLog(log, "run_case.resolver_selected", {
          selectedDiseaseId: chosen.selected.id,
          selectedDiseaseName: chosen.selected.name,
          candidateCount: candidates.length,
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
          emit("graph_patch", {
            nodes: bridgePatch.nodes,
            edges: bridgePatch.edges,
            stats: {
              totalNodes: nodeMap.size,
              totalEdges: edgeMap.size,
            },
          });
          emit("path_update", {
            nodeIds: [
              makeNodeId("disease", chosen.selected.id),
              ...bridgePatch.secondaryNodeIds,
            ],
            edgeIds: bridgePatch.bridgeEdgeIds,
            summary:
              secondaryDiseaseCandidates.length > 0
                ? `Cross-disease bridge hypothesis: ${chosen.selected.name} ↔ ${secondaryDiseaseCandidates
                    .map((item) => item.name)
                    .join(" / ")}`
                : `Disease anchor set: ${chosen.selected.name}`,
          });
        }

        const profile = modeConfig();
        const internalParams = new URLSearchParams({
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
          const brief = generateBriefSections({
            ranking: currentRanking,
            nodeMap,
            edgeMap,
            sourceHealth,
            semanticConceptMentions: semanticConceptMentionsEarly,
            semanticTargetSymbols: semanticTargetSymbolsEarly,
            hasInterventionConcept: hasInterventionConceptEarly,
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

                emit("status", {
                  phase: status.phase,
                  message: status.message,
                  pct: status.pct,
                  elapsedMs: status.elapsedMs,
                  partial: status.partial ?? false,
                  counts: status.counts,
                  sourceHealth: status.sourceHealth,
                });

                const stepTitle = compactText(
                  status.message
                    .replace(/\s+/g, " ")
                    .split(/[.!?]/)[0]
                    ?.trim() || status.phase,
                  110,
                );
                const stepDetail = [
                  status.message,
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
                }
              } else if (parsed.event === "partial_graph") {
                const graph = payload as GraphPatchEvent;
                for (const node of graph.nodes) {
                  nodeMap.set(node.id, node);
                }
                for (const edge of graph.edges) {
                  edgeMap.set(edge.id, edge);
                }

                emit("graph_patch", graph);

                const pathUpdate = derivePathUpdate(nodeMap, edgeMap);
                if (pathUpdate) {
                  const signature = `${pathUpdate.nodeIds.join("|")}::${pathUpdate.edgeIds.join("|")}`;
                  if (signature !== lastPathSignature) {
                    lastPathSignature = signature;
                    emit("path_update", {
                      ...pathUpdate,
                      summary: compactText(pathUpdate.summary, 150),
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
                  warnRequestLog(log, "run_case.internal_warning", {
                    phase: errorPayload.phase,
                    message: errorPayload.message,
                    recoverable: true,
                  });
                  continue;
                }

                emit("error", payload);
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
                              `Bridge supported by ${bridgeKindLabel} evidence.`
                            : "No supported mechanistic bridge found in this run.",
                        },
                      };
                      edgeMap.set(edgeId, updated);
                      bridgeEdges.set(edgeId, updated);
                    }

                    const patchNodes = [...bridgeNodes.values()];
                    const patchEdges = [...bridgeSupportEdges.values(), ...bridgeEdges.values()];
                    emit("graph_patch", {
                      nodes: patchNodes,
                      edges: patchEdges,
                      stats: {
                        totalNodes: nodeMap.size,
                        totalEdges: edgeMap.size,
                      },
                    });

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
                          ? `Bridge confirmed: ${strongestSegment.summary}. ${Math.max(
                              0,
                              connectedOutcomes.length - 1,
                            )} additional connected anchor pair(s) retained in graph context.`
                          : `No strong mechanistic bridge found between ${chosen.selected.name} and ${secondaryNames} in this run.`,
                    });
                  }
                }

                const semanticTargetSymbols = (resolvedQueryPlan?.anchors ?? [])
                  .filter((anchor) => anchor.entityType === "target")
                  .map((anchor) => anchor.name);
                const semanticConceptMentions = (resolvedQueryPlan?.anchors ?? []).map(
                  (anchor) => anchor.mention,
                );
                const hasInterventionConcept = (resolvedQueryPlan?.anchors ?? []).some(
                  (anchor) => anchor.requestedType === "intervention" || anchor.entityType === "drug",
                );

                const brief = generateBriefSections({
                  ranking,
                  nodeMap,
                  edgeMap,
                  sourceHealth,
                  semanticConceptMentions,
                  semanticTargetSymbols,
                  hasInterventionConcept,
                  enrichmentLinksByNodeId,
                });

                emit("brief_section", {
                  section: "final_brief",
                  data: brief,
                });

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

                emit("done", payload);
                stepRequestLog(log, "run_case.done", {
                  nodeCount: nodeMap.size,
                  edgeCount: edgeMap.size,
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
        errorRequestLog(log, "run_case.fatal", error, {
          nodeCount: nodeMap.size,
          edgeCount: edgeMap.size,
        });
        endRequestLog(log, { completed: false });
        close();
      }
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
  if (!action) {
    return new Response("missing action", { status: 400 });
  }

  if (action === "interrupt") {
    const sessionKey = resolveSessionKey(request, sessionId);
    const active = activeSessionRuns.get(sessionKey);
    if (!active) {
      return Response.json({ ok: true, interrupted: false });
    }
    active.abortController.abort("interrupted by user");
    activeSessionRuns.delete(sessionKey);
    return Response.json({ ok: true, interrupted: true });
  }

  return new Response("unsupported action", { status: 400 });
}
