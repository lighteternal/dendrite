"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Core, ElementDefinition } from "cytoscape";
import { Camera, LocateFixed, Maximize2, Minimize2 } from "lucide-react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import {
  EDGE_SOURCE_GROUP_META,
  EDGE_SOURCE_GROUPS,
  getEdgeSourceGroup,
  type EdgeSourceGroup,
} from "@/components/targetgraph/graph-source";
import { Button } from "@/components/ui/button";

const CytoscapeComponent = dynamic(() => import("react-cytoscapejs"), {
  ssr: false,
});

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (node: GraphNode | null) => void;
  selectedEdgeId?: string | null;
  onSelectEdge?: (edge: GraphEdge | null) => void;
  highlightedNodeIds?: Set<string>;
  highlightedEdgeIds?: Set<string>;
  washedNodeIds?: Set<string>;
  washedEdgeIds?: Set<string>;
  dimUnfocused?: boolean;
  isRunning?: boolean;
  hiddenSummary?: {
    hiddenNodes: number;
    hiddenEdges: number;
    lens: string;
  };
  layoutRootIds?: string[];
};

const nodeColors: Record<GraphNode["type"], string> = {
  disease: "#e84d89",
  target: "#4f46e5",
  pathway: "#0d9488",
  drug: "#8b5cf6",
  interaction: "#7f8aa6",
};

const edgeColors: Record<GraphEdge["type"], string> = {
  disease_target: "#8e94c8",
  disease_disease: "#6d46d6",
  target_pathway: "#0f9f8c",
  target_drug: "#8b5cf6",
  target_target: "#465ac2",
  pathway_drug: "#756de0",
};

const MIN_ZOOM = 0.42;
const MAX_ZOOM = 2.05;

type SourceCountMap = Record<EdgeSourceGroup, number>;

function createSourceCountMap(): SourceCountMap {
  return EDGE_SOURCE_GROUPS.reduce(
    (acc, group) => {
      acc[group] = 0;
      return acc;
    },
    {} as SourceCountMap,
  );
}

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

function extractMetaString(meta: GraphNode["meta"] | GraphEdge["meta"], key: string): string | null {
  const value = meta[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === "string" && first.trim().length > 0) return first.trim();
  }
  return null;
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

