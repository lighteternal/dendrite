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
    const aggregated = new Map<string, SankeyRow>();
    for (const row of rows) {
      if (!row.source || !row.target) continue;
      const value = Number(row.value);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (row.source === row.target) continue;

      const key = `${row.sourceType}:${row.source}=>${row.targetType}:${row.target}`;
      const existing = aggregated.get(key);
      if (existing) {
        existing.value += value;
      } else {
        aggregated.set(key, { ...row, value });
      }
    }

    const safeRows = [...aggregated.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, 90);

    if (safeRows.length === 0) {
      return {
        nodes: [] as Array<{ name: string; type: string; x0?: number; x1?: number; y0?: number; y1?: number }>,
        links: [] as Array<Link>,
      };
    }

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

    for (const row of safeRows) {
      const source = getNodeIndex(row.source, row.sourceType);
      const target = getNodeIndex(row.target, row.targetType);
      links.push({ source, target, value: Math.max(0.1, row.value) });
    }

    if (nodes.length > 45) {
      const allowed = new Set<number>(
        links
          .slice(0, 80)
          .flatMap((link) => [link.source, link.target])
          .slice(0, 45),
      );
      const remap = new Map<number, number>();
      const cappedNodes: Array<{ name: string; type: string }> = [];

      [...allowed].forEach((oldIdx) => {
        remap.set(oldIdx, cappedNodes.length);
        cappedNodes.push(nodes[oldIdx]!);
      });

      const cappedLinks = links
        .filter((link) => allowed.has(link.source) && allowed.has(link.target))
        .map((link) => ({
          source: remap.get(link.source)!,
          target: remap.get(link.target)!,
          value: link.value,
        }));

      nodes.splice(0, nodes.length, ...cappedNodes);
      links.splice(0, links.length, ...cappedLinks);
    }

    const sankey = d3Sankey<{ name: string; type: string }, { value: number }>()
      .nodeWidth(14)
      .nodePadding(10)
      .extent([
        [0, 0],
        [width - 20, height - 20],
      ]);

    try {
      return sankey({
        nodes: nodes.map((n) => ({ ...n })),
        links: links.map((l) => ({ ...l })),
      });
    } catch {
      return {
        nodes: [] as Array<{ name: string; type: string; x0?: number; x1?: number; y0?: number; y1?: number }>,
        links: [] as Array<Link>,
      };
    }
  }, [rows]);

  return (
    <div className="w-full overflow-x-auto rounded-md border border-white/10 bg-[#0a1320] p-2">
      {layout.nodes.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed border-white/15 bg-[#0e192a] text-xs text-[#89a4bf]">
          Mechanism trail appears once pathway-target edges are available.
        </div>
      ) : null}
      <svg
        width={width}
        height={height}
        className={`max-w-full ${layout.nodes.length === 0 ? "hidden" : "block"}`}
      >
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
