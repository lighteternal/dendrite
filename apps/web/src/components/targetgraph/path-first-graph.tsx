"use client";

import { useEffect, useMemo, useState } from "react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { GraphCanvas } from "@/components/targetgraph/graph-canvas";
import { analyzeBridgeOutcomes, type BridgeAnalysis } from "@/components/targetgraph/bridge-analysis";
import type { QueryPlan } from "@/hooks/useCaseRunStream";
import { Badge } from "@/components/ui/badge";

type PathUpdate = {
  nodeIds: string[];
  edgeIds: string[];
  summary: string;
};

type Props = {
  query: string;
  queryPlan?: QueryPlan | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  pathUpdate: PathUpdate | null;
  washedPathUpdates?: PathUpdate[];
  showPathwayContext: boolean;
  showDrugContext: boolean;
  showInteractionContext: boolean;
  isRunning?: boolean;
  onSelectNode?: (nodeId: string | null) => void;
  selectedEdgeId?: string | null;
  onSelectEdge?: (edgeId: string | null) => void;
  onBridgeAnalysisChange?: (analysis: BridgeAnalysis) => void;
};

export function PathFirstGraph({
  query,
  queryPlan = null,
  nodes,
  edges,
  pathUpdate,
  washedPathUpdates = [],
  showPathwayContext,
  showDrugContext,
  showInteractionContext,
  isRunning = false,
  onSelectNode,
  selectedEdgeId,
  onSelectEdge,
  onBridgeAnalysisChange,
}: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const bridgeAnalysis = useMemo(
    () =>
      analyzeBridgeOutcomes({
        query,
        queryPlan,
        nodes,
        edges,
      }),
    [edges, nodes, query, queryPlan],
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

    const allNodes = [...nodes];
    for (const virtualNode of bridgeAnalysis.virtualNodes) {
      if (!allNodes.some((node) => node.id === virtualNode.id)) {
        allNodes.push(virtualNode);
      }
    }

    const allEdges = [...edges];
    for (const virtualEdge of bridgeAnalysis.virtualEdges) {
      if (!allEdges.some((edge) => edge.id === virtualEdge.id)) {
        allEdges.push(virtualEdge);
      }
    }

    const nodeById = new Map(allNodes.map((node) => [node.id, node]));
    const edgeById = new Map(allEdges.map((edge) => [edge.id, edge]));
    const pathFocusNodeIds = new Set(pathUpdate?.nodeIds ?? []);
    const pathFocusEdgeIds = new Set(pathUpdate?.edgeIds ?? []);
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
        if (!pathFocusNodeIds.has(nodeId)) washedNodeIds.add(nodeId);
      }
      for (const edgeId of washed.edgeIds) {
        if (!pathFocusEdgeIds.has(edgeId)) washedEdgeIds.add(edgeId);
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

    const selectedEdgeIds = new Set<string>(focusEdgeIds);
    const addTopEdgesForTarget = (targetId: string, type: GraphEdge["type"], limit: number) => {
      const top = allEdges
        .filter((edge) =>
          type === "target_target"
            ? edge.type === type && (edge.source === targetId || edge.target === targetId)
            : edge.type === type && edge.source === targetId,
        )
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
      if (primaryTargetIds.has(edge.target)) {
        selectedEdgeIds.add(edge.id);
        focusNodeIds.add(edge.source);
        focusNodeIds.add(edge.target);
      }
    }

    for (const edge of diseaseBridgeEdges) {
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

    const maxEdges = showInteractionContext ? 180 : 140;
    const visibleEdges = allEdges
      .filter((edge) => selectedEdgeIds.has(edge.id))
      .sort((a, b) => {
        const p = priority(b) - priority(a);
        if (p !== 0) return p;
        return (b.weight ?? 0) - (a.weight ?? 0);
      })
      .slice(0, maxEdges);

    for (const edge of visibleEdges) {
      focusNodeIds.add(edge.source);
      focusNodeIds.add(edge.target);
    }

    const visibleNodeIds = new Set<string>(focusNodeIds);
    const visibleNodes = allNodes.filter((node) => visibleNodeIds.has(node.id));
    const layoutRootIds = bridgeAnalysis.anchors
      .map((anchor) => anchor.nodeId ?? anchor.virtualNodeId)
      .filter((id): id is string => Boolean(id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, 4);

    const hiddenEdges = Math.max(0, allEdges.length - visibleEdges.length);
    const hiddenNodes = Math.max(0, allNodes.length - visibleNodes.length);
    const bridgeStatuses = diseaseBridgeEdges
      .map((edge) => String(edge.meta.status ?? "candidate"))
      .slice(0, 2);
    const summaryPrefix =
      pathUpdate?.summary ??
      bridgeAnalysis.queryTrailPath?.summary ??
      `Showing predominant ${showInteractionContext ? "mechanistic" : "translational"} connections across ${primaryTargetIds.size} lead targets`;
    const bridgeSuffix =
      bridgeStatuses.length > 0
        ? ` Bridge status: ${bridgeStatuses.join(", ")}.`
        : "";
    const summaryCore = hiddenEdges > 0
      ? `${summaryPrefix}. +${hiddenEdges} additional edges hidden for readability.${bridgeSuffix}`
      : `${summaryPrefix}${bridgeSuffix}`;
    const summary = `${summaryCore} ${bridgeAnalysis.summary}`.trim();
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
      highlightedNodeIds: pathFocusNodeIds,
      highlightedEdgeIds: pathFocusEdgeIds,
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
    edges,
    nodes,
    pathUpdate?.edgeIds,
    pathUpdate?.nodeIds,
    pathUpdate?.summary,
    washedPathUpdates,
    showDrugContext,
    showInteractionContext,
    showPathwayContext,
  ]);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#d7dbf5] bg-[#f7f7ff] px-3 py-2 text-xs text-[#4b4f80]">
        <div className="font-medium text-[#373c78]">
          {computed.summary}
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-[#ebe9ff] text-[#4a42aa]">
            Nodes {computed.visibleNodes.length}
          </Badge>
          <Badge className="bg-[#effaf8] text-[#0f766e]">
            Edges {computed.visibleEdges.length}
          </Badge>
          <Badge
            className={
              computed.bridgeStatus === "connected"
                ? "bg-[#ecf7f2] text-[#1f7a4f]"
                : computed.bridgeStatus === "no_connection"
                  ? "bg-[#f4efff] text-[#6a43be]"
                  : "bg-[#eef1f7] text-[#57607b]"
            }
          >
            {computed.bridgeStatus === "connected"
              ? "Bridge connected"
              : computed.bridgeStatus === "no_connection"
                ? "Bridge gap"
                : "Bridge pending"}{" "}
            {computed.bridgePairCount > 0 ? `(${computed.bridgePairCount})` : ""}
          </Badge>
          {computed.washedEdgeIds.size > 0 ? (
            <Badge className="bg-[#f1f2fa] text-[#5d5f7b]">
              Washed paths {computed.washedEdgeIds.size}
            </Badge>
          ) : null}
        </div>
      </div>
      {computed.activeTrail.length > 0 ? (
        <div className="rounded-lg border border-[#d7dcf5] bg-white px-3 py-2 text-[11px] text-[#4e5a88]">
          <span className="font-semibold text-[#3f4a8f]">Active trail:</span>{" "}
          {computed.activeTrail.join(" • ")}
        </div>
      ) : null}
      {bridgeAnalysis.anchors.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#d7dcf5] bg-white px-3 py-2 text-[11px] text-[#4e5a88]">
          <span className="font-semibold text-[#3f4a8f]">Query anchors:</span>
          {bridgeAnalysis.anchors.map((anchor) => (
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
            </span>
          ))}
        </div>
      ) : null}

      {computed.bridgePairSummaries.length > 0 ? (
        <div className="grid gap-1.5 rounded-lg border border-[#d7dcf5] bg-white px-3 py-2 text-[11px] text-[#4e5a88]">
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
        <div className="rounded-lg border border-[#d7dcf5] bg-[#f7f8ff] px-3 py-2 text-xs text-[#4b5686]">
          Graph stream initialized. Waiting for target and pathway evidence batches.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#4c5a89]">
        <span className="rounded-full border border-[#f4c8cc] bg-[#fff2f4] px-2 py-0.5">Disease</span>
        <span className="rounded-full border border-[#c8cbff] bg-[#eceeff] px-2 py-0.5">Target</span>
        <span className="rounded-full border border-[#bde9de] bg-[#ebfaf7] px-2 py-0.5">Pathway</span>
        <span className="rounded-full border border-[#dcc9ff] bg-[#f5efff] px-2 py-0.5">Drug</span>
        <span className="rounded-full border border-[#d7dced] bg-[#f2f4f9] px-2 py-0.5">Interaction</span>
        <span className="rounded-full border border-[#d4c8ff] bg-[#f3efff] px-2 py-0.5">Cross-anchor bridge</span>
        <span className="rounded-full border border-[#d7dcf5] bg-white px-2 py-0.5">
          Directed edges: disease -&gt; target -&gt; pathway/drug. Bridge edges indicate connect/no-connect results.
        </span>
      </div>

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
