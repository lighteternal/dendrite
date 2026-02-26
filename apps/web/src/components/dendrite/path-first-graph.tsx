"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { GraphCanvas } from "@/components/dendrite/graph-canvas";
import { analyzeBridgeOutcomes, type BridgeAnalysis } from "@/components/dendrite/bridge-analysis";
import {
  EDGE_SOURCE_GROUP_META,
  EDGE_SOURCE_GROUPS,
  getEdgeSourceGroup,
  type EdgeSourceGroup,
} from "@/components/dendrite/graph-source";
import type { QueryPlan } from "@/hooks/useCaseRunStream";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type PathUpdate = {
  nodeIds: string[];
  edgeIds: string[];
  summary: string;
  pathState?: "active" | "candidate" | "discarded";
};

type Props = {
  query: string;
  queryPlan?: QueryPlan | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  pathUpdate: PathUpdate | null;
  washedPathUpdates?: PathUpdate[];
  candidatePathUpdates?: PathUpdate[];
  showPathwayContext: boolean;
  showDrugContext: boolean;
  showInteractionContext: boolean;
  isRunning?: boolean;
  onSelectNode?: (nodeId: string | null) => void;
  selectedEdgeId?: string | null;
  onSelectEdge?: (edgeId: string | null) => void;
  onBridgeAnalysisChange?: (analysis: BridgeAnalysis) => void;
  onResetView?: () => void;
};

type SourceCountMap = Record<EdgeSourceGroup, number>;

function emptySourceCountMap(): SourceCountMap {
  return EDGE_SOURCE_GROUPS.reduce(
    (acc, group) => {
      acc[group] = 0;
      return acc;
    },
    {} as SourceCountMap,
  );
}

const AGENT_DERIVED_SOURCE_HINTS = [
  "agent",
  "planner",
  "query_bridge",
  "agent_discovery",
  "derived",
  "virtual",
] as const;

const CURATED_SOURCE_HINTS = [
  "opentargets",
  "reactome",
  "chembl",
  "string",
  "pubmed",
  "biomcp",
  "medical",
] as const;

function normalizeConceptKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nodeSourceHints(node: GraphNode): string[] {
  const values = [
    node.meta.source,
    node.meta.sourceName,
    node.meta.provider,
    node.meta.sourceTag,
  ];
  return values
    .flatMap((value) =>
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [],
    )
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function isAgentDerivedNode(node: GraphNode): boolean {
  if (node.meta.virtual === true) return true;
  const hints = nodeSourceHints(node);
  if (
    hints.some((hint) =>
      AGENT_DERIVED_SOURCE_HINTS.some((candidate) => hint.includes(candidate)),
    )
  ) {
    return true;
  }
  if (
    hints.some((hint) =>
      CURATED_SOURCE_HINTS.some((candidate) => hint.includes(candidate)),
    )
  ) {
    return false;
  }
  return node.type === "interaction";
}

function isSyntheticPrimaryId(value: string): boolean {
  const normalized = normalizeConceptKey(value);
  if (!normalized) return true;
  if (/^(unknown|n a|na)$/.test(normalized)) return true;
  if (/^(virtual|query|seed|evid|tmp|placeholder|node)\b/.test(normalized)) return true;
  return false;
}

function nodeIdentityTokens(node: GraphNode): Set<string> {
  const tokens = new Set<string>();
  const primary = String(node.primaryId ?? "").trim();
  if (primary && !isSyntheticPrimaryId(primary)) {
    tokens.add(`primary:${normalizeConceptKey(primary)}`);
  }
  const targetSymbol = String(node.meta.targetSymbol ?? "").trim();
  if (targetSymbol) {
    tokens.add(`symbol:${normalizeConceptKey(targetSymbol)}`);
  }
  const externalId = String(node.meta.id ?? "").trim();
  if (externalId && !isSyntheticPrimaryId(externalId)) {
    tokens.add(`external:${normalizeConceptKey(externalId)}`);
  }
  return tokens;
}

function nodeDisplayKey(node: GraphNode): string {
  const preferred =
    (typeof node.meta.displayName === "string" ? node.meta.displayName : "") ||
    (typeof node.meta.targetName === "string" ? node.meta.targetName : "") ||
    node.label;
  return normalizeConceptKey(preferred);
}

function hasTokenIntersection(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 || right.size === 0) return false;
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

function hasNeighborOverlap(
  leftNodeId: string,
  rightNodeId: string,
  adjacency: Map<string, Set<string>>,
): boolean {
  const leftNeighbors = adjacency.get(leftNodeId);
  const rightNeighbors = adjacency.get(rightNodeId);
  if (!leftNeighbors || !rightNeighbors) return false;
  for (const nodeId of leftNeighbors) {
    if (rightNeighbors.has(nodeId)) return true;
  }
  return false;
}

function nodeRank(node: GraphNode): number {
  let rank = 0;
  if (!isAgentDerivedNode(node)) rank += 6;
  if (node.meta.virtual !== true) rank += 2;
  if (node.type !== "interaction") rank += 1;
  if (!isSyntheticPrimaryId(String(node.primaryId ?? ""))) rank += 1;
  rank += (node.score ?? 0) * 2;
  return rank;
}

function collapseEquivalentConceptNodes(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const { nodes, edges } = input;
  if (nodes.length === 0) return { nodes, edges };

  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const aliasByNodeId = new Map<string, string>();
  const provisionalNodes = nodes
    .filter((node) => isAgentDerivedNode(node))
    .sort((left, right) => Number(right.meta.virtual === true) - Number(left.meta.virtual === true));

  for (const provisional of provisionalNodes) {
    if (aliasByNodeId.has(provisional.id)) continue;
    const provisionalTokens = nodeIdentityTokens(provisional);
    const provisionalLabel = nodeDisplayKey(provisional);
    const isFlexibleType = provisional.type === "interaction" || provisional.meta.virtual === true;

    let bestCandidate: GraphNode | null = null;
    let bestScore = -1;

    for (const candidate of nodes) {
      if (candidate.id === provisional.id) continue;
      if (isAgentDerivedNode(candidate)) continue;
      if (!isFlexibleType && candidate.type !== provisional.type) continue;
      if (isFlexibleType && candidate.type === "interaction") continue;

      const candidateTokens = nodeIdentityTokens(candidate);
      const tokenOverlap = hasTokenIntersection(provisionalTokens, candidateTokens);
      const labelOverlap =
        provisionalLabel.length >= 3 && provisionalLabel === nodeDisplayKey(candidate);
      const neighborOverlap = hasNeighborOverlap(provisional.id, candidate.id, adjacency);

      // Never merge based on label alone; require either identifier overlap,
      // or matching labels plus shared graph neighborhood context.
      if (!tokenOverlap && !(labelOverlap && neighborOverlap)) continue;

      const score =
        (tokenOverlap ? 5 : 0) +
        (labelOverlap ? 1 : 0) +
        (neighborOverlap ? 2 : 0) +
        (candidate.type !== "interaction" ? 1 : 0) +
        (candidate.meta.virtual !== true ? 1 : 0);

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) {
      aliasByNodeId.set(provisional.id, bestCandidate.id);
    }
  }

  if (aliasByNodeId.size === 0) {
    return { nodes, edges };
  }

  const resolveAlias = (nodeId: string): string => {
    let current = nodeId;
    const visited = new Set<string>();
    while (aliasByNodeId.has(current) && !visited.has(current)) {
      visited.add(current);
      current = aliasByNodeId.get(current)!;
    }
    return current;
  };

  const groupedByCanonicalId = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const canonicalId = resolveAlias(node.id);
    if (!groupedByCanonicalId.has(canonicalId)) {
      groupedByCanonicalId.set(canonicalId, []);
    }
    groupedByCanonicalId.get(canonicalId)?.push(node);
  }

  const mergedNodes: GraphNode[] = [];
  for (const [canonicalId, grouped] of groupedByCanonicalId.entries()) {
    const winner =
      [...grouped].sort((left, right) => nodeRank(right) - nodeRank(left))[0] ?? grouped[0];
    if (!winner) continue;

    const mergedMeta = grouped.reduce<Record<string, unknown>>(
      (acc, node) => ({ ...acc, ...node.meta }),
      {},
    );
    const mergedAliasIds = grouped
      .map((node) => node.id)
      .filter((id) => id !== canonicalId);
    if (mergedAliasIds.length > 0) {
      mergedMeta.mergedConceptAliases = mergedAliasIds.slice(0, 12);
      mergedMeta.dedupMerged = true;
    }

    const hasScoredNode = grouped.some((node) => typeof node.score === "number");
    const hasSizedNode = grouped.some((node) => typeof node.size === "number");
    const mergedScore = hasScoredNode
      ? Math.max(...grouped.map((node) => node.score ?? 0))
      : winner.score;
    const mergedSize = hasSizedNode
      ? Math.max(...grouped.map((node) => node.size ?? 0))
      : winner.size;

    mergedNodes.push({
      ...winner,
      id: canonicalId,
      score: mergedScore,
      size: mergedSize,
      meta: {
        ...mergedMeta,
        ...winner.meta,
      },
    });
  }

  const remappedEdges = edges
    .map((edge) => {
      const source = resolveAlias(edge.source);
      const target = resolveAlias(edge.target);
      if (source === target) return null;
      if (source === edge.source && target === edge.target) return edge;
      return {
        ...edge,
        source,
        target,
        meta: {
          ...edge.meta,
          dedupRemapped: true,
        },
      } satisfies GraphEdge;
    })
    .filter((edge): edge is GraphEdge => Boolean(edge));

  return {
    nodes: mergedNodes,
    edges: remappedEdges,
  };
}

