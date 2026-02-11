import type { GraphEdge, GraphNode, SankeyRow } from "@/lib/contracts";

export function makeNodeId(type: GraphNode["type"], primaryId: string): string {
  return `${type}:${primaryId}`;
}

export function makeEdgeId(
  sourceId: string,
  targetId: string,
  edgeType: GraphEdge["type"],
): string {
  return `${sourceId}→${targetId}:${edgeType}`;
}

export function normalizeScore(value: number | undefined | null): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toSankeyRows(nodes: GraphNode[], edges: GraphEdge[]): SankeyRow[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const rows: SankeyRow[] = [];

  for (const edge of edges) {
    if (!["disease_target", "target_pathway", "target_drug"].includes(edge.type)) {
      continue;
    }
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    rows.push({
      source: sourceNode.label,
      target: targetNode.label,
      value: edge.weight ?? 0.5,
      sourceType: sourceNode.type,
      targetType: targetNode.type,
    });
  }

  return rows;
}
