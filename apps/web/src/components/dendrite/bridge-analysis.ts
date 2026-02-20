import type { GraphEdge, GraphNode } from "@/lib/contracts";
import type { QueryPlan } from "@/hooks/useCaseRunStream";

type AnchorEntityType = "disease" | "target" | "drug" | "unknown";

export type BridgeAnchor = {
  id: string;
  label: string;
  entityType: AnchorEntityType;
  mention?: string;
  nodeId: string | null;
  virtualNodeId: string | null;
};

export type BridgePairOutcome = {
  pairId: string;
  fromAnchorId: string;
  toAnchorId: string;
  status: "connected" | "no_connection";
  reason: string;
  nodeIds: string[];
  edgeIds: string[];
  gapEdgeId?: string;
};

export type BridgeAnalysis = {
  anchors: BridgeAnchor[];
  pairs: BridgePairOutcome[];
  virtualNodes: GraphNode[];
  virtualEdges: GraphEdge[];
  activePairId: string | null;
  activeConnectedPath: { nodeIds: string[]; edgeIds: string[]; summary: string } | null;
  queryTrailPath: { nodeIds: string[]; edgeIds: string[]; summary: string } | null;
  status: "pending" | "connected" | "no_connection";
  summary: string;
};

type InternalAnchor = {
  id: string;
  label: string;
  mention?: string;
  entityType: AnchorEntityType;
  requestedType?: string;
};

type CandidateNodeHit = {
  nodeId: string;
  score: number;
};

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAnchorLabelKey(value: string): string {
  const tokens = normalize(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (token.length >= 5 && token.endsWith("s")) {
        return token.slice(0, -1);
      }
      return token;
    })
    .filter((token) => token.length > 0 && !/^(disease|disorder|syndrome)$/.test(token));
  return tokens.join(" ").trim();
}

