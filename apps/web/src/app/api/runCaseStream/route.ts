import { NextRequest } from "next/server";
import type { GraphEdge, GraphNode, RankingResponse } from "@/lib/contracts";
import { buildEvidenceTable } from "@/components/targetgraph/evidence";
import { rankTargetsFallback } from "@/server/openai/ranking";
import { searchDiseases } from "@/server/mcp/opentargets";
import {
  chooseBestDiseaseCandidate,
  type DiseaseCandidate,
} from "@/server/openai/disease-resolver";

export const runtime = "nodejs";

type RunMode = "fast" | "balanced" | "deep";

type SourceHealth = Record<string, "green" | "yellow" | "red">;

type CaseStatusEvent = {
  phase: string;
  message: string;
  pct: number;
  elapsedMs: number;
  counts: Record<string, number>;
  sourceHealth: SourceHealth;
  partial?: boolean;
};

type GraphPatchEvent = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
};

const encoder = new TextEncoder();
const diseaseIdPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;
const phaseNarratives: Record<string, string> = {
  P0: "Resolved disease entity and initialized the case graph.",
  P1: "Scoring disease-associated targets from OpenTargets.",
  P2: "Mapping selected targets to Reactome pathways.",
  P3: "Linking target-associated compounds and activities.",
  P4: "Adding STRING interaction context around seeded targets.",
  P5: "Enriching targets with literature and trial snippets.",
  P6: "Ranking targets and assembling recommendation brief.",
};

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function modeConfig(mode: RunMode) {
  if (mode === "fast") {
    return {
      maxTargets: 6,
      pathways: 1,
      drugs: 1,
      interactions: 0,
      literature: 0,
    };
  }
  if (mode === "deep") {
    return {
      maxTargets: 15,
      pathways: 1,
      drugs: 1,
      interactions: 1,
      literature: 1,
    };
  }

  return {
    maxTargets: 10,
    pathways: 1,
    drugs: 1,
    interactions: 1,
    literature: 0,
  };
}

function compactText(value: string, max = 110): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function derivePathUpdate(nodeMap: Map<string, GraphNode>, edgeMap: Map<string, GraphEdge>) {
  const disease = [...nodeMap.values()].find((node) => node.type === "disease");
  if (!disease) return null;

  const diseaseEdges = [...edgeMap.values()]
    .filter((edge) => edge.type === "disease_target" && edge.source === disease.id)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  const topTargetEdge = diseaseEdges[0];
  if (!topTargetEdge) {
    return {
      nodeIds: [disease.id],
      edgeIds: [],
      summary: `${disease.label} resolved. Building target evidence...`,
    };
  }

  const targetId = topTargetEdge.target;
  const target = nodeMap.get(targetId);
  if (!target) return null;

  const topPathwayEdge = [...edgeMap.values()]
    .filter((edge) => edge.type === "target_pathway" && edge.source === targetId)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];

  const topDrugEdge = [...edgeMap.values()]
    .filter((edge) => edge.type === "target_drug" && edge.source === targetId)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];

  const nodeIds = new Set<string>([disease.id, targetId]);
  const edgeIds = new Set<string>([topTargetEdge.id]);
  let summary = `${disease.label} -> ${target.label}`;

  if (topPathwayEdge) {
    nodeIds.add(topPathwayEdge.target);
    edgeIds.add(topPathwayEdge.id);
    const pathway = nodeMap.get(topPathwayEdge.target);
    if (pathway) summary += ` -> ${pathway.label}`;
  }

  if (topDrugEdge) {
    nodeIds.add(topDrugEdge.target);
    edgeIds.add(topDrugEdge.id);
    const drug = nodeMap.get(topDrugEdge.target);
    if (drug) summary += ` -> ${drug.label}`;
  }

  return {
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
    summary,
  };
}

