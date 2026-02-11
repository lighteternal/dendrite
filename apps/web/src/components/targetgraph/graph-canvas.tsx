"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d";
import { Camera, LocateFixed, Maximize2, Minimize2 } from "lucide-react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { Button } from "@/components/ui/button";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (node: GraphNode | null) => void;
  highlightedNodeIds?: Set<string>;
  highlightedEdgeIds?: Set<string>;
  hiddenSummary?: {
    hiddenNodes: number;
    hiddenEdges: number;
    lens: string;
  };
};

type RenderNode = NodeObject & {
  id: string;
  type: GraphNode["type"];
  label: string;
  size: number;
  score: number;
  color: string;
};

type RenderLink = LinkObject<RenderNode> & {
  id: string;
  source: string | RenderNode;
  target: string | RenderNode;
  type: GraphEdge["type"];
  weight: number;
  color: string;
};

const nodeColors: Record<GraphNode["type"], string> = {
  disease: "#ef4444",
  target: "#5b57e6",
  pathway: "#06b6d4",
  drug: "#f08b2e",
  interaction: "#8b95b5",
};

const edgeColors: Record<GraphEdge["type"], string> = {
  disease_target: "#8b95b5",
  target_pathway: "#2ea6d6",
  target_drug: "#f08b2e",
  target_target: "#7c3aed",
  pathway_drug: "#27a4bb",
};

const shortestPath = (startId: string, endId: string, adjacency: Map<string, string[]>) => {
  if (startId === endId) return [startId];

  const queue: string[] = [startId];
  const visited = new Set<string>([startId]);
  const parent = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current) ?? [];

    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      if (next === endId) {
        const path = [endId];
        let node = endId;
        while (parent.has(node)) {
          node = parent.get(node)!;
          path.unshift(node);
        }
        return path;
      }
      queue.push(next);
    }
  }

  return [];
};

function drawNode(ctx: CanvasRenderingContext2D, node: RenderNode, radius: number) {
  switch (node.type) {
    case "disease": {
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.14, 0, 2 * Math.PI, false);
      ctx.fill();
      break;
    }
    case "target": {
      const w = radius * 2.2;
      const h = radius * 1.3;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, 4);
      ctx.fill();
      break;
    }
    case "pathway": {
      const w = radius * 2.3;
      const h = radius * 1.2;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
      ctx.fill();
      break;
    }
    case "drug": {
      ctx.beginPath();
      ctx.moveTo(0, -radius * 1.1);
      ctx.lineTo(radius * 1.1, 0);
      ctx.lineTo(0, radius * 1.1);
      ctx.lineTo(-radius * 1.1, 0);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "interaction":
    default: {
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.92, 0, 2 * Math.PI, false);
      ctx.fill();
      break;
    }
  }
}

