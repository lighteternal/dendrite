import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { makeEdgeId, makeNodeId } from "@/lib/graph";
import {
  planQuery,
  type QueryPlanAnchor,
  type QueryPlanFollowup,
  type ResolvedQueryPlan,
} from "@/server/agent/query-plan";
import { extractEvidenceEntitiesFast } from "@/server/agent/relation-mention-extractor";
import { getLiteratureAndTrials } from "@/server/mcp/biomcp";
import { getTargetActivityDrugs } from "@/server/mcp/chembl";
import {
  getPubmedArticles,
  searchPubmedByQuery,
  type PubmedArticle,
} from "@/server/mcp/pubmed";
import {
  getDiseaseTargetsSummary,
  getKnownDrugsForTarget,
  searchDiseases,
  searchDrugs,
  searchTargets,
} from "@/server/mcp/opentargets";
import { findPathwaysByGene } from "@/server/mcp/reactome";
import { getInteractionNetwork } from "@/server/mcp/stringdb";
import { appConfig } from "@/server/config";
import { getOpenAiApiKeyFromContext } from "@/server/openai/client";
import {
  handleOpenAiRateLimit,
  isOpenAiRateLimited,
} from "@/server/openai/rate-limit";
import { chooseDiscovererModel } from "@/server/openai/model-router";
import {
  createLangChainUsageCallback,
  getLangChainPromptCacheConfig,
  withOpenAiOperationContext,
} from "@/server/openai/cost-tracker";

export type DiscoverEntity = {
  type:
    | "disease"
    | "target"
    | "pathway"
    | "drug"
    | "interaction"
    | "phenotype"
    | "anatomy"
    | "effect"
    | "molecule"
    | "protein";
  label: string;
  primaryId?: string;
  evidenceCategory?: "exposure" | "mechanism" | "outcome";
};

export type DiscoverJourneyEntry = {
  id: string;
  ts: string;
  kind:
    | "phase"
    | "tool_start"
    | "tool_result"
    | "insight"
    | "warning"
    | "handoff"
    | "followup"
    | "branch";
  title: string;
  detail: string;
  source:
    | "agent"
    | "planner"
    | "opentargets"
    | "reactome"
    | "chembl"
    | "string"
    | "biomcp"
    | "pubmed"
    | "evidence";
  pathState?: "active" | "candidate" | "discarded";
  entities: DiscoverEntity[];
  graphPatch?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
};

export type DiscovererFinal = {
  answer: string;
  biomedicalCase: {
    title: string;
    whyAgentic: string;
  };
  focusThread: {
    pathway: string;
    target: string;
    drug: string;
  };
  keyFindings: string[];
  caveats: string[];
  nextActions: string[];
  evidenceBundle?: {
    articleSnippets: number;
    trialSnippets: number;
    citations: Array<{
      kind: "article" | "trial";
      label: string;
      source: string;
      url?: string;
    }>;
  };
};

type RunParams = {
  diseaseQuery: string;
  diseaseIdHint?: string;
  question: string;
  emitJourney: (entry: DiscoverJourneyEntry) => void;
};

type DiseaseInfo = {
  id: string;
  name: string;
  description?: string;
};

type TargetInfo = {
  id: string;
  symbol: string;
  name: string;
  score: number;
};

type PathwayInfo = {
  id: string;
  name: string;
};

type DrugInfo = {
  id: string;
  name: string;
  source: "opentargets" | "chembl";
};

type DiscoveryNode = {
  key: string;
  entity: DiscoverEntity;
};

type DiscoveryEdge = {
  id: string;
  sourceKey: string;
  targetKey: string;
  relation:
    | "query_anchor"
    | "disease_target"
    | "target_pathway"
    | "target_drug"
    | "target_target"
    | "pathway_target"
    | "pubmed_support";
  source:
    | "planner"
    | "agent"
    | "opentargets"
    | "reactome"
    | "chembl"
    | "string"
    | "biomcp"
    | "pubmed"
    | "evidence";
  score: number;
  note?: string;
};

type BridgePath = {
  nodeKeys: string[];
  edgeIds: string[];
};

type DiscoveryState = {
  queryPlan: ResolvedQueryPlan | null;
  diseaseById: Map<string, DiseaseInfo>;
  targetById: Map<string, TargetInfo>;
  pathwayById: Map<string, PathwayInfo>;
  drugById: Map<string, DrugInfo>;
  pathwaysByTarget: Map<string, PathwayInfo[]>;
  drugsByTarget: Map<string, DrugInfo[]>;
  interactionSymbols: Set<string>;
  nodes: Map<string, DiscoveryNode>;
  edges: Map<string, DiscoveryEdge>;
  pubmedSubqueriesUsed: number;
  pubmedSubqueryHits: Array<{ query: string; articles: PubmedArticle[] }>;
  pubmedByQuery: Map<string, PubmedArticle[]>;
  bioMcpCounts: { articles: number; trials: number };
  bioMcpArticles: Array<{ id: string; title: string; source: string; url: string }>;
  bioMcpTrials: Array<{ id: string; title: string; source: string; url: string; status?: string }>;
};

type CoordinatorTask = {
  subagent: "pathway_mapper" | "translational_scout" | "bridge_hunter" | "literature_scout";
  objective: string;
  seedEntities: string[];
};

type SubagentReport = {
  summary: string;
  findings: string[];
  followups: string[];
  pathState: "active" | "candidate" | "discarded";
};

const diseaseEntityPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;
const AGENT_TIMEOUT_MS = Math.max(
  10 * 60 * 1000,
  appConfig.deepDiscover.agentTimeoutMs,
);
const TOOL_TIMEOUT_MS = Math.max(45_000, appConfig.deepDiscover.toolTimeoutMs);
const MAX_PUBMED_SUBQUERIES = appConfig.deepDiscover.maxPubmedSubqueries;
const DISCOVERER_MAX_RUN_MS = Math.max(90_000, appConfig.deepDiscover.maxRunMs);
const COORDINATOR_TIMEOUT_MS = Math.max(120_000, AGENT_TIMEOUT_MS);
const SUBAGENT_TIMEOUT_MS = Math.max(120_000, AGENT_TIMEOUT_MS);

const coordinatorPlanSchema = z.object({
  strategy: z.string().max(320),
  pubmedSubqueries: z.array(z.string().max(220)).max(MAX_PUBMED_SUBQUERIES),
  tasks: z
    .array(
      z.object({
        subagent: z.enum([
          "pathway_mapper",
          "translational_scout",
          "bridge_hunter",
          "literature_scout",
        ]),
        objective: z.string().max(260),
        seedEntities: z.array(z.string()).max(8),
      }),
    )
    .max(6),
});

const subagentReportSchema = z.object({
  summary: z.string().max(560),
  findings: z.array(z.string().max(260)).max(5),
  followups: z.array(z.string().max(180)).max(2),
  pathState: z.enum(["active", "candidate", "discarded"]),
});

function toGraphNodeType(entityType: DiscoverEntity["type"]): GraphNode["type"] {
  if (entityType === "disease") return "disease";
  if (entityType === "target" || entityType === "protein") return "target";
  if (entityType === "pathway") return "pathway";
  if (entityType === "drug") return "drug";
  return "interaction";
}

function toGraphPrimaryId(entity: DiscoverEntity): string {
  const id = clean(entity.primaryId ?? entity.label);
  if (!id) return "unknown";
  return id.replace(/\s+/g, "_");
}

function toGraphNodeId(entity: DiscoverEntity): string {
  return makeNodeId(toGraphNodeType(entity.type), toGraphPrimaryId(entity));
}

function toGraphEdgeType(
  relation: DiscoveryEdge["relation"],
): { type: GraphEdge["type"]; reverse?: boolean } {
  if (relation === "disease_target") return { type: "disease_target" };
  if (relation === "target_pathway") return { type: "target_pathway" };
  if (relation === "target_drug") return { type: "target_drug" };
  if (relation === "target_target") return { type: "target_target" };
  if (relation === "pathway_target") return { type: "target_pathway", reverse: true };
  if (relation === "pubmed_support") return { type: "target_target" };
  return { type: "disease_disease" };
}

const synthesisSchema = z.object({
  directAnswer: z.string(),
  keyFindings: z.array(z.string()).max(8),
  caveats: z.array(z.string()).max(8),
  nextActions: z.array(z.string()).max(6),
});

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeAnswerMarkdown(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countWords(value: string): number {
  return normalizeAnswerMarkdown(value)
    .split(/\s+/)
    .filter(Boolean).length;
}

function enrichIfTooBrief(answer: string, keyFindings: string[], caveats: string[] = []): string {
  const normalized = normalizeAnswerMarkdown(answer);
  if (!normalized) return normalized;
  if (countWords(normalized) >= 120) return normalized;
  const findings = keyFindings
    .map((item) => clean(item))
    .filter(Boolean)
    .slice(0, 4);
  const uncertainty = caveats
    .map((item) => clean(item))
    .filter(Boolean)
    .slice(0, 4);

  const sections: string[] = [normalized];
  if (findings.length > 0) {
    sections.push("", "### Mechanistic support", ...findings.map((item) => `- ${item}`));
  }
  if (uncertainty.length > 0) {
    sections.push("", "### What remains uncertain", ...uncertainty.map((item) => `- ${item}`));
  }
  return sections.join("\n");
}

function normalizePubmedQuery(value: string): string {
  return clean(value).toLowerCase();
}

function compact(value: string, max = 180): string {
  const normalized = clean(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function slugify(value: string, max = 64): string {
  const slug = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return "unknown";
  return slug.slice(0, max);
}

function toNarrativeDetail(
  kind: DiscoverJourneyEntry["kind"],
  detail: string,
): string {
  const normalized = clean(detail);
  if (!normalized) return detail;
  if (kind === "warning") return `Gap: ${normalized}`;
  if (kind === "followup") return `Next step: ${normalized}`;
  return normalized;
}

function parseSymbolsCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((token) => clean(token))
    .filter(Boolean);
}

function uniqueSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const symbol of symbols) {
    const normalized = clean(symbol);
    if (!normalized) continue;
    const key = normalized.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(normalized);
  }
  return ordered;
}

function toAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const maybeText = (part as { text?: unknown }).text;
        return typeof maybeText === "string" ? maybeText : "";
      }
      return "";
    })
    .join("\n")
    .trim();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function classifyDiscovererError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("429") || message.includes("rate limit") || message.includes("quota")) {
    return "OpenAI rate-limited";
  }
  if (message.includes("timeout")) {
    return "LLM timeout";
  }
  if (message.includes("401") || message.includes("invalid api key")) {
    return "OpenAI authentication error";
  }
  return "LLM unavailable";
}

function inferBiomedicalCase(query: string): {
  title: string;
  whyAgentic: string;
} {
  return {
    title: `${compact(query, 86)}: multihop mechanistic discovery`,
    whyAgentic:
      "Coordinator-guided subagents retrieve evidence across OpenTargets, Reactome, STRING, ChEMBL, BioMCP, and PubMed, then test competing mechanism hypotheses with query-specific follow-ups.",
  };
}

function entityKey(entity: DiscoverEntity): string {
  const id = clean(entity.primaryId ?? entity.label).toUpperCase();
  return `${entity.type}:${id}`;
}

function nodeEntityFromAnchor(anchor: QueryPlanAnchor): DiscoverEntity {
  return {
    type: anchor.entityType,
    label: anchor.name,
    primaryId: anchor.id,
  };
}

function upsertNode(state: DiscoveryState, entity: DiscoverEntity): string {
  const normalized: DiscoverEntity = {
    ...entity,
    label: clean(entity.label),
    primaryId: entity.primaryId ? clean(entity.primaryId) : undefined,
  };
  const key = entityKey(normalized);
  const existing = state.nodes.get(key);
  if (existing) {
    state.nodes.set(key, {
      key,
      entity: {
        ...existing.entity,
        ...normalized,
      },
    });
    return key;
  }
  state.nodes.set(key, {
    key,
    entity: normalized,
  });
  return key;
}

function edgeId(sourceKey: string, targetKey: string, relation: DiscoveryEdge["relation"]): string {
  return `${relation}:${sourceKey}->${targetKey}`;
}

function upsertEdge(
  state: DiscoveryState,
  input: Omit<DiscoveryEdge, "id" | "score"> & { score?: number },
): string {
  const id = edgeId(input.sourceKey, input.targetKey, input.relation);
  const current = state.edges.get(id);
  const next: DiscoveryEdge = {
    id,
    score: input.score ?? 0.5,
    ...input,
  };
  if (!current) {
    state.edges.set(id, next);
    return id;
  }
  state.edges.set(id, {
    ...current,
    ...next,
    score: Math.max(current.score, next.score),
    note: next.note || current.note,
  });
  return id;
}

