import type { GraphEdge } from "@/lib/contracts";

export const EDGE_SOURCE_GROUPS = [
  "opentargets",
  "reactome",
  "chembl",
  "string",
  "literature",
  "exposure",
  "anchor",
  "derived",
  "other",
] as const;

export type EdgeSourceGroup = (typeof EDGE_SOURCE_GROUPS)[number];

export const EDGE_SOURCE_GROUP_META: Record<
  EdgeSourceGroup,
  { label: string; color: string }
> = {
  opentargets: { label: "OpenTargets", color: "#7d88e3" },
  reactome: { label: "Reactome", color: "#0f9f8c" },
  chembl: { label: "ChEMBL", color: "#8d63dd" },
  string: { label: "STRING", color: "#4b6fc7" },
  literature: { label: "Literature", color: "#0d8fa8" },
  exposure: { label: "Exposure lane", color: "#d1732a" },
  anchor: { label: "Query anchor", color: "#8f6ae8" },
  derived: { label: "Derived", color: "#6f7ea9" },
  other: { label: "Other", color: "#99a3c6" },
};

const SOURCE_HINTS: Array<{ group: EdgeSourceGroup; hints: string[] }> = [
  { group: "opentargets", hints: ["opentargets", "open targets"] },
  { group: "reactome", hints: ["reactome", "pathway"] },
  { group: "chembl", hints: ["chembl"] },
  { group: "string", hints: ["string", "interaction"] },
  { group: "literature", hints: ["pubmed", "biomcp", "trial", "article", "paper"] },
  {
    group: "exposure",
    hints: ["evidence", "exposure", "outcome", "mechanism_entity", "literature_entity"],
  },
  { group: "anchor", hints: ["query_anchor", "query_gap"] },
  { group: "derived", hints: ["query_bridge", "agent", "planner"] },
];

function asSourceHint(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().toLowerCase();
  }
  if (Array.isArray(value) && value.length > 0) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        return item.trim().toLowerCase();
      }
    }
  }
  return null;
}

function matchSourceHint(sourceHint: string | null): EdgeSourceGroup | null {
  if (!sourceHint) return null;
  for (const row of SOURCE_HINTS) {
    if (row.hints.some((hint) => sourceHint.includes(hint))) {
      return row.group;
    }
  }
  return null;
}

function inferByType(edge: GraphEdge): EdgeSourceGroup {
  if (edge.type === "disease_target") return "opentargets";
  if (edge.type === "target_pathway") return "reactome";
  if (edge.type === "target_drug") return "chembl";
  if (edge.type === "target_target") return "string";
  if (edge.type === "disease_disease") return "anchor";
  return "other";
}

export function getEdgeSourceGroup(edge: GraphEdge): EdgeSourceGroup {
  const direct = asSourceHint(edge.meta.source);
  const byDirect = matchSourceHint(direct);
  if (byDirect) return byDirect;

  const alternate = asSourceHint(edge.meta.sourceName ?? edge.meta.provider ?? edge.meta.sourceTag);
  const byAlternate = matchSourceHint(alternate);
  if (byAlternate) return byAlternate;

  return inferByType(edge);
}
