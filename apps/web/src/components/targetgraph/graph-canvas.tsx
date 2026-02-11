"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Core, ElementDefinition } from "cytoscape";
import { Camera, LocateFixed, Maximize2, Minimize2 } from "lucide-react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { Button } from "@/components/ui/button";

const CytoscapeComponent = dynamic(() => import("react-cytoscapejs"), {
  ssr: false,
});

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (node: GraphNode | null) => void;
  highlightedNodeIds?: Set<string>;
  highlightedEdgeIds?: Set<string>;
  dimUnfocused?: boolean;
  hiddenSummary?: {
    hiddenNodes: number;
    hiddenEdges: number;
    lens: string;
  };
};

const nodeColors: Record<GraphNode["type"], string> = {
  disease: "#ef5f66",
  target: "#7f4dd5",
  pathway: "#f0a23e",
  drug: "#e87f22",
  interaction: "#9f8bc9",
};

const edgeColors: Record<GraphEdge["type"], string> = {
  disease_target: "#9d8ca9",
  target_pathway: "#f0a23e",
  target_drug: "#e87f22",
  target_target: "#7f4dd5",
  pathway_drug: "#d06d1a",
};

const MIN_ZOOM = 0.34;
const MAX_ZOOM = 1.9;

function shortLabel(value: string, max = 28): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(8, max - 1))}\u2026`;
}

function informativeNodeLabel(node: GraphNode): string {
  const readMaybeLabel = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0) {
          return item.trim();
        }
      }
    }
    return undefined;
  };

  const displayName = readMaybeLabel(node.meta.displayName);
  const targetSymbol =
    typeof node.meta.targetSymbol === "string" && node.meta.targetSymbol.trim().length > 0
      ? node.meta.targetSymbol.trim()
      : undefined;

  if (node.type === "target") return targetSymbol ?? displayName ?? node.label;
  return displayName ?? node.label;
}

function shortestPath(startId: string, endId: string, adjacency: Map<string, string[]>) {
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
        let cursor = endId;
        while (parent.has(cursor)) {
          cursor = parent.get(cursor)!;
          path.unshift(cursor);
        }
        return path;
      }

      queue.push(next);
    }
  }

  return [];
}

function buildDegreeMap(edges: GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function nodeSize(node: GraphNode): number {
  if (node.type === "disease") return 46;
  if (node.type === "target") return Math.max(26, Math.min(40, (node.size ?? 20) * 0.78));
  if (node.type === "pathway") return 24;
  if (node.type === "drug") return 22;
  return 13;
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function GraphCanvas({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  highlightedNodeIds,
  highlightedEdgeIds,
  dimUnfocused = true,
  hiddenSummary,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1000);
  const [fullscreen, setFullscreen] = useState(false);
  const [cy, setCy] = useState<Core | null>(null);
  const [pathAnchorNodeId, setPathAnchorNodeId] = useState<string | null>(null);
  const [localFocusNodeIds, setLocalFocusNodeIds] = useState<Set<string>>(new Set());
  const [localFocusEdgeIds, setLocalFocusEdgeIds] = useState<Set<string>>(new Set());

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const validNodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const validEdges = useMemo(
    () =>
      edges.filter(
        (edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target),
      ),
    [edges, validNodeIds],
  );
  const degreeMap = useMemo(() => buildDegreeMap(validEdges), [validEdges]);
  const diseaseRootId = useMemo(
    () => nodes.find((node) => node.type === "disease")?.id ?? null,
    [nodes],
  );
  const layoutSignature = useMemo(() => {
    const nodeIds = nodes.map((node) => node.id).sort().join("|");
    const edgeIds = validEdges.map((edge) => edge.id).sort().join("|");
    return `${nodeIds}::${edgeIds}`;
  }, [nodes, validEdges]);

  const adjacency = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of validEdges) {
      map.set(edge.source, [...(map.get(edge.source) ?? []), edge.target]);
      map.set(edge.target, [...(map.get(edge.target) ?? []), edge.source]);
    }
    return map;
  }, [validEdges]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setWidth(Math.max(360, Math.floor(entry.contentRect.width)));
    });

    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const activeNodeSet = useMemo(
    () =>
      highlightedNodeIds && highlightedNodeIds.size > 0
        ? highlightedNodeIds
        : localFocusNodeIds,
    [highlightedNodeIds, localFocusNodeIds],
  );

  const activeEdgeSet = useMemo(
    () =>
      highlightedEdgeIds && highlightedEdgeIds.size > 0
        ? highlightedEdgeIds
        : localFocusEdgeIds,
    [highlightedEdgeIds, localFocusEdgeIds],
  );

  const hasFocusedSubset = dimUnfocused && (activeNodeSet.size > 0 || activeEdgeSet.size > 0);

  const autoLabelNodeIds = useMemo(() => {
    const rankBy = (type: GraphNode["type"], count: number, field: "score" | "degree") =>
      [...nodes]
        .filter((node) => node.type === type)
        .sort((a, b) => {
          const aValue = field === "score" ? (a.score ?? 0) : degreeMap.get(a.id) ?? 0;
          const bValue = field === "score" ? (b.score ?? 0) : degreeMap.get(b.id) ?? 0;
          return bValue - aValue;
        })
        .slice(0, count)
        .map((node) => node.id);

    return new Set<string>([
      ...rankBy("disease", 1, "score"),
      ...rankBy("target", 6, "score"),
      ...rankBy("pathway", 4, "degree"),
      ...rankBy("drug", 4, "degree"),
    ]);
  }, [degreeMap, nodes]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const nodeElements = nodes.map((node) => {
      const labelSource = informativeNodeLabel(node);
      const shouldShowLabel =
        node.type === "disease" ||
        selectedNodeId === node.id ||
        activeNodeSet.has(node.id) ||
        autoLabelNodeIds.has(node.id) ||
        (node.type !== "interaction" && nodes.length <= 16) ||
        (node.type === "target" && nodes.length <= 36) ||
        (node.type === "pathway" && nodes.length <= 24) ||
        (node.type === "drug" && nodes.length <= 24);

      const classes = [
        hasFocusedSubset && !activeNodeSet.has(node.id) ? "is-faded" : "",
        activeNodeSet.has(node.id) ? "is-focused" : "",
        selectedNodeId === node.id ? "is-selected" : "",
        shouldShowLabel ? "" : "label-hidden",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        data: {
          id: node.id,
          type: node.type,
          label: shortLabel(
            labelSource,
            node.type === "target" ? 16 : node.type === "pathway" ? 28 : 24,
          ),
          rawSize: nodeSize(node),
          color: nodeColors[node.type],
        },
        classes,
      } satisfies ElementDefinition;
    });

    const edgeElements = validEdges.map((edge) => {
      const showEdgeLabel =
        activeEdgeSet.has(edge.id) ||
        (edge.type !== "target_target" && (edge.weight ?? 0) >= 0.92 && nodes.length <= 60);
      const classes = [
        hasFocusedSubset && !activeEdgeSet.has(edge.id) ? "is-faded" : "",
        activeEdgeSet.has(edge.id) ? "is-focused" : "",
        showEdgeLabel ? "label-visible" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type,
          label:
            edge.type === "disease_target"
              ? "association"
              : edge.type === "target_pathway"
                ? "pathway"
                : edge.type === "target_drug"
                  ? "drug link"
                  : edge.type === "target_target"
                    ? "interaction"
                    : "mechanism link",
          weight: edge.weight ?? 0.4,
          color: edgeColors[edge.type],
        },
        classes,
      } satisfies ElementDefinition;
    });

    return [...nodeElements, ...edgeElements];
  }, [
    activeEdgeSet,
    activeNodeSet,
    autoLabelNodeIds,
    validEdges,
    hasFocusedSubset,
    nodes,
    selectedNodeId,
  ]);

  const stylesheet = useMemo(
    () => [
      {
        selector: "node",
        style: {
          label: "data(label)",
          width: "data(rawSize)",
          height: "data(rawSize)",
          "background-color": "data(color)",
          color: "#2f2a70",
          "font-size": 11,
          "font-family": "var(--font-body)",
          "text-wrap": "wrap",
          "text-max-width": 124,
          "min-zoomed-font-size": 7,
          "text-background-color": "#ffffff",
          "text-background-opacity": 0.9,
          "text-background-shape": "roundrectangle",
          "text-background-padding": "1.4px",
          "text-border-width": 1,
          "text-border-color": "#ffd7b1",
          "text-border-opacity": 0.85,
          "text-margin-y": 12,
          "text-valign": "bottom",
          "border-width": 1.2,
          "border-color": "#ffffff",
          "overlay-opacity": 0,
          "shadow-blur": 10,
          "shadow-opacity": 0.18,
          "shadow-color": "#d28a3a",
        },
      },
      {
        selector: "node[type = 'target']",
        style: {
          shape: "round-rectangle",
        },
      },
      {
        selector: "node[type = 'pathway']",
        style: {
          shape: "round-rectangle",
          width: 30,
          height: 22,
        },
      },
      {
        selector: "node[type = 'drug']",
        style: {
          shape: "diamond",
          width: 22,
          height: 22,
        },
      },
      {
        selector: "node[type = 'interaction']",
        style: {
          width: 14,
          height: 14,
        },
      },
      {
        selector: "node.label-hidden",
        style: {
          label: "",
        },
      },
      {
        selector: "node.is-selected",
        style: {
          "border-width": 2.6,
          "border-color": "#f0872d",
          "shadow-opacity": 0.34,
          "shadow-color": "#f0872d",
        },
      },
      {
        selector: "node.is-faded",
        style: {
          opacity: 0.14,
          "text-opacity": 0.08,
        },
      },
      {
        selector: "edge",
        style: {
          width: "mapData(weight, 0, 1, 1, 3.8)",
          "line-color": "data(color)",
          "target-arrow-color": "data(color)",
          "target-arrow-shape": "triangle",
          "source-endpoint": "outside-to-node",
          "target-endpoint": "outside-to-node",
          "line-cap": "round",
          "arrow-scale": 0.9,
          "curve-style": "bezier",
          opacity: 0.84,
        },
      },
      {
        selector: "edge[type = 'target_target']",
        style: {
          "curve-style": "unbundled-bezier",
          "edge-distances": "node-position",
          "control-point-distances": [24],
          "control-point-weights": [0.5],
        },
      },
      {
        selector: "edge.is-faded",
        style: {
          opacity: 0.12,
        },
      },
      {
        selector: "edge.is-focused",
        style: {
          opacity: 0.96,
          width: "mapData(weight, 0, 1, 2, 4.6)",
        },
      },
      {
        selector: "edge.label-visible",
        style: {
          label: "data(label)",
          "font-size": 9,
          color: "#8a4d1a",
          "text-background-color": "#fff5e8",
          "text-background-opacity": 0.92,
          "text-background-shape": "roundrectangle",
          "text-border-width": 0.8,
          "text-border-color": "#f8c99b",
          "text-border-opacity": 0.9,
          "text-rotation": "autorotate",
        },
      },
    ],
    [],
  );

  useEffect(() => {
    if (!cy) return;

    const useBreadth = nodes.length <= 28;

    const layout = cy.layout(
      useBreadth
        ? {
            name: "breadthfirst",
            directed: true,
            animate: true,
            animationDuration: 320,
            fit: true,
            padding: 28,
            spacingFactor: 1.02,
            roots: diseaseRootId ? [diseaseRootId] : undefined,
          }
        : {
            name: "cose",
            animate: true,
            animationDuration: 360,
            fit: true,
            padding: 28,
            randomize: false,
            gravity: 0.34,
            componentSpacing: 58,
            idealEdgeLength: (edge: { data: (key: string) => string }) => {
              const type = edge.data("type") as GraphEdge["type"];
              if (type === "disease_target") return 138;
              if (type === "target_pathway") return 118;
              if (type === "target_drug") return 112;
              if (type === "target_target") return 126;
              return 115;
            },
            nodeRepulsion: (node: { data: (key: string) => string }) => {
              const type = node.data("type") as GraphNode["type"];
              if (type === "disease") return 145000;
              if (type === "target") return 98000;
              return 68000;
            },
          },
    );

    layout.on("layoutstop", () => {
      const padding = nodes.length <= 12 ? 36 : nodes.length <= 40 ? 32 : 26;
      cy.fit(undefined, padding);
      const currentZoom = cy.zoom();
      const maxPreferredZoom =
        nodes.length <= 5
          ? 0.95
          : nodes.length <= 12
            ? 1.08
            : nodes.length <= 30
              ? 1.18
              : 1.35;
      const minPreferredZoom =
        nodes.length >= 130
          ? 0.34
          : nodes.length >= 80
            ? 0.4
            : nodes.length >= 40
              ? 0.46
              : 0.52;
      const bounded = Math.max(minPreferredZoom, Math.min(currentZoom, maxPreferredZoom));
      cy.zoom(clampZoom(bounded));
      cy.center();
    });

    layout.run();
    cy.minZoom(MIN_ZOOM);
    cy.maxZoom(MAX_ZOOM);
  }, [cy, diseaseRootId, layoutSignature, nodes.length]);

  useEffect(() => {
    if (!cy) return;

    const onTapBackground = (event: { target: unknown }) => {
      if (event.target !== cy) return;
      setPathAnchorNodeId(null);
      setLocalFocusNodeIds(new Set());
      setLocalFocusEdgeIds(new Set());
      onSelectNode(null);
    };

    const onTapNode = (event: {
      target: { id: () => string };
      originalEvent?: MouseEvent;
    }) => {
      const nodeId = String(event.target.id());
      const mouseEvent = event.originalEvent;

      if (mouseEvent?.shiftKey && pathAnchorNodeId) {
        const path = shortestPath(pathAnchorNodeId, nodeId, adjacency);
        if (path.length > 0) {
          const focusNodes = new Set(path);
          const focusEdges = new Set<string>();

          for (let i = 0; i < path.length - 1; i += 1) {
            const from = path[i]!;
            const to = path[i + 1]!;
            const hit = validEdges.find(
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
        return;
      }

      if (mouseEvent?.shiftKey) {
        setPathAnchorNodeId(nodeId);
        return;
      }

      setPathAnchorNodeId(null);
      setLocalFocusNodeIds(new Set());
      setLocalFocusEdgeIds(new Set());
      onSelectNode(nodeMap.get(nodeId) ?? null);
    };

    const onRightTapNode = (event: { target: { id: () => string } }) => {
      const nodeId = String(event.target.id());
      const neighbors = adjacency.get(nodeId) ?? [];
      const neighborhood = new Set<string>([nodeId, ...neighbors]);
      const focusEdges = new Set<string>();

      for (const edge of validEdges) {
        if (neighborhood.has(edge.source) && neighborhood.has(edge.target)) {
          focusEdges.add(edge.id);
        }
      }

      setLocalFocusNodeIds(neighborhood);
      setLocalFocusEdgeIds(focusEdges);
      onSelectNode(nodeMap.get(nodeId) ?? null);
    };

    cy.on("tap", onTapBackground);
    cy.on("tap", "node", onTapNode);
    cy.on("cxttap", "node", onRightTapNode);

    return () => {
      cy.off("tap", onTapBackground);
      cy.off("tap", "node", onTapNode);
      cy.off("cxttap", "node", onRightTapNode);
    };
  }, [adjacency, cy, nodeMap, onSelectNode, pathAnchorNodeId, validEdges]);

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
    ? Math.max(420, Math.floor((typeof window !== "undefined" ? window.innerHeight : 900) - 48))
    : Math.max(460, Math.floor(width * 0.56));

  return (
    <div
      ref={containerRef}
      className={
        fullscreen
          ? "fixed inset-0 z-40 rounded-none border-0 bg-[#f2f2ff] p-3"
          : "relative min-h-[460px] overflow-hidden rounded-xl border border-[#f2dac4] bg-[linear-gradient(180deg,#fffdf8_0%,#fff5ec_100%)] shadow-[0_26px_72px_rgba(170,107,42,0.18)]"
      }
    >
      <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
        <Button
          size="icon"
          variant="secondary"
          onClick={() => {
            setLocalFocusNodeIds(new Set());
            setLocalFocusEdgeIds(new Set());
            setPathAnchorNodeId(null);
            if (!cy) return;
            cy.fit(undefined, 40);
            cy.zoom(clampZoom(cy.zoom()));
            cy.center();
          }}
          title="Fit graph"
          className="border-[#f1d8c2] bg-white text-[#8b4f1a] hover:bg-[#fff2e5]"
        >
          <LocateFixed className="h-4 w-4" />
        </Button>

        <Button
          size="icon"
          variant="secondary"
          onClick={() => {
            if (!cy) return;
            const png = cy.png({
              full: true,
              scale: 2,
              bg: "#ffffff",
            });
            const a = document.createElement("a");
            a.href = png;
            a.download = "targetgraph-network.png";
            a.click();
          }}
          className="border-[#f1d8c2] bg-white text-[#8b4f1a] hover:bg-[#fff2e5]"
        >
          <Camera className="h-4 w-4" />
        </Button>

        <Button
          size="icon"
          variant="secondary"
          onClick={() => setFullscreen((prev) => !prev)}
          className="border-[#f1d8c2] bg-white text-[#8b4f1a] hover:bg-[#fff2e5]"
        >
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>

      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-xl border border-[#f1d8c2] bg-white/92 px-3 py-2 text-[11px] text-[#885527] backdrop-blur">
        <div className="mb-1 font-semibold text-[#6e3f17]">Live Graph</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <span>Disease: {nodeCounts.disease ?? 0}</span>
          <span>Targets: {nodeCounts.target ?? 0}</span>
          <span>Pathways: {nodeCounts.pathway ?? 0}</span>
          <span>Drugs: {nodeCounts.drug ?? 0}</span>
          <span>Interactions: {nodeCounts.interaction ?? 0}</span>
          <span>Edges: {validEdges.length}</span>
        </div>
        {hiddenSummary && hiddenSummary.hiddenEdges > 0 ? (
          <div className="mt-1 rounded-md border border-[#f3d1ab] bg-[#fff7ec] px-2 py-1 text-[10px] text-[#8f5b2d]">
            +{hiddenSummary.hiddenEdges} more edges hidden ({hiddenSummary.lens} lens)
          </div>
        ) : null}
      </div>

      <CytoscapeComponent
        elements={elements}
        stylesheet={stylesheet}
        style={{ width: "100%", height: `${canvasHeight}px` }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        wheelSensitivity={0.16}
        cy={(instance: Core) => {
          if (cy !== instance) {
            setCy(instance);
          }
        }}
      />

      {nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-full border border-[#f1d8c2] bg-white px-4 py-2 text-xs font-medium text-[#8b4f1a]">
            Building core network...
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-[#f1d8c2] bg-white/92 px-2.5 py-1.5 text-[10px] text-[#94633a]">
        Right-click: neighborhood focus • Shift-click two nodes: shortest path
      </div>
    </div>
  );
}
