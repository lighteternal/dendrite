"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Core as CytoscapeCore } from "cytoscape";
import CytoscapeComponent from "react-cytoscapejs";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
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

const nodeColor: Record<GraphNode["type"], string> = {
  disease: "#ef4444",
  target: "#5b57e6",
  pathway: "#07b4d8",
  drug: "#f08b2e",
  interaction: "#8b95b5",
};

const edgeColor: Record<GraphEdge["type"], string> = {
  disease_target: "#9aa2bf",
  target_pathway: "#2aa4d4",
  target_drug: "#f08b2e",
  target_target: "#7b50f2",
  pathway_drug: "#22a4b9",
};

function readableLabel(node: GraphNode): string {
  const displayName =
    typeof node.meta.displayName === "string" && node.meta.displayName.trim().length > 0
      ? node.meta.displayName
      : undefined;
  const symbol =
    typeof node.meta.targetSymbol === "string" && node.meta.targetSymbol.trim().length > 0
      ? node.meta.targetSymbol
      : undefined;

  if (node.type === "target") return symbol ?? node.label;
  return displayName ?? node.label;
}

function compactLabel(label: string, type: GraphNode["type"]): string {
  const max = type === "target" ? 18 : type === "disease" ? 28 : 20;
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

export function PathFirstGraph({
  nodes,
  edges,
  pathUpdate,
  showPathwayContext,
  showDrugContext,
  showInteractionContext,
  onSelectNode,
}: Props) {
  const cyRef = useRef<CytoscapeCore | null>(null);

  const computed = useMemo(() => {
    const focusNodeIds = new Set(pathUpdate?.nodeIds ?? []);
    const focusEdgeIds = new Set(pathUpdate?.edgeIds ?? []);

    if (focusNodeIds.size === 0) {
      const disease = nodes.find((node) => node.type === "disease");
      if (disease) focusNodeIds.add(disease.id);

      const topEdges = [...edges]
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
        .slice(0, 14);
      for (const edge of topEdges) {
        focusEdgeIds.add(edge.id);
        focusNodeIds.add(edge.source);
        focusNodeIds.add(edge.target);
      }
    }

    const primaryTargetIds = new Set<string>();
    for (const edge of edges) {
      if (edge.type !== "disease_target") continue;
      if (focusEdgeIds.has(edge.id)) {
        primaryTargetIds.add(edge.target);
      }
    }

    if (primaryTargetIds.size === 0) {
      for (const edge of edges) {
        if (edge.type !== "disease_target") continue;
        primaryTargetIds.add(edge.target);
        if (primaryTargetIds.size >= 3) break;
      }
    }

    const contextualEdges: GraphEdge[] = [];
    for (const edge of edges) {
      if (focusEdgeIds.has(edge.id)) {
        contextualEdges.push(edge);
        continue;
      }

      if (showPathwayContext && edge.type === "target_pathway" && primaryTargetIds.has(edge.source)) {
        contextualEdges.push(edge);
      }

      if (showDrugContext && edge.type === "target_drug" && primaryTargetIds.has(edge.source)) {
        contextualEdges.push(edge);
      }

      if (
        showInteractionContext &&
        edge.type === "target_target" &&
        (primaryTargetIds.has(edge.source) || primaryTargetIds.has(edge.target))
      ) {
        contextualEdges.push(edge);
      }
    }

    const rankedContextEdges = contextualEdges
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, 110);

    const visibleNodeIds = new Set<string>();
    for (const edge of rankedContextEdges) {
      visibleNodeIds.add(edge.source);
      visibleNodeIds.add(edge.target);
    }
    for (const id of focusNodeIds) {
      visibleNodeIds.add(id);
    }

    const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
    const visibleEdges = rankedContextEdges;

    const degree = new Map<string, number>();
    for (const edge of visibleEdges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const elements = [
      ...visibleNodes.map((node) => {
        const label = readableLabel(node);
        const nodeDegree = degree.get(node.id) ?? 0;
        const isFocus = focusNodeIds.has(node.id);
        const isPrimaryTarget = primaryTargetIds.has(node.id);
        const showLabel =
          isFocus ||
          node.type === "disease" ||
          (node.type === "target" && (isPrimaryTarget || Number(node.score ?? 0) >= 0.7)) ||
          nodeDegree >= 7;

        return {
          data: {
            id: node.id,
            label: showLabel ? compactLabel(label, node.type) : "",
            fullLabel: label,
            type: node.type,
            score: Number(node.score ?? 0),
            degree: nodeDegree,
            importance: isFocus ? 1 : showLabel ? 0.75 : 0.2,
            isFocus: isFocus ? 1 : 0,
          },
        };
      }),
      ...visibleEdges.map((edge) => ({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type,
          weight: Number(edge.weight ?? 0.4),
          isFocus: focusEdgeIds.has(edge.id) ? 1 : 0,
        },
      })),
    ];

    return {
      elements,
      visibleNodes,
      visibleEdges,
      hiddenCount: Math.max(0, edges.length - visibleEdges.length),
    };
  }, [
    edges,
    nodes,
    pathUpdate?.edgeIds,
    pathUpdate?.nodeIds,
    showDrugContext,
    showInteractionContext,
    showPathwayContext,
  ]);

  const layoutSignature = `${computed.visibleNodes.length}-${computed.visibleEdges.length}-${pathUpdate?.summary ?? "idle"}`;

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.resize();
    if (cy.elements().length === 0) return;

    const layout = cy.layout({
      name: "cose",
      fit: true,
      animate: false,
      randomize: false,
      componentSpacing: 140,
      idealEdgeLength: 120,
      edgeElasticity: 120,
      nodeRepulsion: 680000,
      gravity: 26,
      numIter: 900,
      padding: 36,
    });
    layout.run();
    cy.fit(cy.elements(), 34);
  }, [layoutSignature]);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#dfdbff] bg-[#f8f7ff] px-3 py-2 text-xs text-[#554f98]">
        <div className="font-medium text-[#352f7a]">
          {pathUpdate?.summary ?? "Building top mechanism path from streamed evidence..."}
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

      <div className="rounded-xl border border-[#d7d2ff] bg-white p-2">
        <CytoscapeComponent
          elements={computed.elements}
          cy={(cy) => {
            cyRef.current = cy;
            cy.off("tap");
            cy.on("tap", "node", (event) => {
              onSelectNode?.(String(event.target.id()));
            });
            cy.on("tap", (event) => {
              if (event.target === cy) {
                onSelectNode?.(null);
              }
            });
          }}
          style={{ width: "100%", height: "460px" }}
          layout={{ name: "preset" }}
          stylesheet={[
            {
              selector: "node",
              style: {
                "background-color": "#b4b8d4",
                label: "data(label)",
                color: "#302a71",
                "font-size": "mapData(importance, 0, 1, 8, 12)",
                "font-weight": 600,
                "min-zoomed-font-size": 9,
                "text-wrap": "none",
                "text-valign": "bottom",
                "text-halign": "center",
                "text-margin-y": 10,
                "text-background-color": "#ffffff",
                "text-background-opacity": 0.9,
                "text-background-padding": 2,
                width: "mapData(score, 0, 1, 14, 40)",
                height: "mapData(score, 0, 1, 14, 40)",
                opacity: "mapData(importance, 0, 1, 0.72, 1)",
                "border-width": 1.4,
                "border-color": "#ffffff",
                "overlay-opacity": 0,
              },
            },
            {
              selector: 'node[type = "disease"]',
              style: {
                "background-color": nodeColor.disease,
                shape: "ellipse",
                width: 48,
                height: 48,
                "font-size": 11,
              },
            },
            {
              selector: 'node[type = "target"]',
              style: {
                "background-color": nodeColor.target,
                shape: "round-rectangle",
              },
            },
            {
              selector: 'node[type = "pathway"]',
              style: {
                "background-color": nodeColor.pathway,
                shape: "round-hexagon",
              },
            },
            {
              selector: 'node[type = "drug"]',
              style: {
                "background-color": nodeColor.drug,
                shape: "diamond",
              },
            },
            {
              selector: 'node[type = "interaction"]',
              style: {
                "background-color": nodeColor.interaction,
                shape: "ellipse",
              },
            },
            {
              selector: "edge",
              style: {
                width: "mapData(weight, 0, 1, 1, 4)",
                "line-color": "#c6c9dd",
                "curve-style": "bezier",
                opacity: 0.72,
              },
            },
            {
              selector: 'edge[type = "disease_target"]',
              style: {
                "line-color": edgeColor.disease_target,
              },
            },
            {
              selector: 'edge[type = "target_pathway"]',
              style: {
                "line-color": edgeColor.target_pathway,
              },
            },
            {
              selector: 'edge[type = "target_drug"]',
              style: {
                "line-color": edgeColor.target_drug,
              },
            },
            {
              selector: 'edge[type = "target_target"]',
              style: {
                "line-color": edgeColor.target_target,
              },
            },
            {
              selector: 'edge[type = "pathway_drug"]',
              style: {
                "line-color": edgeColor.pathway_drug,
              },
            },
            {
              selector: "node[isFocus = 1]",
              style: {
                "border-width": 2.5,
                "border-color": "#f08b2e",
                "shadow-blur": 15,
                "shadow-color": "#7d64f4",
                "shadow-opacity": 0.36,
                opacity: 1,
              },
            },
            {
              selector: "edge[isFocus = 1]",
              style: {
                width: 4.2,
                opacity: 1,
              },
            },
          ]}
        />
      </div>

      {computed.hiddenCount > 0 ? (
        <div className="rounded-md border border-[#f3d1ab] bg-[#fff7ec] px-3 py-2 text-[11px] text-[#8f5b2d]">
          +{computed.hiddenCount} additional edges hidden by default for readability.
        </div>
      ) : null}
    </div>
  );
}
