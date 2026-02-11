"use client";

import { useMemo } from "react";
import { ResponsiveSankey } from "@nivo/sankey";
import type { SankeyRow } from "@/lib/contracts";

type Props = {
  rows: SankeyRow[];
  onBandClick?: (source: string, target: string) => void;
};

type FlowNode = {
  id: string;
  label: string;
  displayLabel: string;
  type: string;
};

type FlowLink = {
  source: string;
  target: string;
  value: number;
};

const typeColor: Record<string, string> = {
  disease: "#e11d48",
  target: "#1d4ed8",
  pathway: "#0f766e",
  drug: "#c2410c",
  interaction: "#64748b",
};

function truncateLabel(value: string, max = 30): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function MechanismSankey({ rows, onBandClick }: Props) {
  const { nodes, links, topFlows } = useMemo(() => {
    const aggregated = new Map<string, SankeyRow>();

    for (const row of rows) {
      if (!row.source || !row.target) continue;
      if (!Number.isFinite(row.value) || row.value <= 0) continue;
      if (row.source === row.target) continue;

      const key = `${row.sourceType}:${row.source}=>${row.targetType}:${row.target}`;
      const existing = aggregated.get(key);
      if (existing) {
        existing.value += row.value;
      } else {
        aggregated.set(key, { ...row });
      }
    }

    const ranked = [...aggregated.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, 28);

    const nodesById = new Map<string, FlowNode>();
    const links: FlowLink[] = [];

    for (const row of ranked) {
      const sourceId = `${row.sourceType}:${row.source}`;
      const targetId = `${row.targetType}:${row.target}`;

      nodesById.set(sourceId, {
        id: sourceId,
        label: row.source,
        displayLabel: truncateLabel(row.source),
        type: row.sourceType,
      });
      nodesById.set(targetId, {
        id: targetId,
        label: row.target,
        displayLabel: truncateLabel(row.target),
        type: row.targetType,
      });

      links.push({
        source: sourceId,
        target: targetId,
        value: Math.max(0.1, row.value),
      });
    }

    return {
      nodes: [...nodesById.values()],
      links,
      topFlows: ranked.slice(0, 8),
    };
  }, [rows]);

  if (nodes.length === 0 || links.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-[#c8daf7] bg-[#f9fbff] text-sm text-[#5d7da4]">
        Mechanism trail becomes available after target-pathway and target-drug links stream in.
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="h-[360px] rounded-xl border border-[#c8daf7] bg-[#fbfdff] p-2">
        <ResponsiveSankey
          data={{
            nodes,
            links,
          }}
          margin={{ top: 18, right: 110, bottom: 18, left: 110 }}
          align="justify"
          sort="descending"
          colors={(node) => typeColor[(node as { type?: string }).type ?? "interaction"] ?? "#64748b"}
          nodeOpacity={0.96}
          nodeBorderWidth={1}
          nodeBorderColor="#dbe8fb"
          nodeThickness={14}
          nodeSpacing={18}
          linkOpacity={0.46}
          linkHoverOpacity={0.82}
          linkBlendMode="multiply"
          enableLinkGradient
          label={(node) => String((node as { displayLabel?: string }).displayLabel ?? "")}
          labelPosition="outside"
          labelOrientation="horizontal"
          labelPadding={12}
          labelTextColor="#23476f"
          animate
          motionConfig="gentle"
          onClick={(item) => {
            const link = item as {
              source?: { id?: string };
              target?: { id?: string };
            };
            if (!link.source?.id || !link.target?.id) return;

            const sourceLabel = link.source.id.split(":").slice(1).join(":");
            const targetLabel = link.target.id.split(":").slice(1).join(":");
            if (sourceLabel && targetLabel) {
              onBandClick?.(sourceLabel, targetLabel);
            }
          }}
          linkTooltip={(item) => {
            const link = item as {
              source?: { id?: string };
              target?: { id?: string };
              value?: number;
            };
            const sourceLabel = link.source?.id?.split(":").slice(1).join(":") ?? "unknown";
            const targetLabel = link.target?.id?.split(":").slice(1).join(":") ?? "unknown";
            return (
              <div className="rounded-md border border-[#cadcf7] bg-white px-2 py-1 text-xs text-[#16385f] shadow-md">
                <div className="font-semibold">{sourceLabel} → {targetLabel}</div>
                <div>flow score: {(link.value ?? 0).toFixed(2)}</div>
              </div>
            );
          }}
          theme={{
            tooltip: {
              container: {
                background: "transparent",
                boxShadow: "none",
              },
            },
            labels: {
              text: {
                fill: "#274b74",
                fontSize: 11,
              },
            },
          }}
        />
      </div>

      <aside className="rounded-xl border border-[#c8daf7] bg-[#fbfdff] p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#587ca5]">
          Top Mechanism Flows
        </div>
        <div className="space-y-2">
          {topFlows.map((flow, index) => (
            <button
              key={`${flow.sourceType}-${flow.source}-${flow.targetType}-${flow.target}`}
              type="button"
              className="w-full rounded-lg border border-[#d6e4f9] bg-white px-2.5 py-2 text-left text-xs text-[#23446c] transition hover:bg-[#eef5ff]"
              onClick={() => onBandClick?.(flow.source, flow.target)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">#{index + 1}</span>
                <span className="text-[#5d7da2]">{flow.value.toFixed(2)}</span>
              </div>
              <div className="mt-1 line-clamp-2">
                {truncateLabel(flow.source, 26)} → {truncateLabel(flow.target, 26)}
              </div>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