export function GraphCanvas({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  highlightedNodeIds,
  highlightedEdgeIds,
  hiddenSummary,
}: Props) {
  const fgRef = useRef<ForceGraphMethods<NodeObject, LinkObject> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasFittedRef = useRef(false);
  const lastAutoFitNodeCountRef = useRef(0);

  const [width, setWidth] = useState(1000);
  const [fullscreen, setFullscreen] = useState(false);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [pathAnchorNodeId, setPathAnchorNodeId] = useState<string | null>(null);
  const [localFocusNodeIds, setLocalFocusNodeIds] = useState<Set<string>>(new Set());
  const [localFocusEdgeIds, setLocalFocusEdgeIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextWidth = Math.max(360, Math.floor(entry.contentRect.width));
      setWidth(nextWidth);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const adjacency = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of edges) {
      const source = edge.source;
      const target = edge.target;
      map.set(source, [...(map.get(source) ?? []), target]);
      map.set(target, [...(map.get(target) ?? []), source]);
    }
    return map;
  }, [edges]);

  const renderNodes = useMemo<RenderNode[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        size: node.size ?? 18,
        score: node.score ?? 0,
        color: nodeColors[node.type],
      })),
    [nodes],
  );

  const renderLinks = useMemo<RenderLink[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        weight: edge.weight ?? 0.4,
        color: edgeColors[edge.type],
      })),
    [edges],
  );

  const activeNodeSet = useMemo(
    () =>
      highlightedNodeIds && highlightedNodeIds.size > 0 ? highlightedNodeIds : localFocusNodeIds,
    [highlightedNodeIds, localFocusNodeIds],
  );

  const activeEdgeSet = useMemo(
    () =>
      highlightedEdgeIds && highlightedEdgeIds.size > 0 ? highlightedEdgeIds : localFocusEdgeIds,
    [highlightedEdgeIds, localFocusEdgeIds],
  );

  const hasFocusedSubset = activeNodeSet.size > 0 || activeEdgeSet.size > 0;

  useEffect(() => {
    if (nodes.length === 0 || !fgRef.current) {
      hasFittedRef.current = false;
      lastAutoFitNodeCountRef.current = 0;
      return;
    }
    const shouldFirstFit = !hasFittedRef.current;
    const shouldWaveFit =
      hasFittedRef.current &&
      !selectedNodeId &&
      !hasFocusedSubset &&
      nodes.length - lastAutoFitNodeCountRef.current >= 18;

    if (shouldFirstFit || shouldWaveFit) {
      const timer = setTimeout(() => {
        fgRef.current?.zoomToFit(360, shouldFirstFit ? 68 : 52);
      }, 220);
      hasFittedRef.current = true;
      lastAutoFitNodeCountRef.current = nodes.length;
      return () => clearTimeout(timer);
    }
    return;
  }, [hasFocusedSubset, nodes.length, selectedNodeId]);

  useEffect(() => {
    const graph = fgRef.current as
      | (ForceGraphMethods<NodeObject, LinkObject> & {
          d3Force: (name: string) => unknown;
          d3ReheatSimulation: () => void;
        })
      | undefined;
    if (!graph) return;

    const chargeForce = graph.d3Force("charge") as
      | { strength: (value: number | ((node: RenderNode) => number)) => void }
      | undefined;
    chargeForce?.strength((node: RenderNode) => {
      switch (node.type) {
        case "disease":
          return -760;
        case "target":
          return -360;
        case "pathway":
          return -280;
        case "drug":
          return -200;
        case "interaction":
        default:
          return -155;
      }
    });

    const linkForce = graph.d3Force("link") as
      | {
          distance: (value: number | ((link: RenderLink) => number)) => void;
          strength: (value: number | ((link: RenderLink) => number)) => void;
        }
      | undefined;
    linkForce?.distance((link: RenderLink) => {
      switch (link.type) {
        case "disease_target":
          return 130;
        case "target_pathway":
          return 118;
        case "target_drug":
          return 86;
        case "target_target":
          return 78;
        case "pathway_drug":
        default:
          return 102;
      }
    });
    linkForce?.strength((link: RenderLink) => {
      return link.type === "target_target" ? 0.08 : 0.14;
    });

    const collideForce = graph.d3Force("collide") as
      | { radius: (value: number | ((node: RenderNode) => number)) => void }
      | undefined;
    collideForce?.radius((node: RenderNode) =>
      Math.max(9, Math.min(28, 8 + (node.size ?? 16) * 0.24)),
    );

    graph.d3ReheatSimulation();
  }, [edges.length, nodes.length]);

  const nodeCounts = useMemo(
    () =>
      nodes.reduce(
        (acc, node) => {
          acc[node.type] = (acc[node.type] ?? 0) + 1;
          return acc;
        },
        {} as Record<GraphNode["type"], number>,
      ),
    [nodes],
  );
  const canvasHeight = fullscreen
    ? Math.max(420, Math.floor(window.innerHeight - 48))
    : Math.max(460, Math.floor(width * 0.56));

  return (
    <div
      ref={containerRef}
      className={
        fullscreen
          ? "fixed inset-0 z-40 rounded-none border-0 bg-[#f2f2ff] p-3"
          : "relative min-h-[460px] overflow-hidden rounded-xl border border-[#d7d2ff] bg-[linear-gradient(180deg,#fcfbff_0%,#f1f3ff_100%)] shadow-[0_26px_72px_rgba(77,65,170,0.18)]"
      }
    >
      <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
        <Button
          size="icon"
          variant="secondary"
          onClick={() => {
            setLocalFocusNodeIds(new Set());
            setLocalFocusEdgeIds(new Set());
            fgRef.current?.zoomToFit(360, 52);
          }}
          title="Fit graph"
          className="border-[#d7d2ff] bg-white text-[#4a4390] hover:bg-[#f2efff]"
        >
          <LocateFixed className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={() => {
            const canvas = containerRef.current?.querySelector("canvas");
            if (!canvas) return;
            const a = document.createElement("a");
            a.href = canvas.toDataURL("image/png", 1);
            a.download = "targetgraph-network.png";
            a.click();
          }}
          className="border-[#d7d2ff] bg-white text-[#4a4390] hover:bg-[#f2efff]"
        >
          <Camera className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={() => setFullscreen((prev) => !prev)}
          className="border-[#d7d2ff] bg-white text-[#4a4390] hover:bg-[#f2efff]"
        >
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>

      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-xl border border-[#ddd9ff] bg-white/92 px-3 py-2 text-[11px] text-[#5c56a0] backdrop-blur">
        <div className="mb-1 font-semibold text-[#342f7b]">Live Graph</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <span>Disease: {nodeCounts.disease ?? 0}</span>
          <span>Targets: {nodeCounts.target ?? 0}</span>
          <span>Pathways: {nodeCounts.pathway ?? 0}</span>
          <span>Drugs: {nodeCounts.drug ?? 0}</span>
          <span>Interactions: {nodeCounts.interaction ?? 0}</span>
          <span>Edges: {edges.length}</span>
        </div>
        {hiddenSummary && hiddenSummary.hiddenEdges > 0 ? (
          <div className="mt-1 rounded-md border border-[#f3d1ab] bg-[#fff7ec] px-2 py-1 text-[10px] text-[#8f5b2d]">
            +{hiddenSummary.hiddenEdges} more edges hidden ({hiddenSummary.lens} lens)
          </div>
        ) : null}
      </div>

      <ForceGraph2D
        ref={fgRef}
        width={width}
        height={canvasHeight}
        graphData={{
          nodes: renderNodes,
          links: renderLinks,
        }}
        backgroundColor="rgba(0,0,0,0)"
        nodeLabel={() => ""}
        linkDirectionalArrowLength={2.2}
        linkDirectionalArrowRelPos={0.98}
        linkDirectionalParticles={(link) => (activeEdgeSet.has(link.id) ? 2 : 0)}
        linkDirectionalParticleWidth={2.8}
        linkDirectionalParticleSpeed={0.006}
        d3AlphaDecay={0.028}
        d3VelocityDecay={0.24}
        cooldownTicks={170}
        onBackgroundClick={() => {
          setPathAnchorNodeId(null);
          setLocalFocusNodeIds(new Set());
          setLocalFocusEdgeIds(new Set());
          onSelectNode(null);
        }}
        onNodeHover={(node) => setHoverNodeId(node ? String(node.id) : null)}
        onNodeClick={(node, event) => {
          const nodeId = String(node.id);
          const mouseEvent = event as MouseEvent;
          if (mouseEvent.shiftKey && pathAnchorNodeId) {
            const path = shortestPath(pathAnchorNodeId, nodeId, adjacency);
            if (path.length > 0) {
              const focusNodes = new Set(path);
              const focusEdges = new Set<string>();
              for (let i = 0; i < path.length - 1; i += 1) {
                const from = path[i]!;
                const to = path[i + 1]!;
                const hit = edges.find(
                  (edge) =>
                    (edge.source === from && edge.target === to) ||
                    (edge.source === to && edge.target === from),
                );
                if (hit) focusEdges.add(hit.id);
              }
              setLocalFocusNodeIds(focusNodes);
              setLocalFocusEdgeIds(focusEdges);
            }
            setPathAnchorNodeId(null);
          } else if (mouseEvent.shiftKey) {
            setPathAnchorNodeId(nodeId);
          } else {
            setPathAnchorNodeId(null);
            setLocalFocusNodeIds(new Set());
            setLocalFocusEdgeIds(new Set());
            onSelectNode(nodeMap.get(nodeId) ?? null);
          }
        }}
        onNodeRightClick={(node) => {
          const nodeId = String(node.id);
          const neighbors = adjacency.get(nodeId) ?? [];
          const neighborhood = new Set<string>([nodeId, ...neighbors]);
          const focusEdges = new Set<string>();
          for (const edge of edges) {
            if (neighborhood.has(edge.source) && neighborhood.has(edge.target)) {
              focusEdges.add(edge.id);
            }
          }
          setLocalFocusNodeIds(neighborhood);
          setLocalFocusEdgeIds(focusEdges);
          onSelectNode(nodeMap.get(nodeId) ?? null);
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as RenderNode;
          const selected = selectedNodeId === n.id;
          const focused = !hasFocusedSubset || activeNodeSet.has(n.id);
          const radius = Math.max(6.4, Math.min(18, 5.8 + (n.size ?? 14) * 0.24));

          const glow =
            selected
              ? 10
              : n.type === "target"
                ? 4 + (n.score ?? 0) * 14
                : n.type === "disease"
                  ? 6
                  : 0;

          if (glow > 0) {
            ctx.save();
            ctx.globalAlpha = focused ? 0.82 : 0.14;
            ctx.shadowColor = selected ? "#f08b2e" : n.color;
            ctx.shadowBlur = glow;
            ctx.fillStyle = selected ? "#5b57e6" : n.color;
            drawNode(ctx, n, radius * 0.98);
            ctx.restore();
          }

          ctx.save();
          ctx.globalAlpha = focused ? 0.95 : 0.16;
          ctx.fillStyle = selected ? "#5b57e6" : n.color;
          ctx.strokeStyle = selected ? "#f08b2e" : "#ffffff";
          ctx.lineWidth = selected ? 2.2 : 1;
          drawNode(ctx, n, radius);
          ctx.stroke();
          ctx.restore();

          const showLabel =
            n.type === "disease" ||
            n.type === "target" ||
            selected ||
            activeNodeSet.has(n.id) ||
            hoverNodeId === n.id ||
            globalScale > 2.1;

          if (!showLabel) return;

          const label = n.label;
          const fontSize = Math.max(9, 11 / globalScale);
          ctx.font = `${fontSize}px var(--font-body)`;
          const widthWithPadding = ctx.measureText(label).width + 8;
          const x = 0;
          const y = radius + fontSize + 4;

          ctx.save();
          ctx.globalAlpha = focused ? 0.95 : 0.2;
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.strokeStyle = "rgba(155,145,224,0.7)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x - widthWithPadding / 2, y - fontSize, widthWithPadding, fontSize + 6, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#322c73";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, x, y - fontSize / 2 + 2);
          ctx.restore();
        }}
        linkColor={(link) => {
          const l = link as RenderLink;
          if (!hasFocusedSubset) return l.color;
          return activeEdgeSet.has(l.id) ? l.color : "rgba(173,163,224,0.25)";
        }}
        linkWidth={(link) => {
          const l = link as RenderLink;
          const base = Math.max(0.7, Math.min(3.2, l.weight * 2.4));
          if (!hasFocusedSubset) return base;
          return activeEdgeSet.has(l.id) ? Math.max(base, 2.4) : 0.6;
        }}
        linkCurvature={(link) => ((link as RenderLink).type === "target_target" ? 0.18 : 0.08)}
      />

      {nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-full border border-[#ddd9ff] bg-white px-4 py-2 text-xs font-medium text-[#4e488f]">
            Building core network...
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-[#ddd9ff] bg-white/92 px-2.5 py-1.5 text-[10px] text-[#6962a8]">
        Right-click: neighborhood focus • Shift-click two nodes: shortest path
      </div>
    </div>
  );
}