function nodeColorFor(node: GraphNode): string {
  if (node.type === "interaction") {
    const category =
      typeof node.meta.evidenceCategory === "string"
        ? node.meta.evidenceCategory.toLowerCase()
        : "";
    if (category === "exposure") return "#d97706";
    if (category === "outcome") return "#0f766e";
    if (category === "mechanism") return "#6d5dd3";
  }
  return nodeColors[node.type];
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function GraphCanvas({
  nodes,
  edges,
  layoutRootIds = [],
  selectedNodeId,
  onSelectNode,
  selectedEdgeId = null,
  onSelectEdge,
  highlightedNodeIds,
  highlightedEdgeIds,
  washedNodeIds,
  washedEdgeIds,
  dimUnfocused = true,
  isRunning = false,
  hiddenSummary,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1000);
  const [fullscreen, setFullscreen] = useState(false);
  const [cy, setCy] = useState<Core | null>(null);
  const [dashOffset, setDashOffset] = useState(0);
  const [pathAnchorNodeId, setPathAnchorNodeId] = useState<string | null>(null);
  const [localFocusNodeIds, setLocalFocusNodeIds] = useState<Set<string>>(new Set());
  const [localFocusEdgeIds, setLocalFocusEdgeIds] = useState<Set<string>>(new Set());
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edgeMap = useMemo(() => new Map(edges.map((edge) => [edge.id, edge])), [edges]);
  const validNodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const validEdges = useMemo(
    () =>
      edges.filter(
        (edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target),
      ),
    [edges, validNodeIds],
  );
  const degreeMap = useMemo(() => buildDegreeMap(validEdges), [validEdges]);
  const preferredRootIds = useMemo(() => {
    const deduped = layoutRootIds.filter((id, index, all) => all.indexOf(id) === index);
    const filtered = deduped.filter((id) => validNodeIds.has(id));
    if (filtered.length > 0) return filtered.slice(0, 4);
    const fallback = nodes.find((node) => node.type === "disease")?.id;
    return fallback ? [fallback] : [];
  }, [layoutRootIds, nodes, validNodeIds]);
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
  const focusPulse = useMemo(() => (Math.sin(dashOffset / 2.8) + 1) / 2, [dashOffset]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      setDashOffset((prev) => ((prev - 1) % 80 + 80) % 80);
    }, 120);
    return () => window.clearInterval(timer);
  }, [isRunning]);

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
      ...rankBy("target", 8, "score"),
      ...rankBy("pathway", 6, "degree"),
      ...rankBy("drug", 5, "degree"),
    ]);
  }, [degreeMap, nodes]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const nodeElements = nodes.map((node) => {
      const labelSource = informativeNodeLabel(node);
      const shouldShowLabel =
        node.type === "disease" ||
        selectedNodeId === node.id ||
        activeNodeSet.has(node.id) ||
        (washedNodeIds?.has(node.id) ?? false) ||
        autoLabelNodeIds.has(node.id) ||
        (node.type !== "interaction" && nodes.length <= 16) ||
        (node.type === "target" && nodes.length <= 36) ||
        (node.type === "pathway" && nodes.length <= 24) ||
        (node.type === "drug" && nodes.length <= 24);

      const classes = [
        hasFocusedSubset && !activeNodeSet.has(node.id) ? "is-faded" : "",
        activeNodeSet.has(node.id) ? "is-focused" : "",
        washedNodeIds?.has(node.id) && !activeNodeSet.has(node.id) ? "is-washed" : "",
        selectedNodeId === node.id ? "is-selected" : "",
        node.meta.queryAnchor ? "is-query-anchor" : "",
        typeof node.meta.evidenceCategory === "string"
          ? `evidence-${node.meta.evidenceCategory.toLowerCase()}`
          : "",
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
            node.type === "target" ? 20 : node.type === "pathway" ? 34 : 28,
          ),
          rawSize: nodeSize(node),
          color: nodeColorFor(node),
        },
        classes,
      } satisfies ElementDefinition;
    });

    const edgeElements = validEdges.map((edge) => {
      const sourceGroup = getEdgeSourceGroup(edge);
      const sourceMeta = EDGE_SOURCE_GROUP_META[sourceGroup];
      const showEdgeLabel =
        activeEdgeSet.has(edge.id) ||
        (washedEdgeIds?.has(edge.id) ?? false) ||
        (edge.type === "disease_disease" && typeof edge.meta.status === "string") ||
        typeof edge.meta.bridgeType === "string" ||
        (edge.type !== "target_target" && (edge.weight ?? 0) >= 0.92 && nodes.length <= 60);
      const classes = [
        hasFocusedSubset && !activeEdgeSet.has(edge.id) ? "is-faded" : "",
        activeEdgeSet.has(edge.id) ? "is-focused" : "",
        selectedEdgeId === edge.id ? "is-selected" : "",
        washedEdgeIds?.has(edge.id) && !activeEdgeSet.has(edge.id) ? "is-washed" : "",
        showEdgeLabel ? "label-visible" : "",
        `source-${sourceGroup}`,
      ]
        .filter(Boolean)
        .join(" ");

      return {
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type,
          sourceGroup,
          sourceLabel: sourceMeta.label,
          bridgeStatus:
            typeof edge.meta.status === "string" ? String(edge.meta.status) : "",
          label:
            extractMetaString(edge.meta, "bridgeType") ??
            extractMetaString(edge.meta, "status") ??
            (edge.type === "disease_target"
              ? "association"
              : edge.type === "disease_disease"
                ? "cross-disease hypothesis"
              : edge.type === "target_pathway"
                ? "pathway"
                : edge.type === "target_drug"
                  ? "drug link"
                  : edge.type === "target_target"
                    ? "interaction"
                    : "mechanism link"),
          weight: edge.weight ?? 0.4,
          color: sourceMeta.color ?? edgeColors[edge.type],
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
    selectedEdgeId,
    washedEdgeIds,
    washedNodeIds,
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
          color: "#2f2c66",
          "font-size": 12,
          "font-family": "var(--font-body)",
          "text-wrap": "wrap",
          "text-max-width": 154,
          "min-zoomed-font-size": 8,
          "text-background-color": "#ffffff",
          "text-background-opacity": 0.94,
          "text-background-shape": "roundrectangle",
          "text-background-padding": "2px",
          "text-border-width": 1,
          "text-border-color": "#d1d5f3",
          "text-border-opacity": 0.85,
          "text-margin-y": 14,
          "text-valign": "bottom",
          "border-width": 1.2,
          "border-color": "#ffffff",
          "overlay-opacity": 0,
          "shadow-blur": 10,
          "shadow-opacity": 0.18,
          "shadow-color": "#6675b5",
          "transition-property":
            "background-color, border-color, border-width, opacity, shadow-opacity, shadow-color, text-opacity",
          "transition-duration": "220ms",
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
        selector: "node.evidence-exposure",
        style: {
          shape: "ellipse",
          width: 18,
          height: 18,
          "border-color": "#f6b26b",
          "text-border-color": "#f3d3a3",
        },
      },
      {
        selector: "node.evidence-mechanism",
        style: {
          shape: "round-rectangle",
          width: 17,
          height: 15,
          "border-color": "#b8aff1",
          "text-border-color": "#c9c4f5",
        },
      },
      {
        selector: "node.evidence-outcome",
        style: {
          shape: "diamond",
          width: 17,
          height: 17,
          "border-color": "#91d4c9",
          "text-border-color": "#b4e7df",
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
          "border-color": "#7f5af0",
          "shadow-opacity": 0.34,
          "shadow-color": "#7f5af0",
        },
      },
      {
        selector: "node.is-focused",
        style: {
          "border-width": 2 + focusPulse * 1.6,
          "border-color": "#4f46e5",
          "shadow-opacity": 0.28 + focusPulse * 0.24,
          "shadow-color": "#5a50eb",
          "text-border-color": "#b7bdf3",
        },
      },
      {
        selector: "node.is-query-anchor",
        style: {
          "border-width": 2.2,
          "border-color": "#7f5af0",
          "text-border-color": "#c8bcff",
        },
      },
      {
        selector: "node.is-faded",
        style: {
          opacity: 0.28,
          "text-opacity": 0.42,
        },
      },
      {
        selector: "node.is-washed",
        style: {
          "background-color": "#b7bfd4",
          opacity: 0.84,
          "text-opacity": 1,
          "text-border-color": "#aebad1",
          "text-background-color": "#eef2fb",
          color: "#324262",
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
          "transition-property": "line-color, target-arrow-color, width, opacity, line-style",
          "transition-duration": "220ms",
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
        selector: "edge[type = 'disease_disease']",
        style: {
          "target-arrow-shape": "none",
          "curve-style": "bezier",
          width: "mapData(weight, 0, 1, 1.4, 4.2)",
        },
      },
      {
        selector: "edge.source-opentargets",
        style: {
          "line-color": "#7d88e3",
          "target-arrow-color": "#7d88e3",
        },
      },
      {
        selector: "edge.source-reactome",
        style: {
          "line-color": "#0f9f8c",
          "target-arrow-color": "#0f9f8c",
        },
      },
      {
        selector: "edge.source-chembl",
        style: {
          "line-color": "#8d63dd",
          "target-arrow-color": "#8d63dd",
        },
      },
      {
        selector: "edge.source-string",
        style: {
          "line-color": "#4b6fc7",
          "target-arrow-color": "#4b6fc7",
        },
      },
      {
        selector: "edge.source-literature",
        style: {
          "line-color": "#0d8fa8",
          "target-arrow-color": "#0d8fa8",
          "line-style": "dotted",
        },
      },
      {
        selector: "edge.source-exposure",
        style: {
          "line-color": "#d1732a",
          "target-arrow-color": "#d1732a",
          "line-style": "dashed",
          "line-dash-pattern": [3, 2],
        },
      },
      {
        selector: "edge.source-anchor",
        style: {
          "line-color": "#8f6ae8",
          "target-arrow-color": "#8f6ae8",
        },
      },
      {
        selector: "edge.source-derived",
        style: {
          "line-color": "#6f7ea9",
          "target-arrow-color": "#6f7ea9",
        },
      },
      {
        selector: "edge.source-other",
        style: {
          "line-color": "#99a3c6",
          "target-arrow-color": "#99a3c6",
        },
      },
      {
        selector: "edge[bridgeStatus = 'candidate']",
        style: {
          "line-style": "dashed",
          "line-dash-pattern": [5, 4],
          "line-color": "#8f6ae8",
          "target-arrow-color": "#8f6ae8",
        },
      },
      {
        selector: "edge[bridgeStatus = 'no_connection']",
        style: {
          "line-style": "dashed",
          "line-dash-pattern": [4, 4],
          opacity: 0.62,
          "line-color": "#9f90cb",
          "target-arrow-color": "#9f90cb",
        },
      },
      {
        selector: "edge[bridgeStatus = 'connected']",
        style: {
          "line-style": "solid",
          opacity: 0.96,
          "line-color": "#4f46e5",
          "target-arrow-color": "#4f46e5",
        },
      },
      {
        selector: "edge.is-faded",
        style: {
          opacity: 0.16,
        },
      },
      {
        selector: "edge.is-focused",
        style: {
          opacity: 0.96,
          width: "mapData(weight, 0, 1, 2, 4.6)",
          "line-style": isRunning ? "dashed" : "solid",
          "line-dash-pattern": isRunning ? [8, 4] : [1, 0],
          "line-dash-offset": isRunning ? dashOffset : 0,
          "line-color": "#4f46e5",
          "target-arrow-color": "#4f46e5",
        },
      },
      {
        selector: "edge.is-selected",
        style: {
          "line-color": "#7f5af0",
          "target-arrow-color": "#7f5af0",
          width: "mapData(weight, 0, 1, 2.6, 5.2)",
          opacity: 0.98,
        },
      },
      {
        selector: "edge.is-washed",
        style: {
          "line-color": "#97a1bb",
          "target-arrow-color": "#97a1bb",
          "line-style": "dashed",
          "line-dash-pattern": [4, 6],
          opacity: 0.82,
        },
      },
      {
        selector: "edge.label-visible",
        style: {
          label: "data(label)",
          "font-size": 11,
          "min-zoomed-font-size": 7,
          color: "#35417f",
          "text-background-color": "#f3f2ff",
          "text-background-opacity": 0.92,
          "text-background-shape": "roundrectangle",
          "text-border-width": 0.8,
          "text-border-color": "#d0d2f8",
          "text-border-opacity": 0.9,
          "text-rotation": "autorotate",
        },
      },
    ],
    [dashOffset, focusPulse, isRunning],
  );

  useEffect(() => {
    if (!cy) return;

    const hasMultiRoots = preferredRootIds.length > 1;
    const useBreadth = nodes.length <= 32 || (hasMultiRoots && nodes.length <= 88);

    const layout = cy.layout(
      useBreadth
        ? {
            name: "breadthfirst",
            directed: true,
            animate: true,
            animationDuration: 320,
            fit: true,
            padding: 28,
            spacingFactor: hasMultiRoots ? 1.1 : 0.98,
            roots: preferredRootIds.length > 0 ? preferredRootIds : undefined,
            avoidOverlap: true,
          }
        : {
            name: "cose",
            animate: true,
            animationDuration: 360,
            fit: true,
            padding: 22,
            randomize: false,
            gravity: 0.46,
            componentSpacing: 42,
            idealEdgeLength: (edge: { data: (key: string) => string }) => {
              const type = edge.data("type") as GraphEdge["type"];
              if (type === "disease_target") return 124;
              if (type === "target_pathway") return 108;
              if (type === "target_drug") return 98;
              if (type === "target_target") return 114;
              return 102;
            },
            nodeRepulsion: (node: { data: (key: string) => string }) => {
              const type = node.data("type") as GraphNode["type"];
              if (type === "disease") return 128000;
              if (type === "target") return 88000;
              return 62000;
            },
          },
    );

    layout.on("layoutstop", () => {
      const padding = nodes.length <= 12 ? 26 : nodes.length <= 40 ? 20 : 16;
      cy.fit(undefined, padding);
      const currentZoom = cy.zoom();
      const maxPreferredZoom =
        nodes.length <= 5
          ? 1.05
          : nodes.length <= 12
            ? 1.2
            : nodes.length <= 30
              ? 1.32
              : 1.48;
      const minPreferredZoom =
        nodes.length >= 130
          ? 0.42
          : nodes.length >= 80
            ? 0.48
            : nodes.length >= 40
              ? 0.58
              : 0.66;
      const bounded = Math.max(minPreferredZoom, Math.min(currentZoom, maxPreferredZoom));
      cy.zoom(clampZoom(bounded));
      cy.center();
    });

    layout.run();
    cy.minZoom(MIN_ZOOM);
    cy.maxZoom(MAX_ZOOM);
  }, [cy, layoutSignature, nodes.length, preferredRootIds]);

  useEffect(() => {
    if (!cy) return;

    const onTapBackground = (event: { target: unknown }) => {
      if (event.target !== cy) return;
      setPathAnchorNodeId(null);
      setLocalFocusNodeIds(new Set());
      setLocalFocusEdgeIds(new Set());
      setHoveredNodeId(null);
      setHoveredEdgeId(null);
      onSelectNode(null);
      onSelectEdge?.(null);
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
      setHoveredNodeId(nodeId);
      setHoveredEdgeId(null);
      onSelectNode(nodeMap.get(nodeId) ?? null);
      onSelectEdge?.(null);
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
      setHoveredNodeId(nodeId);
      setHoveredEdgeId(null);
      onSelectNode(nodeMap.get(nodeId) ?? null);
      onSelectEdge?.(null);
    };

    const onTapEdge = (event: { target: { id: () => string } }) => {
      const edgeId = String(event.target.id());
      const edge = edgeMap.get(edgeId) ?? null;
      setHoveredNodeId(null);
      setHoveredEdgeId(edgeId);
      onSelectEdge?.(edge);
      if (edge) {
        setLocalFocusNodeIds(new Set([edge.source, edge.target]));
        setLocalFocusEdgeIds(new Set([edge.id]));
      }
    };

    const onMouseOverNode = (event: { target: { id: () => string } }) => {
      setHoveredEdgeId(null);
      setHoveredNodeId(String(event.target.id()));
    };

    const onMouseOutNode = () => {
      setHoveredNodeId(null);
    };

    const onMouseOverEdge = (event: { target: { id: () => string } }) => {
      setHoveredNodeId(null);
      setHoveredEdgeId(String(event.target.id()));
    };

    const onMouseOutEdge = () => {
      setHoveredEdgeId(null);
    };

    cy.on("tap", onTapBackground);
    cy.on("tap", "node", onTapNode);
    cy.on("tap", "edge", onTapEdge);
    cy.on("cxttap", "node", onRightTapNode);
    cy.on("mouseover", "node", onMouseOverNode);
    cy.on("mouseout", "node", onMouseOutNode);
    cy.on("mouseover", "edge", onMouseOverEdge);
    cy.on("mouseout", "edge", onMouseOutEdge);

    return () => {
      cy.off("tap", onTapBackground);
      cy.off("tap", "node", onTapNode);
      cy.off("tap", "edge", onTapEdge);
      cy.off("cxttap", "node", onRightTapNode);
      cy.off("mouseover", "node", onMouseOverNode);
      cy.off("mouseout", "node", onMouseOutNode);
      cy.off("mouseover", "edge", onMouseOverEdge);
      cy.off("mouseout", "edge", onMouseOutEdge);
    };
  }, [adjacency, cy, edgeMap, nodeMap, onSelectEdge, onSelectNode, pathAnchorNodeId, validEdges]);

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
  const edgeSourceCounts = useMemo(() => {
    const counts = createSourceCountMap();
    for (const edge of validEdges) {
      const group = getEdgeSourceGroup(edge);
      counts[group] += 1;
    }
    return counts;
  }, [validEdges]);
  const edgeSourceLegend = useMemo(
    () =>
      [...EDGE_SOURCE_GROUPS]
        .filter((group) => edgeSourceCounts[group] > 0)
        .sort((left, right) => edgeSourceCounts[right] - edgeSourceCounts[left]),
    [edgeSourceCounts],
  );

  const hoveredNode = useMemo(
    () => (hoveredNodeId ? nodeMap.get(hoveredNodeId) ?? null : null),
    [hoveredNodeId, nodeMap],
  );
  const hoveredEdge = useMemo(
    () => (hoveredEdgeId ? edgeMap.get(hoveredEdgeId) ?? null : null),
    [edgeMap, hoveredEdgeId],
  );
  const hoveredNodeDegree = useMemo(() => {
    if (!hoveredNode) return 0;
    return degreeMap.get(hoveredNode.id) ?? 0;
  }, [degreeMap, hoveredNode]);
  const hoveredNodeFacts = useMemo(() => {
    if (!hoveredNode) {
      return {
        lines: [] as string[],
        note: "No additional annotation available.",
      };
    }

    const incident = validEdges.filter(
      (edge) => edge.source === hoveredNode.id || edge.target === hoveredNode.id,
    );
    const diseaseTargetCount = incident.filter((edge) => edge.type === "disease_target").length;
    const pathwayCount = incident.filter((edge) => edge.type === "target_pathway").length;
    const drugCount = incident.filter((edge) => edge.type === "target_drug").length;
    const interactionCount = incident.filter((edge) => edge.type === "target_target").length;
    const bridgeConnected = incident.filter(
      (edge) =>
        edge.type === "disease_disease" &&
        String(edge.meta.status ?? "").toLowerCase() === "connected",
    ).length;
    const bridgeGaps = incident.filter(
      (edge) =>
        edge.type === "disease_disease" &&
        String(edge.meta.status ?? "").toLowerCase() === "no_connection",
    ).length;

    const lines: string[] = [];
    if (hoveredNode.type === "disease") {
      lines.push(`targets linked: ${diseaseTargetCount}`);
      if (bridgeConnected > 0 || bridgeGaps > 0) {
        lines.push(`anchor bridges: ${bridgeConnected} connected, ${bridgeGaps} gaps`);
      }
      const role = extractMetaString(hoveredNode.meta, "role");
      if (role) {
        lines.push(`anchor role: ${role.replace(/_/g, " ")}`);
      }
    }
    if (hoveredNode.type === "target") {
      lines.push(`pathways: ${pathwayCount}, drugs: ${drugCount}, interactions: ${interactionCount}`);
      const otEvidence = readNumber(hoveredNode.meta.openTargetsEvidence ?? hoveredNode.score);
      if (otEvidence !== null) {
        lines.push(`OpenTargets evidence: ${otEvidence.toFixed(2)}`);
      }
      const articleCount = readNumber(hoveredNode.meta.articleCount);
      const trialCount = readNumber(hoveredNode.meta.trialCount);
      if (articleCount !== null || trialCount !== null) {
        lines.push(`literature snippets: ${articleCount ?? 0} articles, ${trialCount ?? 0} trials`);
      }
    }
    if (hoveredNode.type === "pathway") {
      lines.push(`connected targets: ${incident.filter((edge) => edge.type === "target_pathway").length}`);
    }
    if (hoveredNode.type === "drug") {
      lines.push(`connected targets: ${incident.filter((edge) => edge.type === "target_drug").length}`);
    }

    const note =
      extractMetaString(hoveredNode.meta, "note") ??
      extractMetaString(hoveredNode.meta, "description") ??
      "No additional annotation available.";
    return { lines, note };
  }, [hoveredNode, validEdges]);
  const hoveredEdgeSourceLabel = hoveredEdge ? nodeMap.get(hoveredEdge.source)?.label ?? hoveredEdge.source : null;
  const hoveredEdgeTargetLabel = hoveredEdge ? nodeMap.get(hoveredEdge.target)?.label ?? hoveredEdge.target : null;
  const hoveredEdgeFacts = useMemo(() => {
    if (!hoveredEdge) return [] as string[];
    const facts: string[] = [];
    const sourceGroup = getEdgeSourceGroup(hoveredEdge);
    const sourceMeta = EDGE_SOURCE_GROUP_META[sourceGroup];
    facts.push(`evidence lane: ${sourceMeta.label}`);
    const sharedTargets = hoveredEdge.meta.sharedTargets;
    if (Array.isArray(sharedTargets) && sharedTargets.length > 0) {
      const symbols = sharedTargets
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
        .slice(0, 4);
      if (symbols.length > 0) {
        facts.push(`shared intermediates: ${symbols.join(", ")}`);
      }
    }
    const sourceTag = extractMetaString(hoveredEdge.meta, "source");
    if (sourceTag) {
      facts.push(`source: ${sourceTag}`);
    }
    const bridgeType = extractMetaString(hoveredEdge.meta, "bridgeType");
    if (bridgeType) {
      facts.push(`bridge type: ${bridgeType}`);
    }
    const bridgeVia = extractMetaString(hoveredEdge.meta, "bridgeVia");
    if (bridgeVia) {
      facts.push(`via: ${bridgeVia}`);
    }
    const status = extractMetaString(hoveredEdge.meta, "status");
    if (status) {
      facts.push(`status: ${status}`);
    }
    return facts;
  }, [hoveredEdge]);

  const densityBoost = nodes.length > 24 ? Math.min(220, (nodes.length - 24) * 5) : 0;
  const baseCanvasHeight = Math.max(380, Math.floor(width * 0.48) + densityBoost);
  const canvasHeight = fullscreen
    ? Math.max(420, Math.floor((typeof window !== "undefined" ? window.innerHeight : 900) - 48))
    : Math.min(760, baseCanvasHeight);

  return (
    <div
      ref={containerRef}
      className={
        fullscreen
          ? "fixed inset-0 z-40 rounded-none border-0 bg-[#efeeff] p-3"
          : "relative min-h-[360px] overflow-hidden rounded-xl border border-[#cdd2f7] bg-[radial-gradient(circle_at_18%_18%,#ffffff_0%,#f3f1ff_42%,#eceaff_100%)] shadow-[0_22px_64px_rgba(79,70,229,0.16)]"
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
          className="border-[#d5dbf4] bg-white text-[#4649a2] hover:bg-[#f1f2ff]"
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
          className="border-[#d5dbf4] bg-white text-[#4649a2] hover:bg-[#f1f2ff]"
        >
          <Camera className="h-4 w-4" />
        </Button>

        <Button
          size="icon"
          variant="secondary"
          onClick={() => setFullscreen((prev) => !prev)}
          className="border-[#d5dbf4] bg-white text-[#4649a2] hover:bg-[#f1f2ff]"
        >
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>

      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-xl border border-[#d5dbf4] bg-white/94 px-3 py-2 text-[11px] text-[#4f5f8e] backdrop-blur">
        <div className="mb-1 font-semibold text-[#454ca2]">Live Graph</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <span>Disease: {nodeCounts.disease ?? 0}</span>
          <span>Targets: {nodeCounts.target ?? 0}</span>
          <span>Pathways: {nodeCounts.pathway ?? 0}</span>
          <span>Drugs: {nodeCounts.drug ?? 0}</span>
          <span>Interactions: {nodeCounts.interaction ?? 0}</span>
          <span>Edges: {validEdges.length}</span>
        </div>
        {edgeSourceLegend.length > 0 ? (
          <div className="mt-1.5 flex max-w-[270px] flex-wrap gap-1">
            {edgeSourceLegend.map((group) => (
              <span
                key={group}
                className="inline-flex items-center gap-1 rounded-full border border-[#d7dcf5] bg-[#f4f6ff] px-1.5 py-0.5 text-[9px] text-[#5a6597]"
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: EDGE_SOURCE_GROUP_META[group].color }}
                />
                {EDGE_SOURCE_GROUP_META[group].label} {edgeSourceCounts[group]}
              </span>
            ))}
          </div>
        ) : null}
        {hiddenSummary && hiddenSummary.hiddenEdges > 0 ? (
          <div className="mt-1 rounded-md border border-[#d5dbf4] bg-[#f2f4ff] px-2 py-1 text-[10px] text-[#4f5f8e]">
            +{hiddenSummary.hiddenEdges} more edges hidden ({hiddenSummary.lens} lens)
          </div>
        ) : null}
        {isRunning ? (
          <div className="mt-1 flex items-center gap-1.5 text-[10px] font-medium text-[#454ca2]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#5146d9] animate-pulse" />
            Live stream active
          </div>
        ) : null}
        <div className="mt-1.5 flex items-center gap-2 text-[9px] text-[#59629a]">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#4f46e5]" />
            active path
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#bbc1d4]" />
            washed branch
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#8f6ae8]" />
            bridge edge
          </span>
        </div>
        <div className="mt-1 text-[9px] text-[#616aa3]">
          Animated dashed edges = currently explored branch.
        </div>
      </div>

      {hoveredNode ? (
        <div className="pointer-events-none absolute right-3 top-14 z-20 max-w-[360px] rounded-xl border border-[#d5dbf4] bg-white/95 p-2.5 text-[11px] text-[#3f4a77] shadow-[0_18px_40px_rgba(57,64,130,0.2)] backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-[#434aa1]">{informativeNodeLabel(hoveredNode)}</div>
            <span className="rounded-full border border-[#d4d9f3] bg-[#f2f4ff] px-1.5 py-0.5 text-[10px] text-[#5a628f]">
              {hoveredNode.type}
            </span>
          </div>
          <div className="mt-1 text-[#5a638f]">{hoveredNodeFacts.note}</div>
          {hoveredNodeFacts.lines.length > 0 ? (
            <div className="mt-1 space-y-0.5 text-[10px] text-[#5f6ba1]">
              {hoveredNodeFacts.lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
          <div className="mt-1 text-[10px] text-[#6670a1]">
            neighborhood degree: {hoveredNodeDegree}
          </div>
          <div className="mt-1 text-[10px] text-[#6670a1]">
            id: {hoveredNode.primaryId}
            {extractMetaString(hoveredNode.meta, "source")
              ? ` • source: ${extractMetaString(hoveredNode.meta, "source")}`
              : ""}
          </div>
        </div>
      ) : null}

      {hoveredEdge ? (
        <div className="pointer-events-none absolute right-3 top-14 z-20 max-w-[360px] rounded-xl border border-[#d5dbf4] bg-white/95 p-2.5 text-[11px] text-[#3f4a77] shadow-[0_18px_40px_rgba(57,64,130,0.2)] backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-[#434aa1]">
              {hoveredEdgeSourceLabel} → {hoveredEdgeTargetLabel}
            </div>
            <span className="rounded-full border border-[#d4d9f3] bg-[#f2f4ff] px-1.5 py-0.5 text-[10px] text-[#5a628f]">
              {hoveredEdge.type}
            </span>
          </div>
          <div className="mt-1 text-[#5a638f]">
            {extractMetaString(hoveredEdge.meta, "note") ??
              extractMetaString(hoveredEdge.meta, "source") ??
              "Mechanistic edge candidate."}
          </div>
          {hoveredEdgeFacts.length > 0 ? (
            <div className="mt-1 space-y-0.5 text-[10px] text-[#5f6ba1]">
              {hoveredEdgeFacts.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
          <div className="mt-1 text-[10px] text-[#6670a1]">
            weight: {(hoveredEdge.weight ?? 0).toFixed(3)}
            {extractMetaString(hoveredEdge.meta, "status")
              ? ` • status: ${extractMetaString(hoveredEdge.meta, "status")}`
              : ""}
          </div>
        </div>
      ) : null}

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
          <div className="rounded-full border border-[#d5dbf4] bg-white px-4 py-2 text-xs font-medium text-[#454ca2]">
            Building core network...
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-[#d5dbf4] bg-white/94 px-2.5 py-1.5 text-[10px] text-[#4f5f8e]">
        Hover: node/edge evidence • Right-click: neighborhood focus • Shift-click two nodes: shortest path
      </div>
    </div>
  );
}
