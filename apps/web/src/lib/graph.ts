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
  const targetPathways = new Map<string, Array<{ pathwayId: string; value: number }>>();
  const targetDrugs = new Map<string, Array<{ drugId: string; value: number }>>();
  const diseaseTarget = new Map<string, Array<{ targetId: string; value: number }>>();

  const readableLabel = (node: GraphNode): string => {
    const displayName =
      typeof node.meta.displayName === "string" && node.meta.displayName.trim().length > 0
        ? node.meta.displayName.trim()
        : undefined;
    const targetSymbol =
      typeof node.meta.targetSymbol === "string" && node.meta.targetSymbol.trim().length > 0
        ? node.meta.targetSymbol.trim()
        : undefined;

    if (node.type === "target") {
      return targetSymbol ?? displayName ?? node.label;
    }
    if (node.type === "pathway") {
      return displayName ?? node.label;
    }
    if (node.type === "drug") {
      return displayName ?? node.label;
    }
    return displayName ?? node.label;
  };

  for (const edge of edges) {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    if (!["disease_target", "target_pathway", "target_drug"].includes(edge.type)) continue;

    rows.push({
      source: readableLabel(sourceNode),
      target: readableLabel(targetNode),
      value: edge.weight ?? 0.5,
      sourceType: sourceNode.type,
      targetType: targetNode.type,
    });

    if (edge.type === "disease_target") {
      diseaseTarget.set(sourceNode.id, [
        ...(diseaseTarget.get(sourceNode.id) ?? []),
        { targetId: targetNode.id, value: edge.weight ?? 0.5 },
      ]);
    }

    if (edge.type === "target_pathway") {
      targetPathways.set(sourceNode.id, [
        ...(targetPathways.get(sourceNode.id) ?? []),
        { pathwayId: targetNode.id, value: edge.weight ?? 0.5 },
      ]);
    }

    if (edge.type === "target_drug") {
      targetDrugs.set(sourceNode.id, [
        ...(targetDrugs.get(sourceNode.id) ?? []),
        { drugId: targetNode.id, value: edge.weight ?? 0.5 },
      ]);
    }
  }

  const syntheticPathwayDrug = new Map<string, SankeyRow>();
  const syntheticDiseasePathway = new Map<string, SankeyRow>();

  for (const [targetId, pathways] of targetPathways.entries()) {
    const drugs = targetDrugs.get(targetId) ?? [];
    for (const pathway of pathways.slice(0, 8)) {
      for (const drug of drugs.slice(0, 8)) {
        const pathwayNode = nodeMap.get(pathway.pathwayId);
        const drugNode = nodeMap.get(drug.drugId);
        if (!pathwayNode || !drugNode) continue;

        const value = Math.min(pathway.value, drug.value) * 0.8;
        const key = `${pathwayNode.id}=>${drugNode.id}`;
        const existing = syntheticPathwayDrug.get(key);

        if (existing) {
          existing.value += value;
        } else {
          syntheticPathwayDrug.set(key, {
            source: readableLabel(pathwayNode),
            target: readableLabel(drugNode),
            value,
            sourceType: "pathway",
            targetType: "drug",
          });
        }
      }
    }
  }

  for (const [diseaseId, targets] of diseaseTarget.entries()) {
    for (const target of targets) {
      const pathways = targetPathways.get(target.targetId) ?? [];
      for (const pathway of pathways.slice(0, 8)) {
        const diseaseNode = nodeMap.get(diseaseId);
        const pathwayNode = nodeMap.get(pathway.pathwayId);
        if (!diseaseNode || !pathwayNode) continue;

        const value = Math.min(target.value, pathway.value) * 0.85;
        const key = `${diseaseNode.id}=>${pathwayNode.id}`;
        const existing = syntheticDiseasePathway.get(key);
        if (existing) {
          existing.value += value;
        } else {
          syntheticDiseasePathway.set(key, {
            source: readableLabel(diseaseNode),
            target: readableLabel(pathwayNode),
            value,
            sourceType: "disease",
            targetType: "pathway",
          });
        }
      }
    }
  }

  const enriched = [
    ...rows,
    ...[...syntheticDiseasePathway.values()].sort((a, b) => b.value - a.value).slice(0, 40),
    ...[...syntheticPathwayDrug.values()].sort((a, b) => b.value - a.value).slice(0, 80),
  ];

  return enriched.sort((a, b) => b.value - a.value).slice(0, 260);
}