export function PathFirstGraph({
  query,
  queryPlan = null,
  nodes,
  edges,
  pathUpdate,
  washedPathUpdates = [],
  candidatePathUpdates = [],
  showPathwayContext,
  showDrugContext,
  showInteractionContext,
  isRunning = false,
  onSelectNode,
  selectedEdgeId,
  onSelectEdge,
  onBridgeAnalysisChange,
  onResetView,
}: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<Record<EdgeSourceGroup, boolean>>(() =>
    EDGE_SOURCE_GROUPS.reduce(
      (acc, group) => {
        acc[group] = true;
        return acc;
      },
      {} as Record<EdgeSourceGroup, boolean>,
    ),
  );

  const toggleSourceGroup = useCallback((group: EdgeSourceGroup) => {
    setSourceFilter((current) => ({
      ...current,
      [group]: !current[group],
    }));
  }, []);

  const unhideAllSourceGroups = useCallback((expand = false) => {
    setSourceFilter(
      EDGE_SOURCE_GROUPS.reduce(
        (acc, group) => {
          acc[group] = true;
          return acc;
        },
        {} as Record<EdgeSourceGroup, boolean>,
      ),
    );
    if (expand) setShowAllEdges(true);
  }, []);

  const resetGraphView = useCallback(() => {
    unhideAllSourceGroups(false);
    setShowAllEdges(false);
    onResetView?.();
  }, [onResetView, unhideAllSourceGroups]);

  const allSourceGroupsEnabled = useMemo(
    () => EDGE_SOURCE_GROUPS.every((group) => sourceFilter[group]),
    [sourceFilter],
  );

  const dedupedGraph = useMemo(
    () =>
      collapseEquivalentConceptNodes({
        nodes,
        edges,
      }),
    [edges, nodes],
  );

  const bridgeAnalysis = useMemo(
    () =>
      analyzeBridgeOutcomes({
        query,
        queryPlan,
        nodes: dedupedGraph.nodes,
        edges: dedupedGraph.edges,
      }),
    [dedupedGraph.edges, dedupedGraph.nodes, query, queryPlan],
  );

  useEffect(() => {
    onBridgeAnalysisChange?.(bridgeAnalysis);
  }, [bridgeAnalysis, onBridgeAnalysisChange]);

  const computed = useMemo(() => {
    const isQueryProxyEdge = (edge: GraphEdge | undefined) => {
      if (!edge) return false;
      if (edge.type !== "disease_disease") return false;
      const source = String(edge.meta.source ?? "").toLowerCase();
      return source === "query_anchor" || source === "query_gap";
    };

    const allNodes = [...dedupedGraph.nodes];
    for (const virtualNode of bridgeAnalysis.virtualNodes) {
      if (!allNodes.some((node) => node.id === virtualNode.id)) {
        allNodes.push(virtualNode);
      }
    }

    const connectedAnchorEdgeIds = new Set<string>();
    for (const pair of bridgeAnalysis.pairs) {
      if (pair.status !== "connected") continue;
      for (const edgeId of pair.edgeIds) connectedAnchorEdgeIds.add(edgeId);
    }
    for (const edgeId of bridgeAnalysis.activeConnectedPath?.edgeIds ?? []) {
      connectedAnchorEdgeIds.add(edgeId);
    }

    const allEdges = dedupedGraph.edges.map((edge) =>
      connectedAnchorEdgeIds.has(edge.id)
        ? {
            ...edge,
            meta: {
              ...edge.meta,
              status:
                String(edge.meta.status ?? "").toLowerCase() === "no_connection"
                  ? "connected"
                  : edge.meta.status ?? "connected",
              anchorPathConnected: true,
            },
          }
        : edge,
    );
    for (const virtualEdge of bridgeAnalysis.virtualEdges) {
      if (!allEdges.some((edge) => edge.id === virtualEdge.id)) {
        allEdges.push(virtualEdge);
      }
    }

    const nodeById = new Map(allNodes.map((node) => [node.id, node]));
    const edgeById = new Map(allEdges.map((edge) => [edge.id, edge]));
    const edgeSourceById = new Map<string, EdgeSourceGroup>();
    const totalEdgeCountsBySource = emptySourceCountMap();
    for (const edge of allEdges) {
      const sourceGroup = getEdgeSourceGroup(edge);
      edgeSourceById.set(edge.id, sourceGroup);
      totalEdgeCountsBySource[sourceGroup] += 1;
    }
    const pathFocusNodeIds = new Set(pathUpdate?.nodeIds ?? []);
    const pathFocusEdgeIds = new Set(pathUpdate?.edgeIds ?? []);
    const candidateNodeIds = new Set<string>();
    const candidateEdgeIds = new Set<string>();
    for (const candidate of candidatePathUpdates) {
      for (const nodeId of candidate.nodeIds) candidateNodeIds.add(nodeId);
      for (const edgeId of candidate.edgeIds) candidateEdgeIds.add(edgeId);
    }
    const hasPathUpdateEdges = (pathUpdate?.edgeIds?.length ?? 0) > 0;
    const pathUpdateUsesOnlyProxyEdges =
      hasPathUpdateEdges &&
      (pathUpdate?.edgeIds ?? []).every((edgeId) => isQueryProxyEdge(edgeById.get(edgeId)));

    if ((!hasPathUpdateEdges || pathUpdateUsesOnlyProxyEdges) && bridgeAnalysis.queryTrailPath) {
      for (const nodeId of bridgeAnalysis.queryTrailPath.nodeIds) {
        pathFocusNodeIds.add(nodeId);
      }
      for (const edgeId of bridgeAnalysis.queryTrailPath.edgeIds) {
        pathFocusEdgeIds.add(edgeId);
      }
    }
    if (
      (!hasPathUpdateEdges || pathUpdateUsesOnlyProxyEdges || bridgeAnalysis.status === "connected") &&
      bridgeAnalysis.activeConnectedPath
    ) {
      for (const nodeId of bridgeAnalysis.activeConnectedPath.nodeIds) {
        pathFocusNodeIds.add(nodeId);
      }
      for (const edgeId of bridgeAnalysis.activeConnectedPath.edgeIds) {
        pathFocusEdgeIds.add(edgeId);
      }
    }
    const activePair = bridgeAnalysis.pairs.find((pair) => pair.pairId === bridgeAnalysis.activePairId);
    if (activePair && activePair.status === "no_connection") {
      for (const nodeId of activePair.nodeIds) {
        pathFocusNodeIds.add(nodeId);
      }
      for (const edgeId of activePair.edgeIds) {
        pathFocusEdgeIds.add(edgeId);
      }
    }

    const focusedEdges = [...pathFocusEdgeIds]
      .map((edgeId) => allEdges.find((edge) => edge.id === edgeId))
      .filter((edge): edge is GraphEdge => Boolean(edge));
    const hasMechanisticFocusedEdge = focusedEdges.some((edge) => !isQueryProxyEdge(edge));
    if (hasMechanisticFocusedEdge) {
      for (const edge of focusedEdges) {
        if (!isQueryProxyEdge(edge)) continue;
        pathFocusEdgeIds.delete(edge.id);
      }
      const connectedFocusedNodes = new Set<string>();
      for (const edgeId of pathFocusEdgeIds) {
        const edge = allEdges.find((item) => item.id === edgeId);
        if (!edge) continue;
        connectedFocusedNodes.add(edge.source);
        connectedFocusedNodes.add(edge.target);
      }
      for (const nodeId of [...pathFocusNodeIds]) {
        if (!connectedFocusedNodes.has(nodeId) && nodeById.get(nodeId)?.type !== "disease") {
          pathFocusNodeIds.delete(nodeId);
        }
      }
    }

    const washedNodeIds = new Set<string>();
    const washedEdgeIds = new Set<string>();
    for (const washed of washedPathUpdates) {
      for (const nodeId of washed.nodeIds) {
        if (!pathFocusNodeIds.has(nodeId) && !candidateNodeIds.has(nodeId)) {
          washedNodeIds.add(nodeId);
        }
      }
      for (const edgeId of washed.edgeIds) {
        if (!pathFocusEdgeIds.has(edgeId) && !candidateEdgeIds.has(edgeId)) {
          washedEdgeIds.add(edgeId);
        }
      }
    }
    const focusNodeIds = new Set(pathFocusNodeIds);
    const focusEdgeIds = new Set(pathFocusEdgeIds);

    const diseaseNode =
      allNodes.find((node) => node.type === "disease" && !Boolean(node.meta.virtual)) ??
      allNodes.find((node) => node.type === "disease");
    if (diseaseNode) {
      focusNodeIds.add(diseaseNode.id);
    }

    const diseaseTargetEdges = allEdges
      .filter((edge) => edge.type === "disease_target")
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const diseaseBridgeEdges = allEdges.filter(
      (edge) =>
        edge.type === "disease_disease" &&
        String(edge.meta.status ?? "candidate").toLowerCase() !== "connected" &&
        String(edge.meta.source ?? "").toLowerCase() !== "query_anchor",
    );

    const primaryTargetIds = new Set<string>();
    for (const edge of diseaseTargetEdges) {
      if (focusEdgeIds.has(edge.id)) {
        primaryTargetIds.add(edge.target);
      }
    }

    if (primaryTargetIds.size === 0) {
      for (const edge of diseaseTargetEdges.slice(0, 6)) {
        primaryTargetIds.add(edge.target);
        focusEdgeIds.add(edge.id);
        focusNodeIds.add(edge.target);
      }
    }

    // Always keep top-ranked disease->target branches visible so the canvas is not a tiny
    // single-thread stub while still preserving readability.
    for (const edge of diseaseTargetEdges.slice(0, 4)) {
      primaryTargetIds.add(edge.target);
      focusEdgeIds.add(edge.id);
      focusNodeIds.add(edge.source);
      focusNodeIds.add(edge.target);
    }

    for (const nodeId of focusNodeIds) {
      const node = nodeById.get(nodeId);
      if (node?.type === "target") {
        primaryTargetIds.add(nodeId);
      }
    }

    const sourceFilterEnabled =
      EDGE_SOURCE_GROUPS.some((group) => !sourceFilter[group]);
    const isSourceEnabled = (edge: GraphEdge) => sourceFilter[getEdgeSourceGroup(edge)];

    const selectedEdgeIds = new Set<string>(focusEdgeIds);
    for (const edgeId of candidateEdgeIds) {
      selectedEdgeIds.add(edgeId);
      const edge = edgeById.get(edgeId);
      if (!edge) continue;
      focusNodeIds.add(edge.source);
      focusNodeIds.add(edge.target);
    }
    for (const nodeId of candidateNodeIds) {
      focusNodeIds.add(nodeId);
    }
    const addTopEdgesForTarget = (targetId: string, type: GraphEdge["type"], limit: number) => {
      const top = allEdges
        .filter((edge) =>
          type === "target_target"
            ? edge.type === type && (edge.source === targetId || edge.target === targetId)
            : edge.type === type && edge.source === targetId,
        )
        .filter((edge) => !sourceFilterEnabled || isSourceEnabled(edge))
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
        .slice(0, limit);

      for (const edge of top) {
        selectedEdgeIds.add(edge.id);
        focusNodeIds.add(edge.source);
        focusNodeIds.add(edge.target);
      }
    };

    const dominantTargetIds = [...primaryTargetIds].slice(0, showInteractionContext ? 6 : 4);

    for (const targetId of dominantTargetIds) {
      if (showPathwayContext) {
        addTopEdgesForTarget(targetId, "target_pathway", 2);
      }
      if (showDrugContext) {
        addTopEdgesForTarget(targetId, "target_drug", 2);
      }
      if (showInteractionContext) {
        addTopEdgesForTarget(targetId, "target_target", 2);
      }
    }

    for (const edge of diseaseTargetEdges.slice(0, showInteractionContext ? 10 : 8)) {
      if (sourceFilterEnabled && !isSourceEnabled(edge) && !focusEdgeIds.has(edge.id)) continue;
      if (primaryTargetIds.has(edge.target)) {
        selectedEdgeIds.add(edge.id);
        focusNodeIds.add(edge.source);
        focusNodeIds.add(edge.target);
      }
    }

    for (const edge of diseaseBridgeEdges) {
      if (sourceFilterEnabled && !isSourceEnabled(edge) && !focusEdgeIds.has(edge.id)) continue;
      selectedEdgeIds.add(edge.id);
      focusNodeIds.add(edge.source);
      focusNodeIds.add(edge.target);
    }

    // Keep graph readable by adding only edges that stay anchored to the disease/lead-target neighborhood.
    const minVisibleEdges = showInteractionContext ? 38 : 24;
    if (selectedEdgeIds.size < minVisibleEdges) {
      const anchorNodeIds = new Set<string>([
        ...(diseaseNode ? [diseaseNode.id] : []),
        ...primaryTargetIds,
      ]);
      for (const edge of [...allEdges].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
        if (selectedEdgeIds.has(edge.id)) continue;
        if (
          edge.type === "disease_disease" &&
          String(edge.meta.source ?? "").toLowerCase() === "query_anchor"
        ) {
          continue;
        }
        if (!showInteractionContext && edge.type === "target_target") continue;
        if (!showPathwayContext && edge.type === "target_pathway") continue;
        if (!showDrugContext && edge.type === "target_drug") continue;
        const anchored =
          anchorNodeIds.has(edge.source) ||
          anchorNodeIds.has(edge.target) ||
          focusNodeIds.has(edge.source) ||
          focusNodeIds.has(edge.target);
        if (!anchored) continue;
        if (sourceFilterEnabled && !isSourceEnabled(edge) && !focusEdgeIds.has(edge.id)) continue;
        selectedEdgeIds.add(edge.id);
        focusNodeIds.add(edge.source);
        focusNodeIds.add(edge.target);
        if (selectedEdgeIds.size >= minVisibleEdges) break;
      }
    }

    const priority = (edge: GraphEdge) => {
      if (focusEdgeIds.has(edge.id)) return 6;
      if (edge.type === "disease_target") return 5;
      if (edge.type === "disease_disease") return 5;
      if (edge.type === "target_pathway") return 4;
      if (edge.type === "target_drug") return 3;
      if (edge.type === "target_target") return 2;
      return 1;
    };

    const prioritizedSelectedEdges = allEdges
      .filter((edge) => selectedEdgeIds.has(edge.id))
      .sort((a, b) => {
        const p = priority(b) - priority(a);
        if (p !== 0) return p;
        return (b.weight ?? 0) - (a.weight ?? 0);
      });

    const contextEligibleEdges = allEdges.filter((edge) => {
      if (!showInteractionContext && edge.type === "target_target") return false;
      if (!showPathwayContext && edge.type === "target_pathway") return false;
      if (!showDrugContext && edge.type === "target_drug") return false;
      return true;
    });
    const sourceEligibleEdges = contextEligibleEdges.filter(
      (edge) => !sourceFilterEnabled || isSourceEnabled(edge) || focusEdgeIds.has(edge.id),
    );

    const maxEdges = showAllEdges
      ? Math.min(2000, Math.max(320, sourceEligibleEdges.length))
      : (showInteractionContext ? 180 : 140);

    const selectedEdgeMap = new Map<string, GraphEdge>();
    if (showAllEdges) {
      for (const edge of sourceEligibleEdges
        .slice()
        .sort((a, b) => {
          const p = priority(b) - priority(a);
          if (p !== 0) return p;
          return (b.weight ?? 0) - (a.weight ?? 0);
        })
        .slice(0, maxEdges)) {
        selectedEdgeMap.set(edge.id, edge);
      }
    } else {
      for (const edge of prioritizedSelectedEdges.slice(0, maxEdges)) {
        selectedEdgeMap.set(edge.id, edge);
      }
      for (const edge of prioritizedSelectedEdges) {
        if (!focusEdgeIds.has(edge.id)) continue;
        selectedEdgeMap.set(edge.id, edge);
      }
    }
    const selectedEdges = [...selectedEdgeMap.values()];
    const densityHiddenEdges = Math.max(0, sourceEligibleEdges.length - selectedEdges.length);
    const laneTotalsBySource = emptySourceCountMap();
    for (const edge of selectedEdges) {
      const sourceGroup = edgeSourceById.get(edge.id) ?? "other";
      laneTotalsBySource[sourceGroup] += 1;
    }

    const visibleCountsBySource = emptySourceCountMap();
    const visibleEdges = selectedEdges.filter((edge) => {
      const sourceGroup = edgeSourceById.get(edge.id) ?? "other";
      const keep = sourceFilter[sourceGroup] || focusEdgeIds.has(edge.id);
      if (keep) {
        visibleCountsBySource[sourceGroup] += 1;
      }
      return keep;
    });

    for (const edge of visibleEdges) {
      focusNodeIds.add(edge.source);
      focusNodeIds.add(edge.target);
    }

    const forcedNodeIds = new Set<string>();
    if (diseaseNode) forcedNodeIds.add(diseaseNode.id);
    for (const anchor of bridgeAnalysis.anchors) {
      if (anchor.nodeId) forcedNodeIds.add(anchor.nodeId);
      if (anchor.virtualNodeId) forcedNodeIds.add(anchor.virtualNodeId);
    }
    for (const nodeId of pathFocusNodeIds) {
      forcedNodeIds.add(nodeId);
    }
    for (const nodeId of focusNodeIds) {
      const node = nodeById.get(nodeId);
      if (node?.type === "disease") forcedNodeIds.add(nodeId);
    }

    const visibleNodeIds = new Set<string>(forcedNodeIds);
    for (const edge of visibleEdges) {
      visibleNodeIds.add(edge.source);
      visibleNodeIds.add(edge.target);
    }
    const visibleNodes = allNodes.filter((node) => visibleNodeIds.has(node.id));
    const layoutRootIds = bridgeAnalysis.anchors
      .map((anchor) => anchor.nodeId ?? anchor.virtualNodeId)
      .filter((id): id is string => Boolean(id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, 4);

    const hiddenEdges = Math.max(0, sourceEligibleEdges.length - visibleEdges.length);
    const hiddenNodes = Math.max(0, allNodes.length - visibleNodes.length);
    const bridgeStatuses = diseaseBridgeEdges
      .map((edge) => String(edge.meta.status ?? "candidate"))
      .slice(0, 2);
    const summaryPrefix =
      pathUpdate?.summary ??
      bridgeAnalysis.queryTrailPath?.summary ??
      (showAllEdges
        ? `Showing expanded ${showInteractionContext ? "mechanistic" : "translational"} context across ${primaryTargetIds.size} lead targets`
        : `Showing predominant ${showInteractionContext ? "mechanistic" : "translational"} connections across ${primaryTargetIds.size} lead targets`);
    const bridgeSuffix =
      bridgeStatuses.length > 0
        ? ` Anchor connectivity: ${bridgeStatuses.join(", ")}.`
        : "";
    const filteredOutEdges = Math.max(0, selectedEdges.length - visibleEdges.length);
    const summaryCore = densityHiddenEdges > 0
      ? `${summaryPrefix}. +${densityHiddenEdges} additional edges hidden for readability.${bridgeSuffix}`
      : `${summaryPrefix}${bridgeSuffix}`;
    const sourceFilterSuffix =
      filteredOutEdges > 0
        ? ` ${filteredOutEdges} edges muted by source filter.`
        : "";
    const summary = `${summaryCore}${sourceFilterSuffix} ${bridgeAnalysis.summary}`.trim();
    const anchorById = new Map(bridgeAnalysis.anchors.map((anchor) => [anchor.id, anchor]));
    const activeTrailEdgeIds =
      hasPathUpdateEdges && !pathUpdateUsesOnlyProxyEdges
        ? (pathUpdate?.edgeIds ?? [])
        : [...pathFocusEdgeIds];
    const activeTrail = activeTrailEdgeIds
      .slice(0, 6)
      .map((edgeId) => visibleEdges.find((edge) => edge.id === edgeId))
      .filter((edge): edge is GraphEdge => Boolean(edge))
      .map((edge) => {
        const sourceLabel = nodeById.get(edge.source)?.label ?? edge.source;
        const targetLabel = nodeById.get(edge.target)?.label ?? edge.target;
        const sourceTag =
          typeof edge.meta.source === "string" && edge.meta.source.trim().length > 0
            ? ` (${edge.meta.source})`
            : "";
        return `${sourceLabel} -> ${targetLabel}${sourceTag}`;
      });
    const bridgePairSummaries = bridgeAnalysis.pairs.slice(0, 4).map((pair) => {
      const fromLabel = anchorById.get(pair.fromAnchorId)?.label ?? "anchor";
      const toLabel = anchorById.get(pair.toAnchorId)?.label ?? "anchor";
      return {
        id: pair.pairId,
        fromLabel,
        toLabel,
        status: pair.status,
        reason: pair.reason,
      };
    });

    return {
      visibleNodes,
      visibleEdges,
      hiddenEdges,
      hiddenNodes,
      sourceCounts: {
        total: laneTotalsBySource,
        global: totalEdgeCountsBySource,
        visible: visibleCountsBySource,
      },
      sourceFilterMuted: filteredOutEdges,
      densityHiddenEdges,
      highlightedNodeIds: pathFocusNodeIds,
      highlightedEdgeIds: pathFocusEdgeIds,
      shortlistedNodeIds: candidateNodeIds,
      shortlistedEdgeIds: candidateEdgeIds,
      washedNodeIds,
      washedEdgeIds,
      summary,
      activeTrail,
      bridgeStatus: bridgeAnalysis.status,
      bridgePairCount: bridgeAnalysis.pairs.length,
      bridgePairSummaries,
      layoutRootIds,
    };
  }, [
    bridgeAnalysis,
    dedupedGraph.edges,
    dedupedGraph.nodes,
    pathUpdate?.edgeIds,
    pathUpdate?.nodeIds,
    pathUpdate?.summary,
    candidatePathUpdates,
    washedPathUpdates,
    showDrugContext,
    showInteractionContext,
    showPathwayContext,
    showAllEdges,
    sourceFilter,
  ]);

  return (
    <div className="space-y-2.5">
      <Collapsible open={showControls} onOpenChange={setShowControls} className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#e1e6f5] bg-[#f8f9ff] px-3 py-2 text-xs text-[#4b4f80]">
        <div className="font-medium text-[#373c78]">
          {computed.summary}
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-[#eef2ff] text-[#3744a0]">
            Nodes {computed.visibleNodes.length}
          </Badge>
          <Badge className="bg-[#eefaf7] text-[#0f766e]">
            Edges {computed.visibleEdges.length}
          </Badge>
          {computed.densityHiddenEdges > 0 ? (
            <Badge className="bg-[#f3f5ff] text-[#4b4ea1]">
              +{computed.densityHiddenEdges} hidden
            </Badge>
          ) : null}
          <Badge
            className={
              computed.bridgeStatus === "connected"
                  ? "bg-[#eaf6f0] text-[#1f7a4f]"
                : computed.bridgeStatus === "partial"
                  ? "bg-[#fff3e6] text-[#9a5a0f]"
                : computed.bridgeStatus === "no_connection"
                    ? "bg-[#f3f0ff] text-[#6a43be]"
                    : "bg-[#eef1f7] text-[#57607b]"
            }
          >
            {computed.bridgeStatus === "connected"
              ? "Bridge connected"
              : computed.bridgeStatus === "partial"
                ? "Bridge partial"
              : computed.bridgeStatus === "no_connection"
                ? "Bridge gap"
                : "Bridge pending"}{" "}
            {computed.bridgePairCount > 0 ? `(${computed.bridgePairCount})` : ""}
          </Badge>
          {computed.sourceFilterMuted > 0 ? (
            <Badge className="bg-[#eef4ff] text-[#425792]">
              Source-muted edges {computed.sourceFilterMuted}
            </Badge>
          ) : null}
          {computed.densityHiddenEdges > 0 || showAllEdges ? (
            <button
              type="button"
              onClick={() => setShowAllEdges((current) => !current)}
              className="rounded-full border border-[#d7dcf5] bg-white px-2 py-0.5 text-[10px] font-medium text-[#4b4ea1] hover:bg-[#f5f6ff]"
              title={showAllEdges ? "Return to balanced readability view" : "Expand edge density for a fuller graph view"}
            >
              {showAllEdges ? "Balanced view" : "Show all edges"}
            </button>
          ) : null}
          {computed.washedEdgeIds.size > 0 ? (
            <Badge className="bg-[#f1f2fa] text-[#5d5f7b]">
              Rejected trails {computed.washedEdgeIds.size}
            </Badge>
          ) : null}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-[#d7dcf5] bg-white px-2 py-0.5 text-[10px] font-medium text-[#4b4ea1] hover:bg-[#f5f6ff]"
              title={showControls ? "Hide graph controls" : "Show graph controls"}
            >
              {showControls ? "Hide details" : "Show details"}
              <ChevronDown className={`h-3 w-3 transition-transform ${showControls ? "rotate-180" : ""}`} />
            </button>
          </CollapsibleTrigger>
        </div>
      </div>
      <CollapsibleContent className="space-y-2.5">
      {computed.activeTrail.length > 0 ? (
        <div className="rounded-lg border border-[#d7dcf5] bg-white px-3 py-2 text-[11px] text-[#4e5a88]">
          <span className="font-semibold text-[#3f4a8f]">Active trail:</span>{" "}
          {computed.activeTrail.join(" • ")}
        </div>
      ) : null}
      {bridgeAnalysis.anchors.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#e1e6f5] bg-white px-3 py-2 text-[11px] text-[#4e5a88]">
          <span className="font-semibold text-[#3f4a8f]">Query anchors:</span>
          {bridgeAnalysis.anchors.map((anchor) => {
            const mention =
              typeof anchor.mention === "string" ? anchor.mention.trim() : "";
            const hasMentionMismatch =
              mention.length > 0 &&
              mention.toLowerCase() !== anchor.label.trim().toLowerCase();

            return (
              <span
                key={anchor.id}
                className={`rounded-full border px-2 py-0.5 ${
                  anchor.nodeId
                    ? "border-[#c8cff6] bg-[#eef1ff] text-[#3f4a8f]"
                    : "border-[#d9d5eb] bg-[#f5f4fb] text-[#5d5b77]"
                }`}
              >
                <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${anchor.nodeId ? "bg-[#4a46cc]" : "bg-[#8a8ea5]"}`} />
                {anchor.label}
                {!anchor.nodeId ? " (pending)" : ""}
                {hasMentionMismatch ? (
                  <span className="ml-1 text-[10px] text-[#5f6696]">
                    ← query: {mention}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}

          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#e1e6f5] bg-white px-3 py-2 text-[11px] text-[#4e5a88]">
        <span className="font-semibold text-[#3f4a8f]">Evidence lanes:</span>
        <span className="text-[10px] text-[#6b7399]">visible / available in current view</span>
        <span className="text-[10px] text-[#6b7399]">hover for full-graph totals</span>
        {EDGE_SOURCE_GROUPS.map((group) => {
          const total = computed.sourceCounts.total[group] ?? 0;
          if (total === 0) return null;
          const visible = computed.sourceCounts.visible[group] ?? 0;
          const globalTotal = computed.sourceCounts.global[group] ?? total;
          const enabled = sourceFilter[group];
          const meta = EDGE_SOURCE_GROUP_META[group];
          return (
            <button
              key={group}
              type="button"
              onClick={() => toggleSourceGroup(group)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition ${
                enabled
                  ? "border-[#c8cff6] bg-[#eef1ff] text-[#3f4a8f]"
                  : "border-[#d8dded] bg-[#f6f7fb] text-[#7b83a4]"
              }`}
              title={`${meta.label}: ${visible}/${total} shown in current view (${globalTotal} in full graph)`}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: meta.color }}
              />
              {meta.label}
              <span className="rounded-full border border-current/20 px-1 text-[10px]">
                {visible}/{total}
              </span>
            </button>
          );
        })}
        {!allSourceGroupsEnabled || showAllEdges ? (
          <>
            {!allSourceGroupsEnabled ? (
              <button
                type="button"
                onClick={() => unhideAllSourceGroups(true)}
                className="rounded-full border border-[#d7dcf5] bg-[#f5f6ff] px-2 py-0.5 text-[10px] font-medium text-[#4e59a0]"
                title="Unhide all evidence lanes and expand edge density"
              >
                Unhide all
              </button>
            ) : null}
            <button
              type="button"
              onClick={resetGraphView}
              className="rounded-full border border-[#d7dcf5] bg-[#f5f6ff] px-2 py-0.5 text-[10px] font-medium text-[#4e59a0]"
              title="Restore defaults for lanes and edge density"
            >
              Reset view
            </button>
          </>
        ) : null}
      </div>

      {computed.bridgePairSummaries.length > 0 ? (
            <div className="grid gap-1.5 rounded-lg border border-[#e1e6f5] bg-white px-3 py-2 text-[11px] text-[#4e5a88]">
          {computed.bridgePairSummaries.map((pair) => (
            <div
              key={pair.id}
              className={`rounded-md border px-2 py-1 ${
                pair.status === "connected"
                  ? "border-[#cde4d8] bg-[#f3fbf7] text-[#2e6d52]"
                  : "border-[#dfd7f7] bg-[#f8f5ff] text-[#5f4e9b]"
              }`}
            >
              <div className="font-medium">
                {pair.fromLabel} {"->"} {pair.toLabel}
                <span className="ml-1 rounded-full border border-current/20 px-1.5 py-0.5 text-[10px]">
                  {pair.status === "connected" ? "connected" : "gap"}
                </span>
              </div>
              <div className="text-[10px] opacity-85">{pair.reason}</div>
            </div>
          ))}
        </div>
      ) : null}

      {isRunning && computed.visibleEdges.length === 0 ? (
        <div className="rounded-lg border border-[#e1e6f5] bg-[#f7f9ff] px-3 py-2 text-xs text-[#4b5686]">
          Graph stream initialized. Waiting for target and pathway evidence batches.
        </div>
      ) : null}
      {isRunning && computed.visibleEdges.length > 0 ? (
        <div className="rounded-lg border border-[#e1e6f5] bg-[#f7f9ff] px-3 py-2 text-xs text-[#4b5686]">
          Streaming evidence. The graph will keep updating while the final synthesis completes. Try
          Shift-click two nodes for the shortest path or right-click a node to focus its neighborhood.
        </div>
      ) : null}
      {!isRunning && computed.visibleEdges.length === 0 && computed.sourceFilterMuted > 0 ? (
        <div className="rounded-lg border border-[#e1e6f5] bg-[#f7f9ff] px-3 py-2 text-xs text-[#4b5686]">
          No edges are visible with the active source filters. Re-enable one or more evidence lanes.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#4c5a89]">
        <span className="rounded-full border border-[#f4c8cc] bg-[#fff2f4] px-2 py-0.5">Disease</span>
        <span className="rounded-full border border-[#c8cbff] bg-[#eceeff] px-2 py-0.5">Target</span>
        <span className="rounded-full border border-[#bde9de] bg-[#ebfaf7] px-2 py-0.5">Pathway</span>
        <span className="rounded-full border border-[#dcc9ff] bg-[#f5efff] px-2 py-0.5">Drug</span>
        <span className="rounded-full border border-[#d7dced] bg-[#f2f4f9] px-2 py-0.5">Interaction</span>
        <span className="rounded-full border border-[#d4c8ff] bg-[#f3efff] px-2 py-0.5">Cross-anchor link</span>
        <span className="rounded-full border border-[#d7dcf5] bg-white px-2 py-0.5">
          Directed edges: disease -&gt; target -&gt; pathway/drug. Cross-anchor edges indicate connected/unresolved anchor pairs.
        </span>
      </div>
      </CollapsibleContent>
      </Collapsible>

      <GraphCanvas
        nodes={computed.visibleNodes}
        edges={computed.visibleEdges}
        layoutRootIds={computed.layoutRootIds}
        selectedNodeId={selectedNodeId}
        selectedEdgeId={selectedEdgeId}
        onSelectNode={(node) => {
          const nextId = node?.id ?? null;
          setSelectedNodeId(nextId);
          onSelectNode?.(nextId);
        }}
        onSelectEdge={(edge) => {
          onSelectEdge?.(edge?.id ?? null);
        }}
        highlightedNodeIds={computed.highlightedNodeIds}
        highlightedEdgeIds={computed.highlightedEdgeIds}
        shortlistedNodeIds={computed.shortlistedNodeIds}
        shortlistedEdgeIds={computed.shortlistedEdgeIds}
        washedNodeIds={computed.washedNodeIds}
        washedEdgeIds={computed.washedEdgeIds}
        dimUnfocused
        isRunning={isRunning}
        hiddenSummary={{
          hiddenNodes: computed.hiddenNodes,
          hiddenEdges: computed.hiddenEdges,
          lens: "mechanism",
        }}
      />
    </div>
  );
}
