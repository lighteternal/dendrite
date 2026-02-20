import type { GraphEdge, GraphNode } from "@/lib/contracts";

export type EvidenceRow = {
  targetId: string;
  symbol: string;
  pathwayIds: string[];
  openTargetsEvidence: number;
  drugActionability: number;
  networkCentrality: number;
  literatureSupport: number;
  drugCount: number;
  interactionCount: number;
  articleCount: number;
  trialCount: number;
};

export function buildEvidenceTable(nodes: GraphNode[], edges: GraphEdge[]): EvidenceRow[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const targetNodes = nodes.filter((node) => node.type === "target");

  const pathwayByTarget = new Map<string, Set<string>>();
  const drugCountByTarget = new Map<string, number>();
  const interactionByTarget = new Map<string, number>();

  for (const edge of edges) {
    if (edge.type === "target_pathway") {
      const set = pathwayByTarget.get(edge.source) ?? new Set<string>();
      const pathwayNode = nodeMap.get(edge.target);
      if (pathwayNode) set.add(pathwayNode.primaryId);
      pathwayByTarget.set(edge.source, set);
    }

    if (edge.type === "target_drug") {
      drugCountByTarget.set(edge.source, (drugCountByTarget.get(edge.source) ?? 0) + 1);
    }

    if (edge.type === "target_target") {
      if (nodeMap.get(edge.source)?.type === "target") {
        interactionByTarget.set(
          edge.source,
          (interactionByTarget.get(edge.source) ?? 0) + 1,
        );
      }
      if (nodeMap.get(edge.target)?.type === "target") {
        interactionByTarget.set(
          edge.target,
          (interactionByTarget.get(edge.target) ?? 0) + 1,
        );
      }
    }
  }

  const maxDrug = Math.max(1, ...[...drugCountByTarget.values(), 1]);
  const maxInteraction = Math.max(1, ...[...interactionByTarget.values(), 1]);

  return targetNodes.map((targetNode) => {
    const drugCount = drugCountByTarget.get(targetNode.id) ?? 0;
    const interactionCount = interactionByTarget.get(targetNode.id) ?? 0;

    const articleCount = Number(targetNode.meta.articleCount ?? 0);
    const trialCount = Number(targetNode.meta.trialCount ?? 0);

    return {
      targetId: targetNode.primaryId,
      symbol: targetNode.label,
      pathwayIds: [...(pathwayByTarget.get(targetNode.id) ?? new Set())],
      openTargetsEvidence: Number(targetNode.meta.openTargetsEvidence ?? targetNode.score ?? 0),
      drugActionability: Math.min(1, drugCount / maxDrug),
      networkCentrality: Math.min(1, interactionCount / maxInteraction),
      literatureSupport: Math.min(1, (articleCount + trialCount) / 10),
      drugCount,
      interactionCount,
      articleCount,
      trialCount,
    };
  });
}