function buildGraphPatch(state: DiscoveryState): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodeMap = new Map<string, GraphNode>();
  for (const node of state.nodes.values()) {
    const graphType = toGraphNodeType(node.entity.type);
    const primaryId = toGraphPrimaryId(node.entity);
    const graphId = makeNodeId(graphType, primaryId);
    const baseScore =
      graphType === "target"
        ? (() => {
            const known = [...state.targetById.values()].find(
              (item) =>
                item.id.toUpperCase() === primaryId.toUpperCase() ||
                item.symbol.toUpperCase() === node.entity.label.toUpperCase(),
            );
            return known?.score ?? 0.36;
          })()
        : graphType === "disease"
          ? 0.84
          : graphType === "pathway"
            ? 0.52
            : graphType === "drug"
              ? 0.46
              : 0.3;
    nodeMap.set(graphId, {
      id: graphId,
      type: graphType,
      primaryId,
      label: compact(node.entity.label, 64),
      score: clamp(baseScore, 0.06, 1),
      size: graphType === "disease" ? 62 : graphType === "target" ? 36 : 24,
      meta: {
        displayName: node.entity.label,
        source: "agent_discovery",
        evidenceCategory: node.entity.evidenceCategory,
        virtual: false,
      },
    });
  }

  const edgeMap = new Map<string, GraphEdge>();
  for (const edge of state.edges.values()) {
    const leftEntity = state.nodes.get(edge.sourceKey)?.entity;
    const rightEntity = state.nodes.get(edge.targetKey)?.entity;
    if (!leftEntity || !rightEntity) continue;

    const mapping = toGraphEdgeType(edge.relation);
    const sourceEntity = mapping.reverse ? rightEntity : leftEntity;
    const targetEntity = mapping.reverse ? leftEntity : rightEntity;
    const sourceId = toGraphNodeId(sourceEntity);
    const targetId = toGraphNodeId(targetEntity);
    const id = makeEdgeId(sourceId, targetId, mapping.type);
    const plannerAnchorEdge =
      edge.relation === "query_anchor" && edge.source === "planner";
    const status = plannerAnchorEdge
      ? "candidate"
      : edge.score >= 0.6
        ? "connected"
        : "candidate";
    edgeMap.set(id, {
      id,
      source: sourceId,
      target: targetId,
      type: mapping.type,
      weight: clamp(edge.score, 0.05, 1),
      meta: {
        source: plannerAnchorEdge ? "query_anchor" : edge.source,
        status,
        note: edge.note,
        bridgeType:
          edge.relation === "query_anchor"
            ? plannerAnchorEdge
              ? "query_anchor"
              : "cross_anchor_evidence"
            : edge.relation,
        agentic: true,
      },
    });
  }

  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };
}

function resolveDiseaseCandidatesFromPlan(
  queryPlan: ResolvedQueryPlan | null,
  fallbackQuery: string,
): string[] {
  const fromPlan = (queryPlan?.anchors ?? [])
    .filter((anchor) => anchor.entityType === "disease")
    .map((anchor) => anchor.name);
  if (fromPlan.length > 0) return uniqueSymbols(fromPlan).slice(0, 4);
  return [fallbackQuery];
}

function summarizeThread(state: DiscoveryState): {
  target: string;
  pathway: string;
  drug: string;
} {
  const topTarget = [...state.targetById.values()].sort((a, b) => b.score - a.score)[0];
  if (!topTarget) {
    return { target: "not provided", pathway: "not provided", drug: "not provided" };
  }
  const topPathway = (state.pathwaysByTarget.get(topTarget.symbol) ?? [])[0];
  const topDrug = (state.drugsByTarget.get(topTarget.symbol) ?? [])[0];
  return {
    target: topTarget.symbol,
    pathway: topPathway?.name ?? "not provided",
    drug: topDrug?.name ?? "not provided",
  };
}

function buildAdjacency(state: DiscoveryState): Map<string, Array<{ to: string; edgeId: string }>> {
  const adjacency = new Map<string, Array<{ to: string; edgeId: string }>>();
  for (const edge of state.edges.values()) {
    if (edge.relation === "query_anchor" && edge.source === "planner") {
      // Query anchor links keep the run interpretable but should not be treated
      // as mechanistic bridge evidence.
      continue;
    }
    const left = adjacency.get(edge.sourceKey) ?? [];
    left.push({ to: edge.targetKey, edgeId: edge.id });
    adjacency.set(edge.sourceKey, left);

    const right = adjacency.get(edge.targetKey) ?? [];
    right.push({ to: edge.sourceKey, edgeId: edge.id });
    adjacency.set(edge.targetKey, right);
  }
  return adjacency;
}

function findShortestPath(state: DiscoveryState, start: string, goal: string): BridgePath | null {
  if (start === goal) {
    return { nodeKeys: [start], edgeIds: [] };
  }
  const adjacency = buildAdjacency(state);
  const queue: string[] = [start];
  const visited = new Set<string>([start]);
  const parent = new Map<string, { node: string; edgeId: string }>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const neighbors = adjacency.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor.to)) continue;
      visited.add(neighbor.to);
      parent.set(neighbor.to, { node: current, edgeId: neighbor.edgeId });
      if (neighbor.to === goal) {
        const nodeKeys: string[] = [goal];
        const edgeIds: string[] = [];
        let cursor = goal;
        while (cursor !== start) {
          const step = parent.get(cursor);
          if (!step) break;
          edgeIds.push(step.edgeId);
          nodeKeys.push(step.node);
          cursor = step.node;
        }
        return {
          nodeKeys: nodeKeys.reverse(),
          edgeIds: edgeIds.reverse(),
        };
      }
      queue.push(neighbor.to);
    }
  }

  return null;
}

function chooseBridgePath(state: DiscoveryState): {
  connectedPath: BridgePath | null;
  unresolvedPairs: string[];
  anchorLabels: string[];
} {
  const anchors = (state.queryPlan?.anchors ?? []).slice(0, 4);
  const anchorNodeKeys = anchors
    .map((anchor) => entityKey(nodeEntityFromAnchor(anchor)))
    .filter((key) => state.nodes.has(key));
  const anchorLabels = anchors.map((anchor) => anchor.name);

  if (anchorNodeKeys.length < 2) {
    return {
      connectedPath: null,
      unresolvedPairs: [],
      anchorLabels,
    };
  }

  const sequentialNodeTrail: string[] = [];
  const sequentialEdgeTrail: string[] = [];
  const unresolvedSequentialPairs: string[] = [];
  for (let idx = 0; idx < anchorNodeKeys.length - 1; idx += 1) {
    const left = anchorNodeKeys[idx]!;
    const right = anchorNodeKeys[idx + 1]!;
    const path = findShortestPath(state, left, right);
    const leftLabel = state.nodes.get(left)?.entity.label ?? left;
    const rightLabel = state.nodes.get(right)?.entity.label ?? right;
    if (!path) {
      unresolvedSequentialPairs.push(`${leftLabel} -> ${rightLabel}`);
      continue;
    }
    if (sequentialNodeTrail.length === 0) {
      sequentialNodeTrail.push(...path.nodeKeys);
    } else {
      const last = sequentialNodeTrail[sequentialNodeTrail.length - 1];
      if (last === path.nodeKeys[0]) {
        sequentialNodeTrail.push(...path.nodeKeys.slice(1));
      } else {
        sequentialNodeTrail.push(...path.nodeKeys);
      }
    }
    sequentialEdgeTrail.push(...path.edgeIds);
  }

  if (unresolvedSequentialPairs.length === 0 && sequentialNodeTrail.length >= 2) {
    return {
      connectedPath: {
        nodeKeys: [...new Set(sequentialNodeTrail)],
        edgeIds: [...new Set(sequentialEdgeTrail)],
      },
      unresolvedPairs: [],
      anchorLabels,
    };
  }

  let best: BridgePath | null = null;
  const unresolvedPairs: string[] = [];

  for (let i = 0; i < anchorNodeKeys.length; i += 1) {
    for (let j = i + 1; j < anchorNodeKeys.length; j += 1) {
      const left = anchorNodeKeys[i]!;
      const right = anchorNodeKeys[j]!;
      const path = findShortestPath(state, left, right);
      const leftLabel = state.nodes.get(left)?.entity.label ?? left;
      const rightLabel = state.nodes.get(right)?.entity.label ?? right;
      if (!path) {
        unresolvedPairs.push(`${leftLabel} -> ${rightLabel}`);
        continue;
      }
      if (!best || path.edgeIds.length < best.edgeIds.length) {
        best = path;
      }
    }
  }

  return {
    connectedPath: best,
    unresolvedPairs: [...new Set([...unresolvedPairs, ...unresolvedSequentialPairs])],
    anchorLabels,
  };
}

function bridgePathToSummary(state: DiscoveryState, path: BridgePath | null): string {
  if (!path || path.nodeKeys.length === 0) return "not provided";
  return path.nodeKeys
    .map((key) => state.nodes.get(key)?.entity.label ?? key)
    .join(" -> ");
}

function buildFallbackSummary(state: DiscoveryState, query: string): DiscovererFinal {
  const thread = summarizeThread(state);
  const bridge = chooseBridgePath(state);
  const bridgeSummary = bridgePathToSummary(state, bridge.connectedPath);
  const pubmedCount = state.pubmedSubqueryHits.reduce((acc, row) => acc + row.articles.length, 0);
  const anchorScope =
    bridge.anchorLabels.length >= 2
      ? bridge.anchorLabels.join(" and ")
      : bridge.anchorLabels[0] ?? query;

  const answer = bridge.connectedPath
    ? `For ${anchorScope}, current evidence supports the multihop mechanism path ${bridgeSummary}.`
    : `For ${anchorScope}, a complete multihop mechanism path is not yet resolved; the strongest partial thread is ${thread.pathway} -> ${thread.target} -> ${thread.drug}.`;

  const caveats: string[] = [];
  if (!bridge.connectedPath) {
    caveats.push("No complete path across all query entities in this run.");
  }
  if (thread.target === "not provided") caveats.push("Target evidence not provided.");
  if (thread.pathway === "not provided") caveats.push("Pathway evidence not provided.");
  if (thread.drug === "not provided") caveats.push("Drug evidence not provided.");
  if (pubmedCount === 0) caveats.push("PubMed subqueries returned no articles.");
  const hasConcreteThread =
    thread.pathway !== "not provided" || thread.target !== "not provided" || thread.drug !== "not provided";
  const mappedAnchorsLine =
    bridge.anchorLabels.length <= 1
      ? `Primary query entity mapped: ${bridge.anchorLabels[0] ?? "not provided"}`
      : `Query entities mapped: ${bridge.anchorLabels.join(" | ")}`;
  const keyFindings = [
    mappedAnchorsLine,
    ...(hasConcreteThread
      ? [`Strongest thread: ${thread.pathway} -> ${thread.target} -> ${thread.drug}`]
      : []),
    `Nodes discovered: ${state.nodes.size}`,
    `Edges discovered: ${state.edges.size}`,
    `PubMed subqueries executed: ${state.pubmedSubqueriesUsed}/${MAX_PUBMED_SUBQUERIES}`,
    `BioMCP snippets: ${state.bioMcpCounts.articles} articles / ${state.bioMcpCounts.trials} trials`,
  ];

  return {
    answer,
    biomedicalCase: inferBiomedicalCase(query),
    focusThread: thread,
    keyFindings,
    caveats: caveats.length > 0 ? caveats : ["No major gaps were flagged."],
    nextActions: [
      "Run follow-up assay design on the strongest target-pathway segment.",
      "Expand interaction neighborhood around the top mechanistic targets.",
      "Increase PubMed depth on unresolved anchor pairs with narrower subqueries.",
    ],
    evidenceBundle: buildEvidenceBundle(state),
  };
}