function slug(value: string): string {
  return normalize(value).replace(/\s+/g, "-").slice(0, 52) || "anchor";
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function textSimilarity(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.72;
  const aTokens = a.split(" ").filter(Boolean);
  const bSet = new Set(b.split(" ").filter(Boolean));
  const shared = aTokens.filter((token) => bSet.has(token)).length;
  if (shared === 0) return 0;
  return shared / Math.max(aTokens.length, bSet.size);
}

function normalizeAnchorSpan(value: string): string {
  let compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  compact = compact.replace(
    /^(?:how|what|which|why)\s+(?:does|do|is|are|can|could|would|will|should)\s+/i,
    "",
  );
  compact = compact.replace(/^(?:how|what|which|why)\s+/i, "");
  const prepositionTailMatch = compact.match(/\b(?:in|for|of|with)\s+(.+)$/i);
  if (prepositionTailMatch?.[1]) {
    const tail = prepositionTailMatch[1].replace(/\s+/g, " ").trim();
    if (tail.length >= 3) return tail;
  }
  return compact;
}

function parseAnchorMentionsFromQuery(query: string): string[] {
  const cleaned = query.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const mentions = new Set<string>();
  const addMention = (value: string) => {
    const normalized = normalizeAnchorSpan(value);
    if (!normalized) return;
    if (normalized.length > 72) return;
    if (normalized.split(/\s+/).filter(Boolean).length > 6) return;
    mentions.add(normalized);
  };

  const betweenMatch = cleaned.match(
    /\bbetween\s+(.+?)\s+and\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (betweenMatch) {
    addMention(betweenMatch[1] ?? "");
    addMention(betweenMatch[2] ?? "");
    addMention(betweenMatch[3] ?? "");
  }

  const connectMatch = cleaned.match(
    /\b(?:connect|connection|relationship|link|overlap)\s+(?:between\s+)?(.+?)\s+(?:to|and|vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (connectMatch) {
    addMention(connectMatch[1] ?? "");
    addMention(connectMatch[2] ?? "");
    addMention(connectMatch[3] ?? "");
  }

  const connectPrecedingMatch = cleaned.match(
    /(.+?)\s+(?:connect|connection|relationship|link|overlap)\s+(?:to|and|vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (connectPrecedingMatch) {
    addMention(connectPrecedingMatch[1] ?? "");
    addMention(connectPrecedingMatch[2] ?? "");
    addMention(connectPrecedingMatch[3] ?? "");
  }

  const versusMatch = cleaned.match(
    /\b(.+?)\s+(?:vs|versus)\s+(.+?)(?:\s+(?:through|via|using|with)\s+(.+))?$/i,
  );
  if (versusMatch) {
    addMention(versusMatch[1] ?? "");
    addMention(versusMatch[2] ?? "");
    addMention(versusMatch[3] ?? "");
  }

  return [...mentions];
}

function queryAnchorRoleOrder(value: unknown): number {
  if (typeof value !== "string") return 9;
  const normalized = value.toLowerCase();
  if (normalized === "query_anchor_primary") return 0;
  if (normalized === "query_anchor_secondary") return 1;
  if (normalized.includes("query_anchor")) return 2;
  return 9;
}

function collectGraphAnchors(nodes: GraphNode[]): InternalAnchor[] {
  return [...nodes]
    .filter((node) => node.type === "disease")
    .filter((node) => queryAnchorRoleOrder(node.meta.role) < 9 || Boolean(node.meta.queryAnchor))
    .sort((a, b) => {
      const roleDelta = queryAnchorRoleOrder(a.meta.role) - queryAnchorRoleOrder(b.meta.role);
      if (roleDelta !== 0) return roleDelta;
      return (b.score ?? 0) - (a.score ?? 0);
    })
    .map((node) => ({
      id: `disease:${node.primaryId}`,
      label:
        (typeof node.meta.displayName === "string" && node.meta.displayName.trim().length > 0
          ? node.meta.displayName
          : node.label
        ).trim(),
      mention:
        (typeof node.meta.displayName === "string" && node.meta.displayName.trim().length > 0
          ? node.meta.displayName
          : node.label
        ).trim(),
      entityType: "disease" as const,
      requestedType: "disease",
    }));
}

function collectAnchors(
  query: string,
  queryPlan: QueryPlan | null | undefined,
  nodes: GraphNode[],
): InternalAnchor[] {
  const fromPlan: InternalAnchor[] = (queryPlan?.anchors ?? []).map((anchor) => ({
    id: `${anchor.entityType}:${anchor.id}`,
    label: anchor.name,
    mention: anchor.mention,
    entityType: anchor.entityType,
    requestedType: anchor.requestedType,
  }));
  const fromGraph = collectGraphAnchors(nodes);

  const parsed = parseAnchorMentionsFromQuery(query).map((mention) => ({
    id: `query:${slug(mention)}`,
    label: mention,
    mention,
    entityType: "unknown" as const,
  }));

  const seeded = uniqueBy<InternalAnchor>(
    [...fromGraph, ...fromPlan],
    (item) => `${item.entityType}:${normalizeAnchorLabelKey(item.label) || normalize(item.label)}`,
  );
  const typedAnchorCount = seeded.filter((anchor) => anchor.entityType !== "unknown").length;
  const speculativeUnknownAnchors = typedAnchorCount >= 2 ? [] : parsed;
  const merged = uniqueBy<InternalAnchor>(
    [...seeded, ...speculativeUnknownAnchors],
    (item) => normalize(item.label),
  );
  const queryNorm = normalize(query);
  const indexInQuery = (value: string): number => {
    const token = normalize(value);
    if (!token || !queryNorm) return Number.MAX_SAFE_INTEGER;
    const idx = queryNorm.indexOf(token);
    return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
  };

  const sorted = merged
    .sort((a, b) => {
      const aTyped = a.entityType === "unknown" ? 1 : 0;
      const bTyped = b.entityType === "unknown" ? 1 : 0;
      if (aTyped !== bTyped) return aTyped - bTyped;
      const aIdx = indexInQuery(a.mention || a.label);
      const bIdx = indexInQuery(b.mention || b.label);
      if (aIdx !== bIdx) return aIdx - bIdx;
      return a.label.length - b.label.length;
    });

  const typedOnly = sorted.filter((anchor) => anchor.entityType !== "unknown");
  if (typedOnly.length >= 2) return typedOnly.slice(0, 5);
  return sorted.slice(0, 5);
}

function resolveAnchorToNode(anchor: InternalAnchor, nodes: GraphNode[]): CandidateNodeHit | null {
  const [anchorEntityType, anchorEntityId] = anchor.id.split(":");
  const anchorNorm = normalize(anchor.label);

  if (
    anchorEntityId &&
    (anchorEntityType === "disease" || anchorEntityType === "target" || anchorEntityType === "drug")
  ) {
    const exactByPrimary = nodes.find(
      (node) => node.primaryId.toLowerCase() === anchorEntityId.toLowerCase(),
    );
    if (exactByPrimary) {
      return { nodeId: exactByPrimary.id, score: 1 };
    }
  }

  const hits: CandidateNodeHit[] = [];
  for (const node of nodes) {
    if (anchor.entityType !== "unknown" && node.type !== anchor.entityType) continue;
    const nameCandidates = [
      node.label,
      typeof node.meta.displayName === "string" ? node.meta.displayName : "",
      typeof node.meta.targetSymbol === "string" ? node.meta.targetSymbol : "",
    ].filter(Boolean);

    const bestScore = nameCandidates.reduce(
      (best, candidate) => Math.max(best, textSimilarity(anchorNorm, candidate)),
      0,
    );
    if (bestScore >= 0.5) {
      hits.push({ nodeId: node.id, score: bestScore });
    }
  }

  if (hits.length === 0) return null;
  hits.sort((a, b) => b.score - a.score);
  return hits[0] ?? null;
}

function semanticAnchorKey(anchor: Pick<BridgeAnchor, "entityType" | "label">): string {
  const normalized = normalizeAnchorLabelKey(anchor.label);
  return `${anchor.entityType}:${normalized || normalize(anchor.label)}`;
}

function dedupeAnchors(anchors: BridgeAnchor[]): BridgeAnchor[] {
  const out: BridgeAnchor[] = [];
  const keyToIndex = new Map<string, number>();

  for (const anchor of anchors) {
    const keys = [semanticAnchorKey(anchor)];
    if (anchor.nodeId) keys.unshift(`node:${anchor.nodeId}`);
    if (anchor.virtualNodeId) keys.push(`virtual:${anchor.virtualNodeId}`);

    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index): index is number => typeof index === "number");

    if (existingIndex === undefined) {
      const index = out.length;
      out.push(anchor);
      for (const key of keys) keyToIndex.set(key, index);
      continue;
    }

    const existing = out[existingIndex]!;
    const shouldReplace =
      !existing.nodeId &&
      Boolean(anchor.nodeId) &&
      anchor.entityType !== "unknown";
    if (shouldReplace) {
      out[existingIndex] = anchor;
    }

    const canonical = out[existingIndex]!;
    const canonicalKeys = [semanticAnchorKey(canonical)];
    if (canonical.nodeId) canonicalKeys.unshift(`node:${canonical.nodeId}`);
    if (canonical.virtualNodeId) canonicalKeys.push(`virtual:${canonical.virtualNodeId}`);
    for (const key of [...keys, ...canonicalKeys]) {
      keyToIndex.set(key, existingIndex);
    }
  }

  return out;
}

function buildAdjacency(
  edges: GraphEdge[],
  options?: {
    excludeDiseaseDisease?: boolean;
  },
) {
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>();
  for (const edge of edges) {
    if (options?.excludeDiseaseDisease && edge.type === "disease_disease") {
      continue;
    }
    const sourceTag =
      typeof edge.meta.source === "string" ? edge.meta.source.toLowerCase() : "";
    const isQueryBridgeProxy =
      edge.type === "disease_disease" &&
      (sourceTag === "query_anchor" || sourceTag === "query_gap");
    if (isQueryBridgeProxy) {
      // Query-bridge proxy edges visualize anchor gap/bridge state, but are not mechanistic steps.
      continue;
    }

    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      { nodeId: edge.target, edgeId: edge.id },
    ]);
    adjacency.set(edge.target, [
      ...(adjacency.get(edge.target) ?? []),
      { nodeId: edge.source, edgeId: edge.id },
    ]);
  }
  return adjacency;
}

function shortestPath(
  startNodeId: string,
  endNodeId: string,
  adjacency: Map<string, Array<{ nodeId: string; edgeId: string }>>,
): { nodeIds: string[]; edgeIds: string[] } | null {
  if (startNodeId === endNodeId) {
    return { nodeIds: [startNodeId], edgeIds: [] };
  }

  const queue = [startNodeId];
  const visited = new Set<string>([startNodeId]);
  const parentNode = new Map<string, string>();
  const parentEdge = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor.nodeId)) continue;
      visited.add(neighbor.nodeId);
      parentNode.set(neighbor.nodeId, current);
      parentEdge.set(neighbor.nodeId, neighbor.edgeId);
      if (neighbor.nodeId === endNodeId) {
        const nodeIds = [endNodeId];
        const edgeIds: string[] = [];
        let cursor = endNodeId;
        while (parentNode.has(cursor)) {
          edgeIds.unshift(parentEdge.get(cursor)!);
          cursor = parentNode.get(cursor)!;
          nodeIds.unshift(cursor);
        }
        return { nodeIds, edgeIds };
      }
      queue.push(neighbor.nodeId);
    }
  }
  return null;
}

