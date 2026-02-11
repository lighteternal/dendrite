"use client";

import { useMemo, useState } from "react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { GraphCanvas } from "@/components/targetgraph/graph-canvas";
import { Badge } from "@/components/ui/badge";

type PathUpdate = {
  nodeIds: string[];
  edgeIds: string[];
  summary: string;
};

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  pathUpdate: PathUpdate | null;
  showPathwayContext: boolean;
  showDrugContext: boolean;
  showInteractionContext: boolean;
  onSelectNode?: (nodeId: string | null) => void;
};

export function PathFirstGraph({
  nodes,
  edges,
  pathUpdate,
  showPathwayContext,
  showDrugContext,
  showInteractionContext,
  onSelectNode,
}: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const computed = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const pathFocusNodeIds = new Set(pathUpdate?.nodeIds ?? []);
    const pathFocusEdgeIds = new Set(pathUpdate?.edgeIds ?? []);
    const focusNodeIds = new Set(pathFocusNodeIds);
    const focusEdgeIds = new Set(pathFocusEdgeIds);

    const diseaseNode = nodes.find((node) => node.type === "disease");
    if (diseaseNode) {
      focusNodeIds.add(diseaseNode.id);
    }

    const diseaseTargetEdges = edges
      .filter((edge) => edge.type === "disease_target")
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

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
      const top = edges
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

    // Keep graph readable by adding only edges that stay anchored to the disease/lead-target neighborhood.
    const minVisibleEdges = showInteractionContext ? 38 : 24;
    if (selectedEdgeIds.size < minVisibleEdges) {
      const anchorNodeIds = new Set<string>([
        ...(diseaseNode ? [diseaseNode.id] : []),
        ...primaryTargetIds,
      ]);
      for (const edge of [...edges].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
        if (selectedEdgeIds.has(edge.id)) continue;
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
      if (edge.type === "target_pathway") return 4;
      if (edge.type === "target_drug") return 3;
      if (edge.type === "target_target") return 2;
      return 1;
    };

    const maxEdges = showInteractionContext ? 120 : 90;
    const visibleEdges = edges
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
    const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));

    const hiddenEdges = Math.max(0, edges.length - visibleEdges.length);
    const hiddenNodes = Math.max(0, nodes.length - visibleNodes.length);
    const summaryPrefix =
      pathUpdate?.summary ??
      `Showing predominant ${showInteractionContext ? "mechanistic" : "translational"} connections across ${primaryTargetIds.size} lead targets`;
    const summary =
      hiddenEdges > 0
        ? `${summaryPrefix}. +${hiddenEdges} additional edges hidden for readability.`
        : summaryPrefix;

    return {
      visibleNodes,
      visibleEdges,
      hiddenEdges,
      hiddenNodes,
      highlightedNodeIds: pathFocusNodeIds,
      highlightedEdgeIds: pathFocusEdgeIds,
      summary,
    };
  }, [
    edges,
    nodes,
    pathUpdate?.edgeIds,
    pathUpdate?.nodeIds,
    pathUpdate?.summary,
    showDrugContext,
    showInteractionContext,
    showPathwayContext,
  ]);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#dfdbff] bg-[#f8f7ff] px-3 py-2 text-xs text-[#554f98]">
        <div className="font-medium text-[#352f7a]">
          {computed.summary}
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-[#efe9ff] text-[#4a4390]">
            Nodes {computed.visibleNodes.length}
          </Badge>
          <Badge className="bg-[#fff3e6] text-[#9a5818]">
            Edges {computed.visibleEdges.length}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#5f59a1]">
        <span className="rounded-full border border-[#f3b4aa] bg-[#ffeceb] px-2 py-0.5">Disease</span>
        <span className="rounded-full border border-[#ccc0ff] bg-[#f1ecff] px-2 py-0.5">Target</span>
        <span className="rounded-full border border-[#b9e3ee] bg-[#e8faff] px-2 py-0.5">Pathway</span>
        <span className="rounded-full border border-[#ffd4ad] bg-[#fff3e5] px-2 py-0.5">Drug</span>
        <span className="rounded-full border border-[#d8dcef] bg-[#f4f6ff] px-2 py-0.5">Interaction</span>
        <span className="rounded-full border border-[#ddd9ff] bg-white px-2 py-0.5">
          Directed edges: disease -&gt; target -&gt; pathway/drug
        </span>
      </div>

      <GraphCanvas
        nodes={computed.visibleNodes}
        edges={computed.visibleEdges}
        selectedNodeId={selectedNodeId}
        onSelectNode={(node) => {
          const nextId = node?.id ?? null;
          setSelectedNodeId(nextId);
          onSelectNode?.(nextId);
        }}
        highlightedNodeIds={computed.highlightedNodeIds}
        highlightedEdgeIds={computed.highlightedEdgeIds}
        dimUnfocused={false}
        hiddenSummary={{
          hiddenNodes: computed.hiddenNodes,
          hiddenEdges: computed.hiddenEdges,
          lens: "mechanism",
        }}
      />
    </div>
  );
}
