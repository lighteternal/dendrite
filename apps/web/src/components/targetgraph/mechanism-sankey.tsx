"use client";

import { useMemo } from "react";
import { sankey as d3Sankey, sankeyLinkHorizontal } from "d3-sankey";
import type { SankeyLinkMinimal } from "d3-sankey";
import type { SankeyRow } from "@/lib/contracts";

type Props = {
  rows: SankeyRow[];
  onBandClick?: (source: string, target: string) => void;
};

type Link = SankeyLinkMinimal<{ name: string; type: string }, { value: number }>;

export function MechanismSankey({ rows, onBandClick }: Props) {
  const width = 980;
  const height = 240;

  const layout = useMemo(() => {
    const nodeIndex = new Map<string, number>();
    const nodes: Array<{ name: string; type: string }> = [];
    const links: Array<{ source: number; target: number; value: number }> = [];

    const getNodeIndex = (name: string, type: string) => {
      const key = `${type}:${name}`;
      if (!nodeIndex.has(key)) {
        nodeIndex.set(key, nodes.length);
        nodes.push({ name, type });
      }
      return nodeIndex.get(key)!;
    };

    for (const row of rows.slice(0, 120)) {
      const source = getNodeIndex(row.source, row.sourceType);
      const target = getNodeIndex(row.target, row.targetType);
      links.push({ source, target, value: Math.max(0.1, row.value) });
    }

    const sankey = d3Sankey<{ name: string; type: string }, { value: number }>()
      .nodeWidth(14)
      .nodePadding(10)
      .extent([
        [0, 0],
        [width - 20, height - 20],
      ]);

    return sankey({ nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) });
  }, [rows]);

  return (
    <div className="w-full overflow-x-auto rounded-md border border-white/10 bg-[#0a1320] p-2">
      <svg width={width} height={height} className="max-w-full">
        <g transform="translate(10,10)">
          {layout.links.map((link, idx) => (
            <path
              key={`link-${idx}`}
              d={sankeyLinkHorizontal()(link as Link) ?? ""}
              stroke="#7ab6ff"
              strokeOpacity={0.5}
              strokeWidth={Math.max(1, link.width ?? 1)}
              fill="none"
              className="cursor-pointer transition hover:stroke-[#ff9f43] hover:stroke-opacity-90"
              onClick={() => {
                const src = typeof link.source === "object" ? link.source.name : "";
                const tgt = typeof link.target === "object" ? link.target.name : "";
                if (src && tgt) onBandClick?.(src, tgt);
              }}
            />
          ))}

          {layout.nodes.map((node, idx) => (
            <g key={`node-${idx}`}>
              <rect
                x={node.x0}
                y={node.y0}
                width={Math.max(1, (node.x1 ?? 0) - (node.x0 ?? 0))}
                height={Math.max(1, (node.y1 ?? 0) - (node.y0 ?? 0))}
                fill="#2fbf9d"
                fillOpacity={0.7}
                stroke="#94ffe2"
                strokeWidth={1}
                rx={2}
              />
              <text
                x={(node.x1 ?? 0) + 6}
                y={((node.y0 ?? 0) + (node.y1 ?? 0)) / 2}
                fontSize={10}
                dominantBaseline="middle"
                fill="#d6ebff"
              >
                {node.name}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