function buildEvidenceBundle(state: DiscoveryState): NonNullable<DiscovererFinal["evidenceBundle"]> {
  const citations: NonNullable<DiscovererFinal["evidenceBundle"]>["citations"] = [];
  const seen = new Set<string>();
  const pushCitation = (entry: {
    kind: "article" | "trial";
    label: string;
    source: string;
    url?: string;
  }) => {
    const label = compact(clean(entry.label), 180);
    if (!label) return;
    const key = `${entry.kind}::${entry.url ?? ""}::${label.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    citations.push({
      kind: entry.kind,
      label,
      source: clean(entry.source) || (entry.kind === "trial" ? "ClinicalTrials.gov" : "PubMed"),
      url: entry.url,
    });
  };

  for (const row of state.pubmedSubqueryHits) {
    for (const article of row.articles.slice(0, 4)) {
      const pmid = clean(article.id);
      pushCitation({
        kind: "article",
        label: article.title,
        source: article.journal || "PubMed",
        url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : undefined,
      });
      if (citations.length >= 28) break;
    }
    if (citations.length >= 28) break;
  }

  for (const article of state.bioMcpArticles.slice(0, 10)) {
    pushCitation({
      kind: "article",
      label: article.title,
      source: article.source || "BioMCP",
      url: article.url,
    });
    if (citations.length >= 36) break;
  }

  for (const trial of state.bioMcpTrials.slice(0, 8)) {
    pushCitation({
      kind: "trial",
      label: trial.status ? `${trial.title} (${trial.status})` : trial.title,
      source: trial.source || "BioMCP",
      url: trial.url,
    });
    if (citations.length >= 40) break;
  }

  return {
    articleSnippets: Math.max(
      state.bioMcpCounts.articles,
      state.pubmedSubqueryHits.reduce((acc, row) => acc + row.articles.length, 0),
    ),
    trialSnippets: state.bioMcpCounts.trials,
    citations,
  };
}

type FreeformSynthesisInput = {
  query: string;
  bridge: {
    connected: boolean;
    summary: string;
    unresolvedPairs: string[];
  };
  thread: {
    pathway: string;
    target: string;
    drug: string;
  };
  state: DiscoveryState;
  citationPreview: string[];
  subagentSummaries: string[];
};

type SubagentSummaryCompressionInput = {
  objective: string;
  summary: string;
  findings: string[];
};

async function compressSubagentSummary(
  model: ChatOpenAI,
  payload: SubagentSummaryCompressionInput,
): Promise<string | null> {
  const response = await withOpenAiOperationContext(
    "deep_discover.utility_compress_summary",
    () =>
      withTimeout(
        model.invoke([
          {
            role: "system",
            content: [
              "You compress biomedical subagent output into one evidence-grounded sentence.",
              "Keep entities and mechanism nouns intact.",
              "Do not invent evidence, certainty, or citations.",
              "Max length: 180 characters.",
              "Return plain text only.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ]),
        Math.min(TOOL_TIMEOUT_MS, 6_000),
        "subagent summary compression",
      ),
  );
  const text = clean(toAssistantText(response.content));
  return text.length > 0 ? compact(text, 180) : null;
}

async function synthesizeFreeformNarrative(
  model: ChatOpenAI,
  payload: FreeformSynthesisInput,
): Promise<string | null> {
  const response = await withOpenAiOperationContext(
    "deep_discover.final_freeform_synthesis",
    () =>
      withTimeout(
        model.invoke([
          {
            role: "system",
            content: [
              "You are a biomedical scientist writing the final run answer.",
              "Write a rigorous free-form scientific summary tailored to the exact query.",
              "Use markdown headings in this order: '### Direct answer', '### Mechanistic support', '### What remains uncertain'.",
              "Open with a direct answer sentence that names the main mechanism relation.",
              "Write a substantive answer (roughly 180-280 words), not a one-liner.",
              "Mention the key entities from the query and at least one intermediate mechanistic hop if available.",
              "Never use generic templates or boilerplate prefixes.",
              "If no complete cross-anchor mechanism path is found, explain what was tested and where the gap remains.",
              "When evidence is available, mention the main intermediate hops explicitly.",
              "Cover limitations/uncertainty clearly but concisely (at most 10% of total answer length).",
              "Do not use citation ranges like [6-10] or [6–10]; cite each number explicitly as [6][7][8][9][10].",
              "End with a complete sentence; do not stop mid-sentence.",
              "Do not use internal workflow words such as bridge, branch, planner, or pipeline in the answer text.",
              "Do not discuss UI state, run progress, or internal orchestration.",
              "Do not write meta phrases like 'the provided evidence summary' or 'this dataset'.",
              "Write the biomedical conclusion directly.",
              "Ignore placeholder values like 'not provided'; never surface them in findings or caveats.",
              "Do not add caveats about unrelated focus targets unless directly supported by mechanism evidence.",
              "If citation markers are provided, cite only using [1], [2], etc.",
              "Return plain text only.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                query: payload.query,
                mechanismPath: payload.bridge,
                focusThread: payload.thread,
                evidenceStats: {
                  nodes: payload.state.nodes.size,
                  edges: payload.state.edges.size,
                  targets: payload.state.targetById.size,
                  pathways: payload.state.pathwayById.size,
                  drugs: payload.state.drugById.size,
                  pubmedQueriesUsed: payload.state.pubmedSubqueriesUsed,
                  pubmedArticles: payload.state.pubmedSubqueryHits.reduce(
                    (acc, row) => acc + row.articles.length,
                    0,
                  ),
                  biomcpArticles: payload.state.bioMcpCounts.articles,
                  biomcpTrials: payload.state.bioMcpCounts.trials,
                },
                subagentSummaries: payload.subagentSummaries.slice(0, 8),
                citationPreview: payload.citationPreview,
              },
              null,
              2,
            ),
          },
        ]),
        AGENT_TIMEOUT_MS,
        "freeform synthesis",
      ),
  );
  const text = normalizeAnswerMarkdown(toAssistantText(response.content));
  return text.length > 0 ? text : null;
}

function routeFollowupToSubagent(
  followup: string,
): CoordinatorTask["subagent"] {
  const text = followup.toLowerCase();
  if (/pubmed|paper|literature|trial|bibliography/.test(text)) return "literature_scout";
  if (/connect|bridge|between|overlap|relationship|common|shared/.test(text)) return "bridge_hunter";
  if (/drug|compound|tractability|moa|mechanism/.test(text)) return "translational_scout";
  return "pathway_mapper";
}

async function resolveDisease(
  state: DiscoveryState,
  mention: string,
  preferredDiseaseId?: string,
): Promise<DiseaseInfo> {
  const query = clean(mention);
  const matches = await withTimeout(searchDiseases(query, 12).catch(() => []), TOOL_TIMEOUT_MS, "resolve disease");
  const diseaseHits = matches.filter((row) => diseaseEntityPattern.test(row.id));
  const selected =
    diseaseHits.find((row) => row.id === preferredDiseaseId) ??
    diseaseHits.find((row) => row.name.toLowerCase() === query.toLowerCase()) ??
    diseaseHits[0] ??
    matches[0];

  const disease: DiseaseInfo = {
    id: selected?.id ?? `QUERY_${query.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    name: selected?.name ?? query,
    description: selected?.description,
  };

  state.diseaseById.set(disease.id, disease);
  upsertNode(state, {
    type: "disease",
    label: disease.name,
    primaryId: disease.id,
  });
  return disease;
}

export async function runDeepDiscoverer({
  diseaseQuery,
  diseaseIdHint,
  question,
  emitJourney,
}: RunParams): Promise<DiscovererFinal> {
  const normalizedQuestion = clean(question || diseaseQuery);
  const state: DiscoveryState = {
    queryPlan: null,
    diseaseById: new Map(),
    targetById: new Map(),
    pathwayById: new Map(),
    drugById: new Map(),
    pathwaysByTarget: new Map(),
    drugsByTarget: new Map(),
    interactionSymbols: new Set(),
    nodes: new Map(),
    edges: new Map(),
    pubmedSubqueriesUsed: 0,
    pubmedSubqueryHits: [],
    pubmedByQuery: new Map(),
    bioMcpCounts: { articles: 0, trials: 0 },
    bioMcpArticles: [],
    bioMcpTrials: [],
  };

  let entryCounter = 0;
  const push = (
    kind: DiscoverJourneyEntry["kind"],
    title: string,
    detail: string,
    source: DiscoverJourneyEntry["source"],
    entities: DiscoverEntity[] = [],
    pathState?: DiscoverJourneyEntry["pathState"],
    includeGraphPatch = kind === "tool_result" || kind === "followup" || kind === "branch" || kind === "insight",
  ) => {
    entryCounter += 1;
    emitJourney({
      id: `discover-${entryCounter}`,
      ts: new Date().toISOString(),
      kind,
      title,
      detail: toNarrativeDetail(kind, detail),
      source,
      pathState,
      entities,
      graphPatch: includeGraphPatch ? buildGraphPatch(state) : undefined,
    });
  };

  const runStartedAtMs = Date.now();
  const runDeadlineMs = runStartedAtMs + DISCOVERER_MAX_RUN_MS;
  let runBudgetWarningEmitted = false;
  const msRemaining = () => runDeadlineMs - Date.now();
  const hasTimeBudget = (reserveMs = 0) => msRemaining() > reserveMs;
  const boundedTimeout = (maxMs: number, minMs = 8_000): number => {
    const remaining = msRemaining() - 2_000;
    if (!Number.isFinite(remaining) || remaining <= minMs) return minMs;
    return Math.max(minMs, Math.min(maxMs, remaining));
  };
  const emitRunBudgetWarning = (detail: string) => {
    if (runBudgetWarningEmitted) return;
    runBudgetWarningEmitted = true;
    push(
      "warning",
      "Run budget reached",
      detail,
      "agent",
      [],
      "candidate",
    );
  };

  const upsertTargetNode = (target: TargetInfo) => {
    state.targetById.set(target.id, target);
    const key = upsertNode(state, {
      type: "target",
      label: target.symbol,
      primaryId: target.id,
    });
    return key;
  };

  const upsertPathwayNode = (pathway: PathwayInfo) => {
    state.pathwayById.set(pathway.id, pathway);
    const key = upsertNode(state, {
      type: "pathway",
      label: pathway.name,
      primaryId: pathway.id,
    });
    return key;
  };

  const upsertDrugNode = (drug: DrugInfo) => {
    state.drugById.set(drug.id, drug);
    const key = upsertNode(state, {
      type: "drug",
      label: drug.name,
      primaryId: drug.id,
    });
    return key;
  };

  const linkDiseaseTarget = (disease: DiseaseInfo, target: TargetInfo, score: number) => {
    const diseaseKey = upsertNode(state, {
      type: "disease",
      label: disease.name,
      primaryId: disease.id,
    });
    const targetKey = upsertTargetNode(target);
    upsertEdge(state, {
      sourceKey: diseaseKey,
      targetKey,
      relation: "disease_target",
      source: "opentargets",
      score,
      note: `${disease.name} -> ${target.symbol}`,
    });
  };

  const linkTargetPathway = (targetSymbol: string, pathway: PathwayInfo) => {
    const target = [...state.targetById.values()].find(
      (row) => row.symbol.toUpperCase() === targetSymbol.toUpperCase(),
    );
    if (!target) return;
    const targetKey = upsertTargetNode(target);
    const pathwayKey = upsertPathwayNode(pathway);
    upsertEdge(state, {
      sourceKey: targetKey,
      targetKey: pathwayKey,
      relation: "target_pathway",
      source: "reactome",
      score: 0.52,
      note: `${target.symbol} -> ${pathway.name}`,
    });
  };

  const linkTargetDrug = (targetSymbol: string, drug: DrugInfo) => {
    const target = [...state.targetById.values()].find(
      (row) => row.symbol.toUpperCase() === targetSymbol.toUpperCase(),
    );
    if (!target) return;
    const targetKey = upsertTargetNode(target);
    const drugKey = upsertDrugNode(drug);
    upsertEdge(state, {
      sourceKey: targetKey,
      targetKey: drugKey,
      relation: "target_drug",
      source: drug.source,
      score: drug.source === "chembl" ? 0.58 : 0.5,
      note: `${target.symbol} -> ${drug.name}`,
    });
  };

  const linkTargetInteraction = (leftSymbol: string, rightSymbol: string, score: number) => {
    const left = [...state.targetById.values()].find(
      (row) => row.symbol.toUpperCase() === leftSymbol.toUpperCase(),
    );
    const right = [...state.targetById.values()].find(
      (row) => row.symbol.toUpperCase() === rightSymbol.toUpperCase(),
    );
    if (!left || !right) return;
    const leftKey = upsertTargetNode(left);
    const rightKey = upsertTargetNode(right);
    upsertEdge(state, {
      sourceKey: leftKey,
      targetKey: rightKey,
      relation: "target_target",
      source: "string",
      score: clamp(score || 0.4, 0.2, 1),
      note: `${left.symbol} -> ${right.symbol}`,
    });
  };

  const extractAndLinkEvidenceEntities = async (input: {
    source: "pubmed" | "biomcp";
    snippets: string[];
    diseaseName?: string;
    targetSymbol?: string;
  }): Promise<Array<{ label: string; category: "exposure" | "mechanism" | "outcome" }>> => {
    const snippets = input.snippets
      .map((value) => clean(value))
      .filter((value) => value.length >= 8)
      .slice(0, 18);
    if (snippets.length === 0) return [];
    if (!hasTimeBudget(8_000)) return [];

    const extracted = await extractEvidenceEntitiesFast({
      query: normalizedQuestion,
      snippets,
      maxEntities: 10,
      timeoutMs: boundedTimeout(9_000, 2_000),
    }).catch(() => []);
    if (extracted.length === 0) return [];

    const diseaseContext =
      (input.diseaseName
        ? [...state.diseaseById.values()].find(
            (row) => row.name.toLowerCase() === input.diseaseName?.toLowerCase(),
          )
        : null) ??
      [...state.diseaseById.values()][0] ??
      null;
    const targetContext =
      (input.targetSymbol
        ? [...state.targetById.values()].find(
            (row) => row.symbol.toUpperCase() === input.targetSymbol?.toUpperCase(),
          )
        : null) ?? null;

    const contextKeys = new Set<string>();
    if (diseaseContext) {
      contextKeys.add(
        upsertNode(state, {
          type: "disease",
          label: diseaseContext.name,
          primaryId: diseaseContext.id,
        }),
      );
    }
    if (targetContext) {
      contextKeys.add(upsertTargetNode(targetContext));
    }

    const categoryNodeKeys = new Map<
      "exposure" | "mechanism" | "outcome",
      string[]
    >([
      ["exposure", []],
      ["mechanism", []],
      ["outcome", []],
    ]);

    for (const mention of extracted) {
      const nodeKey = upsertNode(state, {
        type: "effect",
        label: mention.label,
        primaryId: `EVID_${mention.category}_${slugify(mention.label, 48)}`,
        evidenceCategory: mention.category,
      });
      categoryNodeKeys.get(mention.category)?.push(nodeKey);

      const baseScore = clamp(0.35 + mention.confidence * 0.5, 0.26, 0.9);
      for (const contextKey of contextKeys) {
        if (contextKey === nodeKey) continue;
        upsertEdge(state, {
          sourceKey: contextKey,
          targetKey: nodeKey,
          relation: "pubmed_support",
          source: "evidence",
          score: baseScore,
          note: `${input.source} evidence entity (${mention.category}): ${mention.label}`,
        });
      }
    }

    const exposures = categoryNodeKeys.get("exposure") ?? [];
    const mechanisms = categoryNodeKeys.get("mechanism") ?? [];
    const outcomes = categoryNodeKeys.get("outcome") ?? [];

    for (const exposureKey of exposures.slice(0, 3)) {
      for (const mechanismKey of mechanisms.slice(0, 4)) {
        if (exposureKey === mechanismKey) continue;
        upsertEdge(state, {
          sourceKey: exposureKey,
          targetKey: mechanismKey,
          relation: "pubmed_support",
          source: "evidence",
          score: 0.5,
          note: "Exposure-to-mechanism relation from literature entity extraction.",
        });
      }
    }
    for (const mechanismKey of mechanisms.slice(0, 4)) {
      for (const outcomeKey of outcomes.slice(0, 3)) {
        if (mechanismKey === outcomeKey) continue;
        upsertEdge(state, {
          sourceKey: mechanismKey,
          targetKey: outcomeKey,
          relation: "pubmed_support",
          source: "evidence",
          score: 0.48,
          note: "Mechanism-to-outcome relation from literature entity extraction.",
        });
      }
    }

    return extracted.map((row) => ({
      label: row.label,
      category: row.category,
    }));
  };

  const resolveAnchorNodes = () => {
    const anchors = state.queryPlan?.anchors ?? [];
    const entities = anchors.slice(0, 8).map(nodeEntityFromAnchor);
    for (const entity of entities) {
      upsertNode(state, entity);
    }

    for (let index = 0; index < entities.length - 1; index += 1) {
      const left = entities[index]!;
      const right = entities[index + 1]!;
      const leftKey = upsertNode(state, left);
      const rightKey = upsertNode(state, right);
      upsertEdge(state, {
        sourceKey: leftKey,
        targetKey: rightKey,
        relation: "query_anchor",
        source: "planner",
        score: 0.3,
        note: `${left.label} -> ${right.label} query anchor` ,
      });
    }

    if (entities.length > 0) {
      push(
        "handoff",
        "Planner handoff",
        `${entities.length} anchors selected: ${entities.map((entity) => entity.label).join(", ")}`,
        "planner",
        entities,
        "active",
      );
    }
  };

  const probeAnchorPairLiterature = async () => {
    const anchors = (state.queryPlan?.anchors ?? [])
      .filter((anchor) => clean(anchor.name).length >= 2)
      .slice(0, 5);
    if (anchors.length < 2) return;

    const pairKeys = new Set<string>();
    const pairs: Array<[QueryPlanAnchor, QueryPlanAnchor]> = [];
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const left = anchors[index]!;
      const right = anchors[index + 1]!;
      const key = [left.id, right.id].sort().join("::");
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      pairs.push([left, right]);
      if (pairs.length >= 2) break;
    }

    for (const [leftAnchor, rightAnchor] of pairs) {
      if (!hasTimeBudget(22_000)) {
        emitRunBudgetWarning(
          "Anchor-pair literature probing trimmed to preserve synthesis budget.",
        );
        break;
      }

      const leftEntity = nodeEntityFromAnchor(leftAnchor);
      const rightEntity = nodeEntityFromAnchor(rightAnchor);
      const leftKey = upsertNode(state, leftEntity);
      const rightKey = upsertNode(state, rightEntity);
      const subquery = `${leftAnchor.name} ${rightAnchor.name} mechanism`;
      const subqueryKey = normalizePubmedQuery(subquery);
      const cached = state.pubmedByQuery.get(subqueryKey);
      const canRun = state.pubmedSubqueriesUsed < MAX_PUBMED_SUBQUERIES;

      let articles: PubmedArticle[] = [];
      if (cached) {
        articles = cached;
      } else if (canRun) {
        state.pubmedSubqueriesUsed += 1;
        push(
          "tool_start",
          "Probe anchor-pair literature",
          `Subquery ${state.pubmedSubqueriesUsed}/${MAX_PUBMED_SUBQUERIES}: ${subquery}`,
          "pubmed",
          [leftEntity, rightEntity],
          "active",
        );
        articles = await searchPubmedByQuery(subquery, 4).catch(() => []);
        state.pubmedSubqueryHits.push({ query: subquery, articles });
        state.pubmedByQuery.set(subqueryKey, articles);
      }

      if (articles.length > 0) {
        upsertEdge(state, {
          sourceKey: leftKey,
          targetKey: rightKey,
          relation: "query_anchor",
          source: "pubmed",
          score: 0.72,
          note: `${articles.length} PubMed articles support ${leftAnchor.name} <-> ${rightAnchor.name}`,
        });
      }

      const extractedEntities =
        articles.length > 0
          ? await extractAndLinkEvidenceEntities({
              source: "pubmed",
              snippets: articles.map((article) => article.title),
            })
          : [];
      if (extractedEntities.length > 0) {
        push(
          "insight",
          "Exposure-aware evidence lane updated",
          `${extractedEntities.length} exposure/mechanism/outcome entities extracted from anchor-pair literature.`,
          "evidence",
          extractedEntities.slice(0, 6).map((entity) => ({
            type: "effect",
            label: entity.label,
            evidenceCategory: entity.category,
          })),
          "active",
        );
      }

      push(
        "tool_result",
        cached ? "Anchor-pair literature cached" : "Anchor-pair literature probe",
        `${articles.length} PubMed articles ${
          articles.length > 0 ? "support" : "did not support"
        } ${leftAnchor.name} and ${rightAnchor.name}.${
          extractedEntities.length > 0 ? ` ${extractedEntities.length} evidence entities mapped.` : ""
        }`,
        "pubmed",
        articles.slice(0, 3).map((article) => ({
          type: "effect",
          label: article.title,
          primaryId: article.id,
        })),
        articles.length > 0 ? "active" : "candidate",
      );
    }
  };

  const resolveEntityCandidatesTool = tool(
    async ({ mention, expectedType }) => {
      const query = clean(mention);
      const expected = expectedType.toLowerCase();
      push(
        "tool_start",
        "Resolve entity",
        `Resolving ${expected} candidates for \"${query}\".`,
        "opentargets",
        [],
        "active",
      );

      const candidates: Array<{ id: string; name: string; type: string; source: string }> = [];
      if (expected === "disease" || expected === "unknown") {
        const diseases = await searchDiseases(query, 8).catch(() => []);
        for (const disease of diseases) {
          if (!diseaseEntityPattern.test(disease.id)) continue;
          candidates.push({ id: disease.id, name: disease.name, type: "disease", source: "opentargets" });
        }
      }

      if (expected === "target" || expected === "unknown" || expected === "protein") {
        const targets = await searchTargets(query, 8).catch(() => []);
        for (const target of targets) {
          candidates.push({ id: target.id, name: target.name, type: "target", source: "opentargets" });
        }
      }

      if (expected === "drug" || expected === "unknown" || expected === "intervention") {
        const [drugs, chemblDrugs] = await Promise.all([
          searchDrugs(query, 6).catch(() => []),
          getTargetActivityDrugs(query, 4).catch(() => []),
        ]);
        for (const drug of drugs) {
          candidates.push({ id: drug.id, name: drug.name, type: "drug", source: "opentargets" });
        }
        for (const drug of chemblDrugs) {
          candidates.push({ id: drug.moleculeId, name: drug.name, type: "drug", source: "chembl" });
        }
      }

      const deduped = new Map<string, { id: string; name: string; type: string; source: string }>();
      for (const candidate of candidates) {
        const key = `${candidate.type}:${candidate.id}`;
        if (!deduped.has(key)) deduped.set(key, candidate);
      }
      const out = [...deduped.values()].slice(0, 10);

      for (const candidate of out) {
        upsertNode(state, {
          type: candidate.type as DiscoverEntity["type"],
          label: candidate.name,
          primaryId: candidate.id,
        });
      }

      push(
        "tool_result",
        "Entity candidates resolved",
        `${out.length} candidates found for \"${query}\".`,
        "opentargets",
        out.slice(0, 6).map((candidate) => ({
          type: candidate.type as DiscoverEntity["type"],
          label: candidate.name,
          primaryId: candidate.id,
        })),
        out.length > 0 ? "active" : "candidate",
      );

      return JSON.stringify({ mention: query, candidates: out });
    },
    {
      name: "resolve_entity_candidates",
      description:
        "Resolve disease/target/drug candidates for a free-text mention using MCP resolvers. Use this before retrieval when anchors are ambiguous.",
      schema: z.object({
        mention: z.string(),
        expectedType: z.enum(["disease", "target", "drug", "intervention", "protein", "unknown"]),
      }),
    },
  );

  const fetchDiseaseTargetsTool = tool(
    async ({ diseaseIdOrName, limit }) => {
      const query = clean(diseaseIdOrName);
      const capped = clamp(limit, 3, 20);
      push(
        "tool_start",
        "Fetch top targets",
        `Fetching ${capped} disease-associated targets for ${query}.`,
        "opentargets",
        [{ type: "disease", label: query }],
        "active",
      );

      let disease = state.diseaseById.get(query) ?? null;
      if (!disease) {
        if (diseaseEntityPattern.test(query)) {
          const matches = await searchDiseases(query, 4).catch(() => []);
          const exact = matches.find((row) => row.id === query);
          disease = {
            id: query,
            name: exact?.name ?? query,
            description: exact?.description,
          };
          state.diseaseById.set(disease.id, disease);
        } else {
          disease = await resolveDisease(state, query, diseaseIdHint);
        }
      }

      const rows = await getDiseaseTargetsSummary(disease.id, capped).catch(() => []);
      const targets = rows.slice(0, capped).map((row) => ({
        id: row.targetId,
        symbol: row.targetSymbol,
        name: row.targetName,
        score: row.associationScore,
      }));

      for (const target of targets) {
        linkDiseaseTarget(disease, target, target.score);
      }

      push(
        "tool_result",
        "Targets mapped",
        `${targets.length} targets linked for ${disease.name}.`,
        "opentargets",
        targets.slice(0, 8).map((target) => ({
          type: "target",
          label: target.symbol,
          primaryId: target.id,
        })),
        targets.length > 0 ? "active" : "candidate",
      );

      return JSON.stringify({
        disease,
        targets,
      });
    },
    {
      name: "fetch_disease_targets",
      description:
        "Fetch top OpenTargets disease-associated targets by disease ID or disease name. This is the main disease->target evidence retrieval tool.",
      schema: z.object({
        diseaseIdOrName: z.string(),
        limit: z.number().int().min(3).max(20),
      }),
    },
  );

  const fetchPathwaysTool = tool(
    async ({ targetSymbolsCsv, perTarget }) => {
      const symbols = uniqueSymbols(parseSymbolsCsv(targetSymbolsCsv));
      const cappedPerTarget = clamp(perTarget, 1, 8);
      const effectiveSymbols =
        symbols.length > 0 ? symbols : uniqueSymbols([...state.targetById.values()].map((row) => row.symbol)).slice(0, 8);

      push(
        "tool_start",
        "Map pathways",
        `Fetching Reactome pathways for ${effectiveSymbols.length} targets.`,
        "reactome",
        effectiveSymbols.slice(0, 8).map((symbol) => ({ type: "target", label: symbol })),
        "active",
      );

      let linkCount = 0;
      for (const symbol of effectiveSymbols) {
        const rows = await findPathwaysByGene(symbol).catch(() => []);
        const pathways = rows.slice(0, cappedPerTarget).map((row) => ({
          id: row.id,
          name: Array.isArray(row.name)
            ? row.name.map((item) => String(item)).join(", ")
            : String(row.name),
        }));
        state.pathwaysByTarget.set(symbol, pathways);
        for (const pathway of pathways) {
          linkTargetPathway(symbol, pathway);
          linkCount += 1;
        }
      }

      push(
        "tool_result",
        "Pathways mapped",
        `${linkCount} pathway links mapped from ${effectiveSymbols.length} targets.`,
        "reactome",
        [...state.pathwayById.values()].slice(0, 8).map((pathway) => ({
          type: "pathway",
          label: pathway.name,
          primaryId: pathway.id,
        })),
        linkCount > 0 ? "active" : "candidate",
      );

      const topPathwaysByTarget = effectiveSymbols.map((symbol) => ({
        symbol,
        pathways: (state.pathwaysByTarget.get(symbol) ?? [])
          .slice(0, Math.min(3, cappedPerTarget))
          .map((pathway) => ({
            id: pathway.id,
            name: pathway.name,
          })),
      }));

      return JSON.stringify({
        requestedTargetCount: effectiveSymbols.length,
        mappedTargetCount: topPathwaysByTarget.filter((row) => row.pathways.length > 0).length,
        totalPathwayLinks: linkCount,
        topPathwaysByTarget,
      });
    },
    {
      name: "fetch_target_pathways",
      description:
        "Fetch Reactome pathways for target symbols. Use this to populate mechanistic hops between targets and pathway processes.",
      schema: z.object({
        targetSymbolsCsv: z.string(),
        perTarget: z.number().int().min(1).max(8),
      }),
    },
  );

  const fetchDrugsTool = tool(
    async ({ targetSymbolsCsv, perTarget }) => {
      const symbols = uniqueSymbols(parseSymbolsCsv(targetSymbolsCsv));
      const cappedPerTarget = clamp(perTarget, 1, 8);
      const effectiveSymbols =
        symbols.length > 0 ? symbols : uniqueSymbols([...state.targetById.values()].map((row) => row.symbol)).slice(0, 8);

      push(
        "tool_start",
        "Map drugability",
        `Fetching compound evidence for ${effectiveSymbols.length} targets.`,
        "chembl",
        effectiveSymbols.slice(0, 8).map((symbol) => ({ type: "target", label: symbol })),
        "active",
      );

      let linkCount = 0;
      for (const symbol of effectiveSymbols) {
        const target = [...state.targetById.values()].find(
          (row) => row.symbol.toUpperCase() === symbol.toUpperCase(),
        );
        const [known, activity] = await Promise.allSettled([
          target ? getKnownDrugsForTarget(target.id, cappedPerTarget) : Promise.resolve([]),
          getTargetActivityDrugs(symbol, cappedPerTarget),
        ]);

        const merged = new Map<string, DrugInfo>();
        if (known.status === "fulfilled") {
          for (const row of known.value) {
            merged.set(row.drugId, {
              id: row.drugId,
              name: row.name,
              source: "opentargets",
            });
          }
        }
        if (activity.status === "fulfilled") {
          for (const row of activity.value) {
            merged.set(row.moleculeId, {
              id: row.moleculeId,
              name: row.name,
              source: "chembl",
            });
          }
        }

        const drugs = [...merged.values()].slice(0, cappedPerTarget);
        state.drugsByTarget.set(symbol, drugs);
        for (const drug of drugs) {
          linkTargetDrug(symbol, drug);
          linkCount += 1;
        }
      }

      push(
        "tool_result",
        "Druggability mapped",
        `${linkCount} target-drug links mapped.`,
        "chembl",
        [...state.drugById.values()].slice(0, 8).map((drug) => ({
          type: "drug",
          label: drug.name,
          primaryId: drug.id,
        })),
        linkCount > 0 ? "active" : "candidate",
      );

      const topDrugsByTarget = effectiveSymbols.map((symbol) => ({
        symbol,
        drugs: (state.drugsByTarget.get(symbol) ?? [])
          .slice(0, Math.min(3, cappedPerTarget))
          .map((drug) => ({
            id: drug.id,
            name: drug.name,
            source: drug.source,
          })),
      }));

      return JSON.stringify({
        requestedTargetCount: effectiveSymbols.length,
        mappedTargetCount: topDrugsByTarget.filter((row) => row.drugs.length > 0).length,
        totalDrugLinks: linkCount,
        topDrugsByTarget,
      });
    },
    {
      name: "fetch_target_drugs",
      description:
        "Fetch compounds linked to targets using OpenTargets known drugs and ChEMBL activity evidence.",
      schema: z.object({
        targetSymbolsCsv: z.string(),
        perTarget: z.number().int().min(1).max(8),
      }),
    },
  );

  const fetchInteractionsTool = tool(
    async ({ targetSymbolsCsv, confidence, maxNeighbors }) => {
      const symbols = uniqueSymbols(parseSymbolsCsv(targetSymbolsCsv));
      const effectiveSymbols =
        symbols.length > 0 ? symbols : uniqueSymbols([...state.targetById.values()].map((row) => row.symbol)).slice(0, 12);
      const conf = clamp(confidence, 0.1, 1);
      const maxN = clamp(maxNeighbors, 8, 80);

      push(
        "tool_start",
        "Map interaction neighborhood",
        `Fetching STRING neighborhood for ${effectiveSymbols.length} targets (conf ${conf.toFixed(2)}).`,
        "string",
        effectiveSymbols.slice(0, 8).map((symbol) => ({ type: "target", label: symbol })),
        "active",
      );

      const network = await getInteractionNetwork(effectiveSymbols, conf, maxN).catch(() => ({
        nodes: [],
        edges: [],
      }));

      for (const node of network.nodes) {
        const symbol = clean(node.symbol).toUpperCase();
        if (!symbol) continue;
        state.interactionSymbols.add(symbol);
      }

      for (const edge of network.edges) {
        linkTargetInteraction(edge.sourceSymbol, edge.targetSymbol, edge.score);
      }

      push(
        "tool_result",
        "Interaction network mapped",
        `${network.nodes.length} interaction nodes and ${network.edges.length} edges mapped.`,
        "string",
        network.nodes.slice(0, 8).map((node) => ({
          type: "interaction",
          label: node.symbol,
          primaryId: node.id,
        })),
        network.edges.length > 0 ? "active" : "candidate",
      );

      const topInteractionEdges = [...network.edges]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 40)
        .map((edge) => ({
          sourceSymbol: edge.sourceSymbol,
          targetSymbol: edge.targetSymbol,
          score: edge.score,
        }));
      const topInteractionNodes = network.nodes.slice(0, 24).map((node) => ({
        id: node.id,
        symbol: node.symbol,
        annotation: node.annotation,
      }));

      return JSON.stringify({
        seedTargetCount: effectiveSymbols.length,
        interactionNodeCount: network.nodes.length,
        interactionEdgeCount: network.edges.length,
        topInteractionNodes,
        topInteractionEdges,
      });
    },
    {
      name: "fetch_interaction_neighbors",
      description:
        "Fetch STRING interaction neighborhood for seed targets. Use this to test bridge hops between anchors.",
      schema: z.object({
        targetSymbolsCsv: z.string(),
        confidence: z.number().min(0.1).max(1),
        maxNeighbors: z.number().int().min(8).max(80),
      }),
    },
  );

  const collectBioMcpTool = tool(
    async ({ diseaseName, targetSymbol, interventionHint }) => {
      const disease = clean(diseaseName);
      const target = clean(targetSymbol);
      const intervention = clean(interventionHint ?? "");
      if (!disease || !target) {
        return JSON.stringify({ articles: 0, trials: 0 });
      }

      push(
        "tool_start",
        "Collect literature/trials",
        `Collecting BioMCP snippets for ${disease} / ${target}.`,
        "biomcp",
        [
          { type: "disease", label: disease },
          { type: "target", label: target },
        ],
        "active",
      );

      const data = await getLiteratureAndTrials(disease, target, intervention || undefined).catch(
        () => ({ articles: [], trials: [] }),
      );
      state.bioMcpCounts.articles += data.articles.length;
      state.bioMcpCounts.trials += data.trials.length;
      for (const article of data.articles) {
        if (!state.bioMcpArticles.some((row) => row.id === article.id)) {
          state.bioMcpArticles.push({
            id: article.id,
            title: article.title,
            source: article.source,
            url: article.url,
          });
        }
      }
      for (const trial of data.trials) {
        if (!state.bioMcpTrials.some((row) => row.id === trial.id)) {
          state.bioMcpTrials.push({
            id: trial.id,
            title: trial.title,
            source: trial.source,
            url: trial.url,
            status: trial.status,
          });
        }
      }

      const extractedEntities = await extractAndLinkEvidenceEntities({
        source: "biomcp",
        snippets: [
          ...data.articles.map((article) => article.title),
          ...data.trials.map((trial) => trial.title),
        ],
        diseaseName: disease,
        targetSymbol: target,
      });
      if (extractedEntities.length > 0) {
        push(
          "insight",
          "Exposure-aware evidence lane updated",
          `${extractedEntities.length} exposure/mechanism/outcome entities extracted from BioMCP snippets.`,
          "evidence",
          extractedEntities.slice(0, 6).map((entity) => ({
            type: "effect",
            label: entity.label,
            evidenceCategory: entity.category,
          })),
          "active",
        );
      }

      push(
        "tool_result",
        "BioMCP evidence collected",
        `${data.articles.length} article snippets and ${data.trials.length} trial snippets collected.${
          extractedEntities.length > 0 ? ` ${extractedEntities.length} evidence entities mapped.` : ""
        }`,
        "biomcp",
        [
          ...data.articles.slice(0, 3).map((article) => ({
            type: "effect" as const,
            label: article.title,
            primaryId: article.id,
          })),
          ...data.trials.slice(0, 2).map((trial) => ({
            type: "effect" as const,
            label: trial.title,
            primaryId: trial.id,
          })),
        ],
        data.articles.length + data.trials.length > 0 ? "active" : "candidate",
      );

      return JSON.stringify({
        articleCount: data.articles.length,
        trialCount: data.trials.length,
      });
    },
    {
      name: "collect_biomcp_evidence",
      description:
        "Collect BioMCP article/trial snippets for disease-target context and optional intervention.",
      schema: z.object({
        diseaseName: z.string(),
        targetSymbol: z.string(),
        interventionHint: z.string(),
      }),
    },
  );

  const collectPubmedPairTool = tool(
    async ({ diseaseName, targetSymbol, limit }) => {
      const disease = clean(diseaseName);
      const target = clean(targetSymbol);
      const capped = clamp(limit, 1, 6);
      if (!disease || !target) {
        return JSON.stringify({ articles: [] });
      }

      const pairQuery = `${target} AND ${disease}`;
      const pairKey = normalizePubmedQuery(pairQuery);
      const cachedPairArticles = state.pubmedByQuery.get(pairKey);
      if (cachedPairArticles) {
        push(
          "tool_result",
          "PubMed pair evidence cached",
          `${cachedPairArticles.length} cached articles for ${target} / ${disease}.`,
          "pubmed",
          cachedPairArticles.slice(0, 3).map((article) => ({
            type: "effect",
            label: article.title,
            primaryId: article.id,
          })),
          cachedPairArticles.length > 0 ? "active" : "candidate",
        );
        return JSON.stringify({
          query: pairQuery,
          articleCount: cachedPairArticles.length,
          cached: true,
        });
      }

      if (state.pubmedSubqueriesUsed >= MAX_PUBMED_SUBQUERIES) {
        push(
          "warning",
          "PubMed budget exhausted",
          `Skipping pair query for ${disease} / ${target} because budget is ${MAX_PUBMED_SUBQUERIES}.`,
          "pubmed",
          [
            { type: "disease", label: disease },
            { type: "target", label: target },
          ],
          "discarded",
        );
        return JSON.stringify({ articles: [], budgetExhausted: true });
      }

      state.pubmedSubqueriesUsed += 1;
      push(
        "tool_start",
        "Collect PubMed evidence",
        `Pair query ${state.pubmedSubqueriesUsed}/${MAX_PUBMED_SUBQUERIES}: ${target} AND ${disease}.`,
        "pubmed",
        [
          { type: "disease", label: disease },
          { type: "target", label: target },
        ],
        "active",
      );

      const articles = await getPubmedArticles(disease, target, capped).catch(() => []);
      state.pubmedSubqueryHits.push({ query: pairQuery, articles });
      state.pubmedByQuery.set(pairKey, articles);

      if (articles.length > 0) {
        const targetNode = [...state.targetById.values()].find(
          (row) => row.symbol.toUpperCase() === target.toUpperCase(),
        );
        if (targetNode) {
          const targetKey = upsertTargetNode(targetNode);
          const evidenceKey = upsertNode(state, {
            type: "effect",
            label: `PubMed: ${target} / ${disease}`,
            primaryId: `PUBMED_${target}_${disease}`,
          });
          upsertEdge(state, {
            sourceKey: targetKey,
            targetKey: evidenceKey,
            relation: "pubmed_support",
            source: "pubmed",
            score: 0.45,
            note: `${articles.length} PubMed articles`,
          });
        }
      }

      const extractedEntities =
        articles.length > 0
          ? await extractAndLinkEvidenceEntities({
              source: "pubmed",
              snippets: articles.map((article) => article.title),
              diseaseName: disease,
              targetSymbol: target,
            })
          : [];
      if (extractedEntities.length > 0) {
        push(
          "insight",
          "Exposure-aware evidence lane updated",
          `${extractedEntities.length} exposure/mechanism/outcome entities extracted from PubMed pair evidence.`,
          "evidence",
          extractedEntities.slice(0, 6).map((entity) => ({
            type: "effect",
            label: entity.label,
            evidenceCategory: entity.category,
          })),
          "active",
        );
      }

      push(
        "tool_result",
        "PubMed pair evidence",
        `${articles.length} articles collected for ${target} / ${disease}.${
          extractedEntities.length > 0 ? ` ${extractedEntities.length} evidence entities mapped.` : ""
        }`,
        "pubmed",
        articles.slice(0, 3).map((article) => ({
          type: "effect",
          label: article.title,
          primaryId: article.id,
        })),
        articles.length > 0 ? "active" : "candidate",
      );

      return JSON.stringify({
        query: pairQuery,
        articleCount: articles.length,
      });
    },
    {
      name: "collect_pubmed_pair_evidence",
      description:
        `Collect PubMed evidence for disease-target pairs. This consumes from a strict max-${MAX_PUBMED_SUBQUERIES} PubMed query budget.`,
      schema: z.object({
        diseaseName: z.string(),
        targetSymbol: z.string(),
        limit: z.number().int().min(1).max(6),
      }),
    },
  );

  const searchPubmedSubqueryTool = tool(
    async ({ subquery, limit }) => {
      const query = compact(subquery, 260);
      const capped = clamp(limit, 1, 6);
      if (!query) {
        return JSON.stringify({ articles: [] });
      }

      const queryKey = normalizePubmedQuery(query);
      const cachedArticles = state.pubmedByQuery.get(queryKey);
      if (cachedArticles) {
        push(
          "tool_result",
          "PubMed subquery cached",
          `${cachedArticles.length} cached articles returned for subquery.`,
          "pubmed",
          cachedArticles.slice(0, 3).map((article) => ({
            type: "effect",
            label: article.title,
            primaryId: article.id,
          })),
          cachedArticles.length > 0 ? "active" : "candidate",
        );
        return JSON.stringify({
          query,
          articleCount: cachedArticles.length,
          cached: true,
        });
      }

      if (state.pubmedSubqueriesUsed >= MAX_PUBMED_SUBQUERIES) {
        push(
          "warning",
          "PubMed budget exhausted",
          `Skipping subquery \"${query}\" because budget is ${MAX_PUBMED_SUBQUERIES}.`,
          "pubmed",
          [],
          "discarded",
        );
        return JSON.stringify({ query, articleCount: 0, budgetExhausted: true });
      }

      state.pubmedSubqueriesUsed += 1;
      push(
        "tool_start",
        "Run PubMed subquery",
        `Subquery ${state.pubmedSubqueriesUsed}/${MAX_PUBMED_SUBQUERIES}: ${query}`,
        "pubmed",
        [],
        "active",
      );

      const articles = await searchPubmedByQuery(query, capped).catch(() => []);
      state.pubmedSubqueryHits.push({ query, articles });
      state.pubmedByQuery.set(queryKey, articles);

      const extractedEntities =
        articles.length > 0
          ? await extractAndLinkEvidenceEntities({
              source: "pubmed",
              snippets: articles.map((article) => article.title),
            })
          : [];
      if (extractedEntities.length > 0) {
        push(
          "insight",
          "Exposure-aware evidence lane updated",
          `${extractedEntities.length} exposure/mechanism/outcome entities extracted from PubMed subquery evidence.`,
          "evidence",
          extractedEntities.slice(0, 6).map((entity) => ({
            type: "effect",
            label: entity.label,
            evidenceCategory: entity.category,
          })),
          "active",
        );
      }

      push(
        "tool_result",
        "PubMed subquery complete",
        `${articles.length} articles returned for subquery.${
          extractedEntities.length > 0 ? ` ${extractedEntities.length} evidence entities mapped.` : ""
        }`,
        "pubmed",
        articles.slice(0, 3).map((article) => ({
          type: "effect",
          label: article.title,
          primaryId: article.id,
        })),
        articles.length > 0 ? "active" : "candidate",
      );

      return JSON.stringify({ query, articleCount: articles.length });
    },
    {
      name: "search_pubmed_subquery",
      description:
        `Run one free-text PubMed subquery for bridge/mechanism evidence. Use sparingly; global budget is max ${MAX_PUBMED_SUBQUERIES} subqueries per run.`,
      schema: z.object({
        subquery: z.string(),
        limit: z.number().int().min(1).max(6),
      }),
    },
  );

  const recursiveExpandTool = tool(
    async ({ seedSymbolsCsv, hops, perHop }) => {
      const seeds = uniqueSymbols(parseSymbolsCsv(seedSymbolsCsv));
      const hopCount = clamp(hops, 1, 3);
      const perHopLimit = clamp(perHop, 2, 8);
      let frontier = seeds.length > 0
        ? seeds.slice(0, perHopLimit)
        : uniqueSymbols([...state.targetById.values()].map((row) => row.symbol)).slice(0, perHopLimit);

      let addedTotal = 0;
      for (let hop = 1; hop <= hopCount; hop += 1) {
        if (frontier.length === 0) break;
        push(
          "tool_start",
          `Recursive multihop expansion (hop ${hop}/${hopCount})`,
          `Expanding frontier: ${frontier.join(", ")}.`,
          "agent",
          frontier.map((symbol) => ({ type: "target", label: symbol })),
          "candidate",
        );

        const network = await getInteractionNetwork(frontier, 0.72, clamp(perHopLimit * 6, 10, 60)).catch(
          () => ({ nodes: [], edges: [] }),
        );

        const nextFrontier: string[] = [];
        for (const edge of network.edges) {
          linkTargetInteraction(edge.sourceSymbol, edge.targetSymbol, edge.score);
        }

        for (const node of network.nodes) {
          const symbol = clean(node.symbol).toUpperCase();
          if (!symbol) continue;
          if (frontier.includes(symbol)) continue;
          if (state.targetById.has(symbol)) continue;
          nextFrontier.push(symbol);
        }

        const newlyResolved: TargetInfo[] = [];
        for (const candidate of uniqueSymbols(nextFrontier).slice(0, perHopLimit)) {
          const hits = await searchTargets(candidate, 3).catch(() => []);
          const hit = hits[0];
          const target: TargetInfo = {
            id: hit?.id ?? `TARGET_${candidate}`,
            symbol: hit?.name ?? candidate,
            name: hit?.name ?? candidate,
            score: hit ? 0.35 : 0.2,
          };
          if (!state.targetById.has(target.id)) {
            state.targetById.set(target.id, target);
            upsertTargetNode(target);
            newlyResolved.push(target);
          }
        }

        addedTotal += newlyResolved.length;
        frontier = newlyResolved.map((row) => row.symbol).slice(0, perHopLimit);

        push(
          "tool_result",
          `Recursive hop ${hop} result`,
          `${newlyResolved.length} new targets added from frontier expansion.`,
          "agent",
          newlyResolved.slice(0, 6).map((target) => ({
            type: "target",
            label: target.symbol,
            primaryId: target.id,
          })),
          newlyResolved.length > 0 ? "active" : "discarded",
        );
      }

      return JSON.stringify({
        addedTargets: addedTotal,
      });
    },
    {
      name: "recursive_expand_multihop",
      description:
        "Expand multihop target frontier using STRING neighbors and target resolver followups.",
      schema: z.object({
        seedSymbolsCsv: z.string(),
        hops: z.number().int().min(1).max(3),
        perHop: z.number().int().min(2).max(8),
      }),
    },
  );

  const baseToolset = [
    resolveEntityCandidatesTool,
    fetchDiseaseTargetsTool,
    fetchPathwaysTool,
    fetchDrugsTool,
    fetchInteractionsTool,
    collectBioMcpTool,
    recursiveExpandTool,
  ];

  const pubmedToolset = [
    collectPubmedPairTool,
    searchPubmedSubqueryTool,
  ];

  const toolsetWithPubmed = [
    ...baseToolset,
    ...pubmedToolset,
  ];

  const toolsetNoPubmed = [
    ...baseToolset,
  ];

  const modelDecision = chooseDiscovererModel({
    diseaseQuery,
    question: normalizedQuestion,
  });

  const strategicModelName = appConfig.openai.model;
  const subagentModelName = appConfig.openai.smallModel;
  const utilityModelName =
    modelDecision.tier === "full"
      ? appConfig.openai.smallModel
      : appConfig.openai.nanoModel;
  const activeOpenAiApiKey = getOpenAiApiKeyFromContext();

  const usageCallback = createLangChainUsageCallback({
    source: "langchain.chatopenai",
    operation: "deep_discover",
  });

  const strategicModel = new ChatOpenAI({
    model: strategicModelName,
    apiKey: activeOpenAiApiKey,
    callbacks: [usageCallback],
    ...getLangChainPromptCacheConfig(
      "deep_discover.strategic_model",
      strategicModelName,
    ),
  });
  const coordinatorModel = new ChatOpenAI({
    model: subagentModelName,
    apiKey: activeOpenAiApiKey,
    callbacks: [usageCallback],
    maxTokens: 700,
    ...getLangChainPromptCacheConfig(
      "deep_discover.coordinator_model",
      subagentModelName,
    ),
  });
  const subagentModel = new ChatOpenAI({
    model: subagentModelName,
    apiKey: activeOpenAiApiKey,
    callbacks: [usageCallback],
    maxTokens: 900,
    ...getLangChainPromptCacheConfig(
      "deep_discover.subagent_model",
      subagentModelName,
    ),
  });
  const utilityModel = new ChatOpenAI({
    model: utilityModelName,
    apiKey: activeOpenAiApiKey,
    callbacks: [usageCallback],
    maxTokens: 140,
    ...getLangChainPromptCacheConfig(
      "deep_discover.utility_model",
      utilityModelName,
    ),
  });

  push(
    "phase",
    "Model routing",
    [
      `Strategic reasoning: ${strategicModelName} (coordinator planning, subquery strategy, final synthesis).`,
      `Tool-heavy subagents: ${subagentModelName} (MCP interaction + branch exploration).`,
      `Utility summarization: ${utilityModelName} (compress subagent findings).`,
      `Complexity signal: ${modelDecision.reason}.`,
    ].join(" "),
    "agent",
    [],
    "active",
  );

  push(
    "phase",
    "Query planner",
    "Resolving typed anchors and constraints from resolver candidates.",
    "planner",
    [],
    "active",
  );

  try {
    state.queryPlan = await withOpenAiOperationContext(
      "deep_discover.query_planner",
      () =>
        withTimeout(
          planQuery(normalizedQuestion),
          boundedTimeout(Math.min(AGENT_TIMEOUT_MS, 180_000), 20_000),
          "query plan",
        ),
    );
  } catch (error) {
    push(
      "warning",
      "Query planner degraded",
      `Planner failed, continuing with minimal anchors (${error instanceof Error ? error.message : "unknown"}).`,
      "planner",
      [],
      "candidate",
    );
    state.queryPlan = {
      query: normalizedQuestion,
      intent: "multihop-discovery",
      anchors: [],
      constraints: [],
      unresolvedMentions: [],
      followups: [],
      rationale: "planner unavailable",
    };
  }

  resolveAnchorNodes();

  const diseaseMentions = resolveDiseaseCandidatesFromPlan(state.queryPlan, diseaseQuery || normalizedQuestion);
  for (const mention of diseaseMentions.slice(0, 3)) {
    try {
      const disease = await resolveDisease(state, mention, diseaseIdHint);
      push(
        "tool_result",
        "Disease resolved",
        `${disease.name} (${disease.id})`,
        "opentargets",
        [{ type: "disease", label: disease.name, primaryId: disease.id }],
        "active",
      );
    } catch {
      push(
        "warning",
        "Disease resolver degraded",
        `Could not resolve disease mention: ${mention}`,
        "opentargets",
        [{ type: "disease", label: mention }],
        "candidate",
      );
    }
  }

  if (hasTimeBudget(24_000)) {
    await probeAnchorPairLiterature();
  }

  const deterministicBackfill = async (reason: string) => {
    push(
      "insight",
      "Deterministic recovery",
      `Running deterministic retrieval (${reason}) to keep graph and narration live.`,
      "agent",
      [],
      "candidate",
    );

    const disease = [...state.diseaseById.values()][0];
    if (disease) {
      const rows = await getDiseaseTargetsSummary(disease.id, 10).catch(() => []);
      const targets = rows.slice(0, 10).map((row) => ({
        id: row.targetId,
        symbol: row.targetSymbol,
        name: row.targetName,
        score: row.associationScore,
      }));
      for (const target of targets) {
        linkDiseaseTarget(disease, target, target.score);
      }

      const topSymbols = targets.slice(0, 4).map((target) => target.symbol);
      for (const symbol of topSymbols) {
        const pathways = await findPathwaysByGene(symbol).catch(() => []);
        const compactPathways = pathways.slice(0, 2).map((row) => ({
          id: row.id,
          name: Array.isArray(row.name)
            ? row.name.map((item) => String(item)).join(", ")
            : String(row.name),
        }));
        state.pathwaysByTarget.set(symbol, compactPathways);
        for (const pathway of compactPathways) {
          linkTargetPathway(symbol, pathway);
        }

        const activity = await getTargetActivityDrugs(symbol, 2).catch(() => []);
        const compounds = activity.slice(0, 2).map((row) => ({
          id: row.moleculeId,
          name: row.name,
          source: "chembl" as const,
        }));
        state.drugsByTarget.set(symbol, compounds);
        for (const drug of compounds) {
          linkTargetDrug(symbol, drug);
        }

        if (state.pubmedSubqueriesUsed < MAX_PUBMED_SUBQUERIES) {
          state.pubmedSubqueriesUsed += 1;
          const articles = await getPubmedArticles(disease.name, symbol, 2).catch(() => []);
          const query = `${symbol} AND ${disease.name}`;
          state.pubmedSubqueryHits.push({ query, articles });
          state.pubmedByQuery.set(normalizePubmedQuery(query), articles);
        }
      }
    }
  };

  if (!activeOpenAiApiKey) {
    push(
      "warning",
      "OpenAI key missing",
      "Using deterministic retrieval only because OPENAI_API_KEY is not set.",
      "agent",
      [],
      "discarded",
    );
    await deterministicBackfill("openai-key-missing");
    return buildFallbackSummary(state, normalizedQuestion);
  }

  if (isOpenAiRateLimited()) {
    push(
      "warning",
      "OpenAI temporarily unavailable",
      "Using deterministic retrieval while rate limits recover.",
      "agent",
      [],
      "candidate",
    );
    await deterministicBackfill("openai-rate-limit");
    return buildFallbackSummary(state, normalizedQuestion);
  }

  const coordinatorPlanner = coordinatorModel.withStructuredOutput(coordinatorPlanSchema);

  const subagentContext = {
    query: normalizedQuestion,
    queryPlan: state.queryPlan
      ? {
          intent: state.queryPlan.intent,
          anchors: state.queryPlan.anchors.slice(0, 6).map((anchor) => ({
            mention: anchor.mention,
            entityType: anchor.entityType,
            id: anchor.id,
            name: anchor.name,
            confidence: anchor.confidence,
          })),
          constraints: state.queryPlan.constraints.slice(0, 6),
          followups: state.queryPlan.followups
            .slice(0, 3)
            .map((row) => row.question),
        }
      : null,
  };

  const subagentPromptCommon = [
    "Use tools to gather real evidence. Do not invent data.",
    "Prioritize anchor-specific subqueries and follow-up retrievals.",
    "Treat PubMed calls as expensive; only use them to close clear evidence gaps.",
    "If evidence is weak, mark pathState as candidate or discarded with explicit gaps.",
    "Return concise findings with named entities and mechanistic steps.",
  ].join(" ");

  type DiscovererTool = (typeof toolsetWithPubmed)[number];
  const createSubagentMap = (
    toolsForSubagent: DiscovererTool[],
  ): Record<CoordinatorTask["subagent"], ReturnType<typeof createAgent>> => ({
    pathway_mapper: createAgent({
      model: subagentModel,
      tools: toolsForSubagent,
      responseFormat: subagentReportSchema,
      systemPrompt: [
        "You are pathway_mapper.",
        "Goal: map target/pathway/interactions that answer the exact query.",
        "Prefer fetch_disease_targets, fetch_target_pathways, fetch_interaction_neighbors, recursive_expand_multihop, search_pubmed_subquery.",
        "Use resolve_entity_candidates when anchors are ambiguous.",
        subagentPromptCommon,
      ].join(" "),
    }),
    translational_scout: createAgent({
      model: subagentModel,
      tools: toolsForSubagent,
      responseFormat: subagentReportSchema,
      systemPrompt: [
        "You are translational_scout.",
        "Goal: map target->drug/moa evidence and identify tractable mechanistic threads.",
        "Prefer fetch_target_drugs, fetch_target_pathways, collect_biomcp_evidence, collect_pubmed_pair_evidence, search_pubmed_subquery.",
        "Use recursive_expand_multihop when direct links are weak.",
        subagentPromptCommon,
      ].join(" "),
    }),
    bridge_hunter: createAgent({
      model: subagentModel,
      tools: toolsForSubagent,
      responseFormat: subagentReportSchema,
      systemPrompt: [
        "You are bridge_hunter.",
        "Goal: connect multiple query anchors through explicit intermediate entities.",
        "Never claim direct bridge unless intermediate nodes are mapped.",
        "Prefer resolve_entity_candidates, fetch_disease_targets, fetch_target_pathways, fetch_interaction_neighbors, recursive_expand_multihop, search_pubmed_subquery.",
        subagentPromptCommon,
      ].join(" "),
    }),
    literature_scout: createAgent({
      model: subagentModel,
      tools: toolsForSubagent,
      responseFormat: subagentReportSchema,
      systemPrompt: [
        "You are literature_scout.",
        "Goal: generate focused PubMed/BioMCP evidence for active mechanistic branches.",
        "Use max-precision subqueries and tie each evidence pull to an active entity pair.",
        "Prefer search_pubmed_subquery, collect_pubmed_pair_evidence, collect_biomcp_evidence.",
        subagentPromptCommon,
      ].join(" "),
    }),
  });

  const subagentMapWithPubmed = createSubagentMap(toolsetWithPubmed);
  const subagentMapNoPubmed = createSubagentMap(toolsetNoPubmed);

  const runSubagentTask = async (task: CoordinatorTask): Promise<SubagentReport> => {
    if (!hasTimeBudget(12_000)) {
      emitRunBudgetWarning(
        "Subagent expansion stopped to preserve time for final synthesis.",
      );
      return {
        summary: `${task.subagent} skipped due remaining run-time budget.`,
        findings: [],
        followups: [],
        pathState: "candidate",
      };
    }

    push(
      "handoff",
      "Subagent handoff",
      `${task.subagent}: ${task.objective}`,
      "agent",
      task.seedEntities.slice(0, 6).map((label) => ({ type: "effect", label })),
      "active",
    );

    const pubmedBudgetRemaining = Math.max(0, MAX_PUBMED_SUBQUERIES - state.pubmedSubqueriesUsed);
    const activeSubagentMap =
      pubmedBudgetRemaining > 0 ? subagentMapWithPubmed : subagentMapNoPubmed;
    const subagent = activeSubagentMap[task.subagent];
    const response = await withOpenAiOperationContext(
      `deep_discover.subagent.${task.subagent}`,
      () =>
        withTimeout(
          subagent.invoke({
            messages: [
              {
                role: "user",
                content: [
                  `Query: ${normalizedQuestion}`,
                  `Task objective: ${task.objective}`,
                  `Seed entities: ${task.seedEntities.join(", ") || "none provided"}`,
                  `PubMed budget remaining: ${pubmedBudgetRemaining}/${MAX_PUBMED_SUBQUERIES}. ${
                    pubmedBudgetRemaining > 0
                      ? "Use PubMed tools only when a branch has unresolved mechanistic evidence."
                      : "Do not call search_pubmed_subquery or collect_pubmed_pair_evidence in this task."
                  }`,
                  `Structured query plan: ${JSON.stringify(subagentContext.queryPlan)}`,
                ].join("\n"),
              },
            ],
          }),
          boundedTimeout(SUBAGENT_TIMEOUT_MS, 12_000),
          `${task.subagent} invoke`,
        ),
    );

    const structured = response.structuredResponse as SubagentReport | undefined;
    const report: SubagentReport = structured ?? {
      summary:
        toAssistantText(response.messages[response.messages.length - 1]?.content) ||
        `${task.subagent} completed with unstructured response.`,
      findings: [],
      followups: [],
      pathState: "candidate",
    };

    const compressedSummary =
      report.summary.length > 180 || report.findings.length > 0
        ? await compressSubagentSummary(utilityModel, {
            objective: task.objective,
            summary: report.summary,
            findings: report.findings.slice(0, 4),
          }).catch(() => null)
        : null;
    const normalizedReport: SubagentReport = {
      ...report,
      summary: compressedSummary ?? report.summary,
    };

    push(
      "insight",
      `${task.subagent} summary`,
      compact(normalizedReport.summary, 220),
      "agent",
      [],
      normalizedReport.pathState,
    );

    for (const finding of normalizedReport.findings.slice(0, 4)) {
      push(
        "tool_result",
        "Subagent finding",
        compact(finding, 220),
        "agent",
        [],
        normalizedReport.pathState,
      );
    }

    for (const followup of normalizedReport.followups.slice(0, 3)) {
      push("followup", "Follow-up spawned", compact(followup, 200), "agent", [], "candidate");
    }

    return normalizedReport;
  };

  const buildDefaultTasks = (): CoordinatorTask[] => {
    const fallbackSeeds = (state.queryPlan?.anchors ?? []).map((anchor) => anchor.name).slice(0, 6);
    const hasMultiAnchor = (state.queryPlan?.anchors ?? []).length >= 2;
    const defaults: CoordinatorTask[] = [
      {
        subagent: "pathway_mapper",
        objective: `Map dominant target/pathway branches for: ${normalizedQuestion}`,
        seedEntities: fallbackSeeds,
      },
      {
        subagent: "translational_scout",
        objective: `Map target-drug/mechanism evidence for: ${normalizedQuestion}`,
        seedEntities: fallbackSeeds,
      },
      {
        subagent: hasMultiAnchor ? "bridge_hunter" : "literature_scout",
        objective: hasMultiAnchor
          ? `Test explicit bridge hypotheses between query anchors for: ${normalizedQuestion}`
          : `Collect focused literature evidence for: ${normalizedQuestion}`,
        seedEntities: fallbackSeeds,
      },
    ];
    return defaults;
  };

  let coordinatorTasks: CoordinatorTask[] = [];
  let initialPubmedSubqueries: string[] = [];

  push(
    "phase",
    "Coordinator planning",
    "Building query-specific subagent task graph.",
    "planner",
    [],
    "active",
  );

  try {
    if (!hasTimeBudget(25_000)) {
      emitRunBudgetWarning(
        "Skipping coordinator replanning to reserve budget for answer synthesis.",
      );
    } else {
      const plan = await withOpenAiOperationContext(
        "deep_discover.coordinator_planning",
        () =>
          withTimeout(
            coordinatorPlanner.invoke([
              {
                role: "system",
                content: [
                  "You are a coordinator for a multihop biomedical discovery workflow.",
                  "Plan query-specific tasks, do not produce generic disease pipelines.",
                  "The system has specialized subagents: pathway_mapper, translational_scout, bridge_hunter, literature_scout.",
                  "Return max 6 tasks, each with subagent, objective, and seed entities.",
                  `Return max ${MAX_PUBMED_SUBQUERIES} PubMed subqueries tailored to this question.`,
                  "Subqueries should be specific and mechanism-oriented, not boilerplate.",
                  "If the query has multiple anchors, include at least one bridge_hunter task.",
                  "If the query is mechanism/explain style, include at least one translational_scout or pathway_mapper task.",
                ].join(" "),
              },
              {
                role: "user",
                content: JSON.stringify(
                  {
                    query: normalizedQuestion,
                    queryPlan: subagentContext.queryPlan,
                    diseaseHint: diseaseQuery,
                    maxPubmedSubqueries: MAX_PUBMED_SUBQUERIES,
                  },
                  null,
                  2,
                ),
              },
            ]),
            boundedTimeout(COORDINATOR_TIMEOUT_MS, 10_000),
            "coordinator planning",
          ),
      );

      if (plan) {
        coordinatorTasks = (plan.tasks ?? []).slice(0, 6);
        initialPubmedSubqueries = (plan.pubmedSubqueries ?? []).slice(
          0,
          MAX_PUBMED_SUBQUERIES,
        );
        push(
          "handoff",
          "Coordinator plan ready",
          `${coordinatorTasks.length} tasks planned. Strategy: ${compact(plan.strategy, 140)}`,
          "planner",
          [],
          "active",
        );
      }
    }
  } catch (error) {
    handleOpenAiRateLimit(error);
    push(
      "warning",
      "Coordinator planner degraded",
      `Falling back to default task graph (${error instanceof Error ? error.message : "unknown"}).`,
      "planner",
      [],
      "candidate",
    );
  }

  if (coordinatorTasks.length === 0) {
    coordinatorTasks = buildDefaultTasks();
  }

  if (initialPubmedSubqueries.length === 0) {
    initialPubmedSubqueries = [
      normalizedQuestion,
      ...(state.queryPlan?.followups ?? []).map((row) => row.question),
    ].slice(0, Math.min(2, MAX_PUBMED_SUBQUERIES));
  }

  for (const subquery of initialPubmedSubqueries.slice(0, MAX_PUBMED_SUBQUERIES)) {
    if (!hasTimeBudget(40_000)) {
      emitRunBudgetWarning(
        "Stopped prefetching PubMed subqueries to keep budget for synthesis.",
      );
      break;
    }
    await searchPubmedSubqueryTool.invoke({ subquery, limit: 4 }).catch(() => undefined);
  }

  const primaryTasks = coordinatorTasks.slice(0, 2);
  const secondaryTasks = coordinatorTasks.slice(2);

  const reports: SubagentReport[] = [];
  const primarySettled = await Promise.allSettled(primaryTasks.map((task) => runSubagentTask(task)));
  for (const row of primarySettled) {
    if (row.status === "fulfilled") reports.push(row.value);
  }

  for (const task of secondaryTasks) {
    if (!hasTimeBudget(35_000)) {
      emitRunBudgetWarning(
        "Secondary task execution trimmed to preserve synthesis budget.",
      );
      break;
    }
    try {
      reports.push(await runSubagentTask(task));
    } catch (error) {
      push(
        "warning",
        "Subagent task degraded",
        `${task.subagent} failed: ${error instanceof Error ? error.message : "unknown"}`,
        "agent",
        [],
        "candidate",
      );
    }
  }

  const followupQueue = [
    ...(state.queryPlan?.followups ?? []).map((row: QueryPlanFollowup) => row.question),
    ...reports.flatMap((row) => row.followups),
  ];
  const dedupedFollowups = [...new Set(followupQueue.map((row) => clean(row)).filter(Boolean))].slice(0, 4);

  for (const followup of dedupedFollowups.slice(0, 2)) {
    if (!hasTimeBudget(28_000)) {
      emitRunBudgetWarning(
        "Follow-up branch expansion trimmed to close with a complete answer.",
      );
      break;
    }
    const routed = routeFollowupToSubagent(followup);
    const task: CoordinatorTask = {
      subagent: routed,
      objective: followup,
      seedEntities: (state.queryPlan?.anchors ?? []).map((anchor) => anchor.name).slice(0, 4),
    };
    try {
      reports.push(await runSubagentTask(task));
    } catch {
      push(
        "branch",
        "Follow-up branch discarded",
        `Unable to execute follow-up: ${compact(followup, 160)}`,
        "agent",
        [],
        "discarded",
      );
    }
  }

  if (state.targetById.size === 0 || state.edges.size === 0) {
    await deterministicBackfill("empty-agent-state");
  }

  const bridge = chooseBridgePath(state);
  const bridgeSummary = bridgePathToSummary(state, bridge.connectedPath);
  const thread = summarizeThread(state);

  push(
    "insight",
    "Active path",
    bridge.connectedPath
      ? `Connected path: ${bridgeSummary}`
      : `No complete multihop path yet. Best available thread: ${thread.pathway} -> ${thread.target} -> ${thread.drug}`,
    "agent",
    bridge.connectedPath
      ? bridge.connectedPath.nodeKeys
          .map((key) => state.nodes.get(key)?.entity)
          .filter((entity): entity is DiscoverEntity => Boolean(entity))
      : ([
          { type: "pathway", label: thread.pathway },
          { type: "target", label: thread.target },
          { type: "drug", label: thread.drug },
        ] satisfies DiscoverEntity[]).filter((entity) => entity.label !== "not provided"),
    bridge.connectedPath ? "active" : "candidate",
  );

  if (bridge.unresolvedPairs.length > 0) {
    push(
      "branch",
      "Unresolved anchor pair",
      bridge.unresolvedPairs.slice(0, 3).join(" | "),
      "planner",
      [],
      "discarded",
    );
  }

  const synthesisAgent = createAgent({
    model: strategicModel,
    tools: [],
    responseFormat: synthesisSchema,
    systemPrompt: [
      "You are a biomedical multihop synthesis agent.",
      "Answer the exact user query using only provided evidence summary.",
      "Use markdown headings in this order: '### Direct answer', '### Mechanistic support', '### What remains uncertain'.",
      "The first sentence must be a direct biomedical answer to the query.",
      "Write a substantive answer (roughly 180-280 words), not a one-liner.",
      "Name the query entities and the strongest supported mechanism path.",
      "Never return generic disease-centric text if query asks cross-anchor relations.",
      "If no complete mechanism path is found across the query entities, state that gap in plain biomedical language and list key intermediates that were tested.",
      "Use concise scientific language and include mechanism thread with intermediate hops when available.",
      "Cover unresolved evidence, contradictory findings, and missing links clearly but concisely (at most 10% of answer length).",
      "Do not use citation ranges like [6-10] or [6–10]; cite each number explicitly as [6][7][8][9][10].",
      "End with a complete sentence; do not stop mid-sentence.",
      "Do not use internal workflow words such as bridge, branch, planner, pipeline, anchor pair, or query graph in the answer text.",
      "Do not discuss UI state, run progress, or internal orchestration.",
      "Do not write meta phrases like 'the provided evidence summary' or 'this dataset'.",
      "Write the biomedical conclusion directly.",
      "Ignore placeholder values like 'not provided'; never surface them in findings or caveats.",
      "Do not add caveats about unrelated focus targets unless directly supported by mechanism evidence.",
      "Do not fabricate literature or confidence.",
    ].join(" "),
  });

  const citationPreview = state.pubmedSubqueryHits
    .flatMap((row) => row.articles)
    .slice(0, 6)
    .map((article, index) => `[${index + 1}] ${article.title}`);

  const synthesisInput: FreeformSynthesisInput = {
    query: normalizedQuestion,
    bridge: {
      connected: Boolean(bridge.connectedPath),
      summary: bridgeSummary,
      unresolvedPairs: bridge.unresolvedPairs,
    },
    thread,
    state,
    citationPreview,
    subagentSummaries: reports.slice(0, 8).map((row) => row.summary),
  };

  if (!hasTimeBudget(8_000)) {
    emitRunBudgetWarning(
      "Synthesis budget was exhausted; returning deterministic summary.",
    );
    return buildFallbackSummary(state, normalizedQuestion);
  }

  try {
    const synthesisResponse = await withOpenAiOperationContext(
      "deep_discover.final_structured_synthesis",
      () =>
        withTimeout(
          synthesisAgent.invoke({
            messages: [
              {
                role: "user",
                content: JSON.stringify(
                  {
                    query: normalizedQuestion,
                    queryPlan: {
                      intent: state.queryPlan?.intent,
                      anchors: state.queryPlan?.anchors.map((anchor) => ({
                        mention: anchor.mention,
                        entityType: anchor.entityType,
                        id: anchor.id,
                        name: anchor.name,
                      })),
                      constraints: state.queryPlan?.constraints,
                    },
                    mechanismPath: {
                      connected: synthesisInput.bridge.connected,
                      summary: synthesisInput.bridge.summary,
                      unresolvedPairs: synthesisInput.bridge.unresolvedPairs,
                    },
                    evidenceStats: {
                      nodes: synthesisInput.state.nodes.size,
                      edges: synthesisInput.state.edges.size,
                      targets: synthesisInput.state.targetById.size,
                      pathways: synthesisInput.state.pathwayById.size,
                      drugs: synthesisInput.state.drugById.size,
                      pubmedQueriesUsed: synthesisInput.state.pubmedSubqueriesUsed,
                      pubmedArticles: synthesisInput.state.pubmedSubqueryHits.reduce(
                        (acc, row) => acc + row.articles.length,
                        0,
                      ),
                      biomcpArticles: synthesisInput.state.bioMcpCounts.articles,
                      biomcpTrials: synthesisInput.state.bioMcpCounts.trials,
                    },
                    focusThread: synthesisInput.thread,
                    activePath: synthesisInput.bridge.summary,
                    citationPreview: synthesisInput.citationPreview,
                    subagentSummaries: synthesisInput.subagentSummaries,
                  },
                  null,
                  2,
                ),
              },
            ],
          }),
          boundedTimeout(AGENT_TIMEOUT_MS, 8_000),
          "final synthesis",
        ),
    );

    const structured = synthesisResponse.structuredResponse as
      | {
          directAnswer: string;
          keyFindings: string[];
          caveats: string[];
          nextActions: string[];
        }
      | undefined;

    const fallback = buildFallbackSummary(state, normalizedQuestion);
    const structuredAnswer = normalizeAnswerMarkdown(structured?.directAnswer ?? "");
    const rescueAnswer = structuredAnswer
      ? null
      : hasTimeBudget(7_000)
        ? await synthesizeFreeformNarrative(strategicModel, synthesisInput).catch(() => null)
        : null;
    const fallbackFindings = fallback.keyFindings.filter((item) => !/\bnot provided\b/i.test(item));
    const structuredFindings = (structured?.keyFindings ?? []).filter(Boolean).slice(0, 6);
    const structuredCaveats = (structured?.caveats ?? []).filter(Boolean).slice(0, 6);
    const selectedAnswerRaw =
      structuredAnswer ||
      rescueAnswer ||
      normalizeAnswerMarkdown(
        toAssistantText(
          synthesisResponse.messages[synthesisResponse.messages.length - 1]?.content,
        ),
      ) ||
      fallback.answer;
    const selectedAnswer = enrichIfTooBrief(
      normalizeAnswerMarkdown(selectedAnswerRaw),
      structuredFindings.length > 0 ? structuredFindings : fallbackFindings,
      structuredCaveats.length > 0 ? structuredCaveats : fallback.caveats,
    );

    return {
      answer: selectedAnswer,
      biomedicalCase: inferBiomedicalCase(normalizedQuestion),
      focusThread: bridge.connectedPath
        ? {
            pathway: bridgeSummary,
            target: thread.target,
            drug: thread.drug,
          }
        : thread,
      keyFindings:
        structuredFindings.length > 0
          ? [...structuredFindings, ...fallbackFindings.slice(0, Math.max(0, 6 - structuredFindings.length))]
          : fallback.keyFindings,
      caveats:
        structured?.caveats?.length
          ? structured.caveats
          : fallback.caveats,
      nextActions:
        structured?.nextActions?.length
          ? structured.nextActions
          : fallback.nextActions,
      evidenceBundle: buildEvidenceBundle(state),
    };
  } catch (error) {
    const reason = classifyDiscovererError(error);
    if (reason === "OpenAI rate-limited") {
      handleOpenAiRateLimit(error);
    }
    push(
      "warning",
      "Final synthesis degraded",
      `Returning deterministic summary (${reason}).`,
      "agent",
      [],
      "candidate",
    );
    if (reason !== "OpenAI rate-limited") {
      const rescued = hasTimeBudget(7_000)
        ? await synthesizeFreeformNarrative(strategicModel, synthesisInput).catch(() => null)
        : null;
      if (rescued) {
        const fallback = buildFallbackSummary(state, normalizedQuestion);
        return {
          ...fallback,
          answer: enrichIfTooBrief(rescued, fallback.keyFindings, fallback.caveats),
          evidenceBundle: buildEvidenceBundle(state),
        };
      }
    }
    return buildFallbackSummary(state, normalizedQuestion);
  }
}
