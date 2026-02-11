"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CytoscapeComponent from "react-cytoscapejs";
import type cytoscape from "cytoscape";
import { Camera, Maximize2, Minimize2 } from "lucide-react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { Button } from "@/components/ui/button";

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (node: GraphNode | null) => void;
  highlightedNodeIds?: Set<string>;
  highlightedEdgeIds?: Set<string>;
};

const styles = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      color: "#dff0ff",
      "font-size": 10,
      "text-wrap": "wrap",
      "text-max-width": 100,
      "background-color": "#6ca2ff",
      "border-color": "#e8f5ff",
      "border-width": 1,
      width: "mapData(size, 12, 80, 16, 54)",
      height: "mapData(size, 12, 80, 16, 54)",
      "text-halign": "center",
      "text-valign": "center",
      "overlay-opacity": 0,
      "shadow-blur": "mapData(score, 0, 1, 3, 26)",
      "shadow-color": "#7dd3fc",
      "shadow-opacity": 0.7,
    },
  },
  {
    selector: 'node[type = "disease"]',
    style: {
      shape: "ellipse",
      "background-color": "#ff6f59",
      "font-weight": 700,
      "font-size": 11,
      "shadow-color": "#ff8d7b",
    },
  },
  {
    selector: 'node[type = "target"]',
    style: {
      shape: "round-rectangle",
      "background-color": "#35a7ff",
      "shadow-color": "#9fd9ff",
    },
  },
  {
    selector: 'node[type = "pathway"]',
    style: {
      shape: "round-tag",
      "background-color": "#2ebfa5",
      color: "#06382f",
      "font-size": 9,
      "shadow-color": "#61f2d0",
    },
  },
  {
    selector: 'node[type = "drug"]',
    style: {
      shape: "diamond",
      "background-color": "#ffd166",
      color: "#5b3c00",
      "font-size": 9,
      "shadow-color": "#ffe5a3",
    },
  },
  {
    selector: 'node[type = "interaction"]',
    style: {
      shape: "hexagon",
      "background-color": "#b8c1ec",
      color: "#1f2540",
      "font-size": 8,
      "shadow-color": "#d7dcf6",
    },
  },
  {
    selector: "edge",
    style: {
      width: "mapData(weight, 0, 1, 1, 6)",
      "line-color": "#84a6c8",
      "curve-style": "bezier",
      opacity: 0.7,
      "target-arrow-shape": "none",
      "overlay-opacity": 0,
    },
  },
  {
    selector: 'edge[type = "target_drug"]',
    style: {
      "line-color": "#f3bd4e",
    },
  },
  {
    selector: 'edge[type = "target_pathway"]',
    style: {
      "line-color": "#3dd6b9",
    },
  },
  {
    selector: ".faded",
    style: {
      opacity: 0.08,
    },
  },
  {
    selector: ".highlighted",
    style: {
      opacity: 1,
      "line-color": "#f77f00",
      "background-color": "#fb8500",
      "shadow-blur": 36,
      "shadow-opacity": 1,
      "z-index": 9999,
    },
  },
  {
    selector: ".selected",
    style: {
      "border-width": 3,
      "border-color": "#ffbe0b",
    },
  },
];

export function GraphCanvas({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  highlightedNodeIds,
  highlightedEdgeIds,
}: Props) {
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [pathAnchorNodeId, setPathAnchorNodeId] = useState<string | null>(null);

  const nodeLookup = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const elements = useMemo(
    () => [
      ...nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.label,
          type: node.type,
          score: node.score ?? 0,
          size: node.size ?? 18,
        },
      })),
      ...edges.map((edge) => ({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type,
          weight: edge.weight ?? 0.4,
        },
      })),
    ],
    [nodes, edges],
  );

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.off("tap", "node");
    cy.off("cxttap", "node");

    cy.on("tap", "node", (event) => {
      const node = event.target;
      const nodeId = node.id();

      if ((event.originalEvent as MouseEvent).shiftKey && pathAnchorNodeId) {
        const source = cy.getElementById(pathAnchorNodeId);
        const target = cy.getElementById(nodeId);
        if (source.nonempty() && target.nonempty()) {
          const dij = cy.elements().dijkstra({
            root: source,
          });
          const path = dij.pathTo(target);
          cy.elements().removeClass("highlighted");
          cy.elements().addClass("faded");
          path.removeClass("faded");
          path.addClass("highlighted");
        }
        setPathAnchorNodeId(null);
      } else if ((event.originalEvent as MouseEvent).shiftKey && !pathAnchorNodeId) {
        setPathAnchorNodeId(nodeId);
      } else {
        setPathAnchorNodeId(null);
        onSelectNode(nodeLookup.get(nodeId) ?? null);
      }
    });

    cy.on("cxttap", "node", (event) => {
      const node = event.target;
      const neighborhood = node.closedNeighborhood();
      cy.elements().addClass("faded");
      neighborhood.removeClass("faded");
      neighborhood.addClass("highlighted");
      onSelectNode(nodeLookup.get(node.id()) ?? null);
    });
  }, [nodeLookup, onSelectNode, pathAnchorNodeId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().removeClass("selected");
    cy.elements().removeClass("faded");

    if (selectedNodeId) {
      cy.getElementById(selectedNodeId).addClass("selected");
    }

    if ((highlightedNodeIds?.size ?? 0) > 0 || (highlightedEdgeIds?.size ?? 0) > 0) {
      cy.elements().addClass("faded");
      highlightedNodeIds?.forEach((id) => {
        cy.getElementById(id).removeClass("faded");
        cy.getElementById(id).addClass("highlighted");
      });
      highlightedEdgeIds?.forEach((id) => {
        cy.getElementById(id).removeClass("faded");
        cy.getElementById(id).addClass("highlighted");
      });
    }
  }, [selectedNodeId, highlightedNodeIds, highlightedEdgeIds]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const layout = cy.layout({
      name: "cose",
      animate: true,
      animationDuration: 600,
      fit: true,
      padding: 36,
      nodeRepulsion: 12000,
      idealEdgeLength: 120,
      edgeElasticity: 80,
    });

    layout.run();
  }, [elements]);

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-40 bg-[#050a10] p-4"
          : "relative h-full min-h-[460px] rounded-lg border border-white/10 bg-[#09111c]"
      }
    >
      <div className="absolute right-2 top-2 z-20 flex items-center gap-2">
        <Button
          size="icon"
          variant="secondary"
          onClick={() => {
            const cy = cyRef.current;
            if (!cy) return;
            const png = cy.png({ full: true, scale: 2, bg: "#050a10" });
            const a = document.createElement("a");
            a.href = png;
            a.download = "targetgraph-network.png";
            a.click();
          }}
        >
          <Camera className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="secondary" onClick={() => setFullscreen((prev) => !prev)}>
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>
      <CytoscapeComponent
        elements={elements}
        stylesheet={styles}
        style={{ width: "100%", height: "100%" }}
        cy={(cy) => {
          cyRef.current = cy;
        }}
      />
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-[#07101a]/90 p-2 text-[10px] text-[#89a8c5]">
        Right-click node: focus neighborhood • Shift-click 2 nodes: shortest path
      </div>
    </div>
  );
}