function generateBriefSections(options: {
  ranking: RankingResponse | null;
  nodeMap: Map<string, GraphNode>;
  edgeMap: Map<string, GraphEdge>;
  sourceHealth: SourceHealth;
}) {
  const { ranking, nodeMap, edgeMap, sourceHealth } = options;
  const nodes = [...nodeMap.values()];
  const edges = [...edgeMap.values()];

  const evidenceRows = buildEvidenceTable(nodes, edges);
  const rankingInputRows = evidenceRows.map((row) => ({
    id: row.targetId,
    symbol: row.symbol,
    pathwayIds: row.pathwayIds,
    openTargetsEvidence: row.openTargetsEvidence,
    drugActionability: row.drugActionability,
    networkCentrality: row.networkCentrality,
    literatureSupport: row.literatureSupport,
    drugCount: row.drugCount,
    interactionCount: row.interactionCount,
    articleCount: row.articleCount,
    trialCount: row.trialCount,
  }));
  const resolvedRanking =
    ranking ?? (rankingInputRows.length > 0 ? rankTargetsFallback(rankingInputRows) : null);

  if (!resolvedRanking) {
    return {
      recommendation: null,
      alternatives: [],
      evidenceTrace: [],
      caveats: ["No ranked target evidence available yet."],
      nextActions: [
        "Increase run depth or retry with more specific disease phrasing.",
        "Inspect source health to identify degraded inputs.",
      ],
    };
  }

  const top = resolvedRanking.rankedTargets[0];
  const pathways = top?.pathwayHooks ?? [];
  const dataGaps = resolvedRanking.systemSummary.dataGaps;

  const alternatives = resolvedRanking.rankedTargets.slice(1, 6).map((item) => ({
    symbol: item.symbol,
    score: item.score,
    reason: item.reasons[0] ?? "not provided",
    caveat: item.caveats[0] ?? "not provided",
  }));

  const evidenceTrace = resolvedRanking.rankedTargets.slice(0, 8).map((item) => ({
    symbol: item.symbol,
    score: item.score,
    refs: item.evidenceRefs,
  }));

  const degradedSources = Object.entries(sourceHealth)
    .filter(([, health]) => health !== "green")
    .map(([source]) => source);

  const caveats = [
    ...(top?.caveats?.slice(0, 2) ?? []),
    ...dataGaps.slice(0, 2),
    ...(degradedSources.length > 0
      ? [`Degraded inputs during this run: ${degradedSources.join(", ")}.`] 
      : []),
  ];

  const nextActions = [
    `Validate perturbation of ${top?.symbol ?? "top target"} in pathway-relevant assay.`,
    "Compare top 3 alternatives for tractability and mechanistic orthogonality.",
    "Run Deep mode for richer interaction and literature context before program decision.",
  ];

  return {
    recommendation: {
      target: top?.symbol ?? "not provided",
      score: top?.score ?? 0,
      why: top?.reasons?.[0] ?? "not provided",
      pathway: pathways[0] ?? "not provided",
      drugHook: top?.drugHooks?.[0] ?? "not provided",
      interactionHook: top?.interactionHooks?.[0] ?? "not provided",
    },
    alternatives,
    evidenceTrace,
    caveats,
    nextActions,
  };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const query = params.get("query")?.trim();
  const mode = (params.get("mode")?.trim().toLowerCase() as RunMode | null) ?? "balanced";
  const diseaseIdHint = params.get("diseaseId")?.trim();

  if (!query) {
    return new Response("Missing query", { status: 400 });
  }

  const streamState = { closed: false };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      const nodeMap = new Map<string, GraphNode>();
      const edgeMap = new Map<string, GraphEdge>();
      let ranking: RankingResponse | null = null;
      let sourceHealth: SourceHealth = {
        opentargets: "green",
        reactome: "green",
        string: "green",
        chembl: "green",
        biomcp: "green",
        openai: "green",
      };
      let lastPathSignature = "";

      const emit = (event: string, data: unknown) => {
        if (streamState.closed) return;
        try {
          controller.enqueue(encodeEvent(event, data));
        } catch {
          streamState.closed = true;
        }
      };

      const close = () => {
        if (streamState.closed) return;
        streamState.closed = true;
        try {
          controller.close();
        } catch {
          // no-op
        }
      };

      try {
        emit("status", {
          phase: "P0",
          message: "Resolving disease entity",
          pct: 2,
        });

        const candidates: DiseaseCandidate[] = (await searchDiseases(query, 12))
          .filter((item) => diseaseIdPattern.test(item.id))
          .map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
          }));

        emit("resolver_candidates", {
          query,
          candidates,
        });

        const chosen =
          diseaseIdHint && candidates.find((item) => item.id === diseaseIdHint)
            ? {
                selected: candidates.find((item) => item.id === diseaseIdHint)!,
                rationale: "User-selected disease entity.",
              }
            : await chooseBestDiseaseCandidate(query, candidates);

        emit("resolver_selected", {
          query,
          selected: chosen.selected,
          rationale: chosen.rationale,
          candidates,
        });

        const profile = modeConfig(mode);
        const internalParams = new URLSearchParams({
          diseaseQuery: chosen.selected.name,
          diseaseId: chosen.selected.id,
          maxTargets: String(profile.maxTargets),
          pathways: String(profile.pathways),
          drugs: String(profile.drugs),
          interactions: String(profile.interactions),
          literature: String(profile.literature),
        });

        const internalUrl = new URL(`/api/streamGraph?${internalParams.toString()}`, request.url);
        const response = await fetch(internalUrl, {
          cache: "no-store",
          headers: {
            Accept: "text/event-stream",
          },
        });

        if (!response.ok || !response.body) {
          throw new Error(`streamGraph unavailable: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let splitIdx = buffer.indexOf("\n\n");
          while (splitIdx !== -1) {
            const block = buffer.slice(0, splitIdx);
            buffer = buffer.slice(splitIdx + 2);
            splitIdx = buffer.indexOf("\n\n");

            const parsed = parseSseBlock(block);
            if (!parsed) continue;

            try {
              const payload = JSON.parse(parsed.data) as unknown;

              if (parsed.event === "status") {
                const status = payload as CaseStatusEvent;
                sourceHealth = status.sourceHealth ?? sourceHealth;

                emit("status", {
                  phase: status.phase,
                  message: status.message,
                  pct: status.pct,
                  elapsedMs: status.elapsedMs,
                  partial: status.partial ?? false,
                  counts: status.counts,
                  sourceHealth: status.sourceHealth,
                });

                emit("agent_step", {
                  phase: status.phase,
                  title: phaseNarratives[status.phase] ?? status.message,
                  detail:
                    status.counts && Object.keys(status.counts).length > 0
                      ? Object.entries(status.counts)
                          .map(([key, val]) => `${key}:${val}`)
                          .join(" • ")
                      : "streaming",
                });
              } else if (parsed.event === "partial_graph") {
                const graph = payload as GraphPatchEvent;
                for (const node of graph.nodes) {
                  nodeMap.set(node.id, node);
                }
                for (const edge of graph.edges) {
                  edgeMap.set(edge.id, edge);
                }

                emit("graph_patch", graph);

                const pathUpdate = derivePathUpdate(nodeMap, edgeMap);
                if (pathUpdate) {
                  const signature = `${pathUpdate.nodeIds.join("|")}::${pathUpdate.edgeIds.join("|")}`;
                  if (signature !== lastPathSignature) {
                    lastPathSignature = signature;
                    emit("path_update", {
                      ...pathUpdate,
                      summary: compactText(pathUpdate.summary, 150),
                    });
                  }
                }
              } else if (parsed.event === "ranking") {
                ranking = payload as RankingResponse;
                const top = ranking.rankedTargets[0];
                emit("brief_section", {
                  section: "recommendation",
                  data: {
                    target: top?.symbol ?? "not provided",
                    score: top?.score ?? 0,
                    why: top?.reasons?.[0] ?? "Ranking still stabilizing.",
                    caveat: top?.caveats?.[0] ?? "not provided",
                  },
                });
              } else if (parsed.event === "error") {
                emit("error", payload);
              } else if (parsed.event === "done") {
                const brief = generateBriefSections({
                  ranking,
                  nodeMap,
                  edgeMap,
                  sourceHealth,
                });

                emit("brief_section", {
                  section: "final_brief",
                  data: brief,
                });

                emit("status", {
                  phase: "P6",
                  message: "Build complete",
                  pct: 100,
                  elapsedMs: Date.now() - startedAt,
                  partial: false,
                  counts: {
                    nodes: nodeMap.size,
                    edges: edgeMap.size,
                  },
                  sourceHealth,
                });

                emit("done", payload);
              }
            } catch {
              // ignore malformed internal event payloads
            }
          }
        }

        close();
      } catch (error) {
        emit("error", {
          phase: "fatal",
          message: error instanceof Error ? error.message : "unknown error",
          recoverable: false,
        });
        close();
      }
    },
    cancel() {
      streamState.closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