function labelForAnchorType(anchor: BridgeAnchor): GraphNode["type"] {
  if (anchor.entityType === "target") return "target";
  if (anchor.entityType === "drug") return "drug";
  return "disease";
}

function buildQueryTrailPath(
  anchors: BridgeAnchor[],
  pairs: BridgePairOutcome[],
): { nodeIds: string[]; edgeIds: string[]; summary: string } | null {
  if (pairs.length === 0) return null;

  const trailNodeIds: string[] = [];
  const trailEdgeIds = new Set<string>();
  for (const pair of pairs) {
    if (pair.nodeIds.length > 0) {
      if (trailNodeIds.length === 0) {
        trailNodeIds.push(...pair.nodeIds);
      } else {
        const last = trailNodeIds[trailNodeIds.length - 1];
        if (last && pair.nodeIds[0] === last) {
          trailNodeIds.push(...pair.nodeIds.slice(1));
        } else {
          trailNodeIds.push(...pair.nodeIds);
        }
      }
    }
    for (const edgeId of pair.edgeIds) {
      trailEdgeIds.add(edgeId);
    }
  }

  if (trailNodeIds.length === 0) return null;
  const connectedCount = pairs.filter((pair) => pair.status === "connected").length;
  const summarySuffix =
    connectedCount === pairs.length
      ? "connected"
      : connectedCount > 0
        ? "partial bridge"
        : "no-connection";
  const labels = anchors.map((anchor) => anchor.label).filter((label) => label.length > 0);

  return {
    nodeIds: dedupePreserveOrder(trailNodeIds),
    edgeIds: [...trailEdgeIds],
    summary: `${labels.join(" -> ")} (${summarySuffix})`,
  };
}

export function analyzeBridgeOutcomes(input: {
  query: string;
  queryPlan: QueryPlan | null | undefined;
  nodes: GraphNode[];
  edges: GraphEdge[];
}): BridgeAnalysis {
  const { query, queryPlan, nodes, edges } = input;
  const anchorsRaw = collectAnchors(query, queryPlan, nodes);
  if (anchorsRaw.length < 2) {
    return {
      anchors: anchorsRaw.map((anchor) => ({
        id: anchor.id,
        label: anchor.label,
        mention: anchor.mention,
        entityType: anchor.entityType,
        nodeId: resolveAnchorToNode(anchor, nodes)?.nodeId ?? null,
        virtualNodeId: null,
      })),
      pairs: [],
      virtualNodes: [],
      virtualEdges: [],
      activePairId: null,
      queryTrailPath: null,
      activeConnectedPath: null,
      status: "pending",
      summary: "Waiting for at least two anchors to evaluate multihop connectivity.",
    };
  }

  const adjacency = buildAdjacency(edges);
  const adjacencyNoDiseaseShortcuts = buildAdjacency(edges, {
    excludeDiseaseDisease: true,
  });
  const anchors = dedupeAnchors(anchorsRaw.map((anchor) => ({
    id: anchor.id,
    label: anchor.label,
    mention: anchor.mention,
    entityType: anchor.entityType,
    nodeId: resolveAnchorToNode(anchor, nodes)?.nodeId ?? null,
    virtualNodeId: null,
  })));

  if (anchors.length < 2) {
    return {
      anchors,
      pairs: [],
      virtualNodes: [],
      virtualEdges: [],
      activePairId: null,
      queryTrailPath: null,
      activeConnectedPath: null,
      status: "pending",
      summary: "Waiting for at least two anchors to evaluate multihop connectivity.",
    };
  }

  const virtualNodes: GraphNode[] = [];
  for (const anchor of anchors) {
    if (anchor.nodeId) continue;
    const virtualNodeId = `virtual-anchor:${slug(anchor.label)}`;
    anchor.virtualNodeId = virtualNodeId;
    virtualNodes.push({
      id: virtualNodeId,
      type: labelForAnchorType(anchor),
      primaryId: virtualNodeId,
      label: anchor.label,
      score: 0.18,
      size: anchor.entityType === "target" ? 28 : 34,
      meta: {
        virtual: true,
        queryAnchor: true,
        displayName: anchor.label,
        note: "Anchor from query not yet resolved to graph entity.",
      },
    });
  }

  const virtualEdges: GraphEdge[] = [];
  const pairs: BridgePairOutcome[] = [];

  for (let index = 0; index < anchors.length - 1; index += 1) {
    const from = anchors[index]!;
    const to = anchors[index + 1]!;
    const pairId = `pair:${index}`;

    const fromNode = from.nodeId ?? from.virtualNodeId;
    const toNode = to.nodeId ?? to.virtualNodeId;
    const fromResolved = Boolean(from.nodeId);
    const toResolved = Boolean(to.nodeId);

    if (!fromNode || !toNode) {
      pairs.push({
        pairId,
        fromAnchorId: from.id,
        toAnchorId: to.id,
        status: "no_connection",
        reason: "Anchors not yet resolved to graph nodes.",
        nodeIds: [fromNode, toNode].filter((id): id is string => Boolean(id)),
        edgeIds: [],
      });
      continue;
    }

    if (fromResolved && toResolved) {
      const found =
        shortestPath(fromNode, toNode, adjacencyNoDiseaseShortcuts) ??
        shortestPath(fromNode, toNode, adjacency);
      if (found) {
        pairs.push({
          pairId,
          fromAnchorId: from.id,
          toAnchorId: to.id,
          status: "connected",
          reason: `Connected via ${Math.max(0, found.nodeIds.length - 2)} intermediate hops.`,
          nodeIds: found.nodeIds,
          edgeIds: found.edgeIds,
        });
        continue;
      }
    }

    const gapEdgeId = `gap:${slug(from.label)}:${slug(to.label)}`;
    virtualEdges.push({
      id: gapEdgeId,
      source: fromNode,
      target: toNode,
      type: "disease_disease",
      weight: 0.08,
      meta: {
        source: "query_gap",
        status: "no_connection",
        note:
          fromResolved && toResolved
            ? "No mechanistic path found between these anchors in the current graph."
            : "At least one anchor is still unresolved in this run.",
      },
    });
    pairs.push({
      pairId,
      fromAnchorId: from.id,
      toAnchorId: to.id,
      status: "no_connection",
      reason:
        fromResolved && toResolved
          ? "No connected path found in the current multihop graph."
          : "One or both anchors unresolved; keeping an explicit unresolved connection.",
      nodeIds: [fromNode, toNode],
      edgeIds: [gapEdgeId],
      gapEdgeId,
    });
  }

  const connectedPairs = pairs.filter((pair) => pair.status === "connected");
  const bestConnectedPair =
    [...connectedPairs].sort((a, b) => {
      const aIntermediate = Math.max(0, a.nodeIds.length - 2);
      const bIntermediate = Math.max(0, b.nodeIds.length - 2);
      if (aIntermediate !== bIntermediate) return bIntermediate - aIntermediate;
      if (a.edgeIds.length !== b.edgeIds.length) return b.edgeIds.length - a.edgeIds.length;
      return a.pairId.localeCompare(b.pairId);
    })[0] ?? null;
  const activePair = bestConnectedPair ?? pairs[0] ?? null;
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const activeConnectedPath = bestConnectedPair
    ? {
        nodeIds: bestConnectedPair.nodeIds,
        edgeIds: bestConnectedPair.edgeIds,
        summary: `${
          anchorById.get(bestConnectedPair.fromAnchorId)?.label ?? "anchor"
        } -> ${bestConnectedPair.nodeIds.length - 2} hop(s) -> ${
          anchorById.get(bestConnectedPair.toAnchorId)?.label ?? "anchor"
        }`,
      }
    : null;
  const queryTrailPath = buildQueryTrailPath(anchors, pairs);

  let status: BridgeAnalysis["status"] = "pending";
  if (pairs.length > 0) {
    status = connectedPairs.length > 0 ? "connected" : "no_connection";
  }

  const summary =
    status === "connected"
      ? connectedPairs.length === pairs.length
        ? `${connectedPairs.length}/${pairs.length} anchor pair(s) connected by an explicit multihop path.`
        : `${connectedPairs.length}/${pairs.length} anchor pair(s) connected; remaining pairs are unresolved.`
      : status === "no_connection"
        ? "No full anchor-to-anchor path found yet; unresolved anchor pairs remain visible."
        : "Anchor connectivity pending.";

  return {
    anchors,
    pairs,
    virtualNodes,
    virtualEdges,
    activePairId: activePair?.pairId ?? null,
    activeConnectedPath,
    queryTrailPath,
    status,
    summary,
  };
}
