import { NextRequest } from "next/server";
import type { GraphEdge, GraphNode, RankingResponse } from "@/lib/contracts";
import { buildEvidenceTable } from "@/components/targetgraph/evidence";
import { rankTargetsFallback } from "@/server/openai/ranking";
import { searchDiseases } from "@/server/mcp/opentargets";
import {
  inferDiseaseFromQuery,
  resolveSemanticConcepts,
} from "@/server/entity/semantic-entity-mapper";
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

function extractDiseasePhrase(query: string): string {
  let value = query.toLowerCase().trim();
  value = value.replace(/^(for|in|about|regarding)\s+/, "");

  const splitters = [
    ",",
    "?",
    " what ",
    " which ",
    " where ",
    " when ",
    " how ",
    " with ",
    " showing ",
    " after ",
    " given ",
    " refractory to ",
    " resistant to ",
    " treated with ",
    " failed ",
    " relapse ",
    " progressing on ",
  ];

  for (const splitter of splitters) {
    const idx = value.indexOf(splitter);
    if (idx > 0) {
      value = value.slice(0, idx).trim();
    }
  }

  return value
    .replace(/\s+/g, " ")
    .trim();
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
  semanticConceptMentions: string[];
  semanticTargetSymbols: string[];
  hasInterventionConcept: boolean;
}) {
  const {
    ranking,
    nodeMap,
    edgeMap,
    sourceHealth,
    semanticConceptMentions,
    semanticTargetSymbols,
    hasInterventionConcept,
  } = options;
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

  const semanticTargetSet = new Set(
    semanticTargetSymbols.map((value) => value.toUpperCase()),
  );
  const boostedRanking = [...resolvedRanking.rankedTargets]
    .map((item) => ({
      item,
      boost: semanticTargetSet.has(item.symbol.toUpperCase()) ? 0.06 : 0,
    }))
    .sort((a, b) => b.item.score + b.boost - (a.item.score + a.boost))
    .map((row, index) => ({
      ...row.item,
      rank: index + 1,
    }));

  const baselineTop = boostedRanking[0];
  const matchedQueryTarget = boostedRanking.find((item) =>
    semanticTargetSet.has(item.symbol.toUpperCase()),
  );

  const shouldAnchorToQuery =
    hasInterventionConcept &&
    !!matchedQueryTarget &&
    (matchedQueryTarget.score >= 0.32 || matchedQueryTarget.rank <= 12) &&
    (baselineTop?.score ?? 0) - matchedQueryTarget.score <= 0.26;

  const selectedTop = shouldAnchorToQuery ? matchedQueryTarget : baselineTop;

  const pathways = selectedTop?.pathwayHooks ?? [];
  const dataGaps = resolvedRanking.systemSummary.dataGaps;

  const alternatives = boostedRanking
    .filter((item) => item.symbol !== selectedTop?.symbol)
    .slice(0, 5)
    .map((item) => ({
      symbol: item.symbol,
      score: item.score,
      reason: item.reasons[0] ?? "not provided",
      caveat: item.caveats[0] ?? "not provided",
    }));

  const evidenceTrace = boostedRanking.slice(0, 8).map((item) => ({
    symbol: item.symbol,
    score: item.score,
    refs: item.evidenceRefs,
  }));

  const degradedSources = Object.entries(sourceHealth)
    .filter(([, health]) => health !== "green")
    .map(([source]) => source);

  const caveats = [
    ...(selectedTop?.caveats?.slice(0, 2) ?? []),
    ...(shouldAnchorToQuery &&
    matchedQueryTarget &&
    baselineTop &&
    matchedQueryTarget.symbol !== baselineTop.symbol
      ? [
          `Query-anchored recommendation selected (${matchedQueryTarget.symbol}) while baseline top was ${baselineTop.symbol}; compare both before nomination.`,
        ]
      : []),
    ...(semanticTargetSet.size > 0 &&
    selectedTop &&
    !semanticTargetSet.has(selectedTop.symbol.toUpperCase())
      ? [
          `Query concept mismatch: requested target/intervention mentions (${semanticConceptMentions.join(
            ", ",
          )}) were not top-ranked in this disease graph.`,
        ]
      : []),
    ...dataGaps.slice(0, 2),
    ...(degradedSources.length > 0
      ? [`Degraded inputs during this run: ${degradedSources.join(", ")}.`] 
      : []),
  ];

  const nextActions = [
    `Validate perturbation of ${selectedTop?.symbol ?? "top target"} in pathway-relevant assay.`,
    "Compare top 3 alternatives for tractability and mechanistic orthogonality.",
    "Run Deep mode for richer interaction and literature context before program decision.",
  ];

  const queryAlignment: {
    status: "matched" | "anchored" | "mismatch" | "none";
    requestedMentions: string[];
    requestedTargetSymbols: string[];
    matchedTarget?: string;
    baselineTop?: string;
    note: string;
  } = semanticConceptMentions.length
    ? semanticTargetSet.size > 0
      ? matchedQueryTarget
        ? shouldAnchorToQuery
          ? {
              status: matchedQueryTarget.symbol === baselineTop?.symbol ? "matched" : "anchored",
              requestedMentions: semanticConceptMentions,
              requestedTargetSymbols: [...semanticTargetSet],
              matchedTarget: matchedQueryTarget.symbol,
              baselineTop: baselineTop?.symbol,
              note:
                matchedQueryTarget.symbol === baselineTop?.symbol
                  ? `Query concept aligns with the strongest ranked target (${matchedQueryTarget.symbol}).`
                  : `Recommendation anchored to query concept target (${matchedQueryTarget.symbol}) with explicit caveats.`,
            }
          : {
              status: "mismatch",
              requestedMentions: semanticConceptMentions,
              requestedTargetSymbols: [...semanticTargetSet],
              matchedTarget: matchedQueryTarget.symbol,
              baselineTop: baselineTop?.symbol,
              note: `Requested concept target (${matchedQueryTarget.symbol}) was found but not selected as top recommendation.`,
            }
        : {
            status: "mismatch",
            requestedMentions: semanticConceptMentions,
            requestedTargetSymbols: [...semanticTargetSet],
            baselineTop: baselineTop?.symbol,
            note: "Requested concept target was not present in ranked disease evidence.",
          }
      : {
          status: "none",
          requestedMentions: semanticConceptMentions,
          requestedTargetSymbols: [],
          baselineTop: baselineTop?.symbol,
          note: "No explicit target-level concept extracted from query.",
        }
    : {
        status: "none",
        requestedMentions: [],
        requestedTargetSymbols: [],
        baselineTop: baselineTop?.symbol,
        note: "No semantic query concepts extracted.",
      };

  return {
    recommendation: {
      target: selectedTop?.symbol ?? "not provided",
      score: selectedTop?.score ?? 0,
      why: selectedTop?.reasons?.[0] ?? "not provided",
      pathway: pathways[0] ?? "not provided",
      drugHook: selectedTop?.drugHooks?.[0] ?? "not provided",
      interactionHook: selectedTop?.interactionHooks?.[0] ?? "not provided",
    },
    alternatives,
    evidenceTrace,
    caveats,
    nextActions,
    queryAlignment,
  };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const query = params.get("query")?.trim();
  const mode = (params.get("mode")?.trim().toLowerCase() as RunMode | null) ?? "balanced";
  const diseaseIdHint = params.get("diseaseId")?.trim();
  const diseaseNameHint = params.get("diseaseName")?.trim();

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
          const semanticConceptPromise = resolveSemanticConcepts(query).catch(
            () => [],
          );

          emit("status", {
            phase: "P0",
            message: "Resolving disease entity",
          pct: 2,
        });

        let candidates: DiseaseCandidate[] = (await searchDiseases(query, 12))
          .filter((item) => diseaseIdPattern.test(item.id))
          .map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
          }));

        if (candidates.length === 0) {
          const narrowedQuery = extractDiseasePhrase(query);
          if (narrowedQuery.length >= 2 && narrowedQuery !== query.toLowerCase().trim()) {
            candidates = (await searchDiseases(narrowedQuery, 12))
              .filter((item) => diseaseIdPattern.test(item.id))
              .map((item) => ({
                id: item.id,
                name: item.name,
                description: item.description,
              }));
          }
        }

        if (candidates.length === 0) {
          const inferred = await inferDiseaseFromQuery(query);
          if (inferred) {
            candidates = [
              {
                id: inferred.id,
                name: inferred.name,
              },
            ];
          }
        }

        emit("resolver_candidates", {
          query,
          candidates,
        });

        const semanticConceptsEarly = await Promise.race([
          semanticConceptPromise,
          new Promise<Awaited<ReturnType<typeof resolveSemanticConcepts>>>((resolve) =>
            setTimeout(() => resolve([]), 1200),
          ),
        ]);
        const semanticDisease = semanticConceptsEarly.find(
          (concept) =>
            concept.selected?.entityType === "disease" &&
            concept.selected.id &&
            diseaseIdPattern.test(concept.selected.id) &&
            (concept.selected.score ?? 0) >= 2.2,
        )?.selected;

        let chosen:
          | {
              selected: DiseaseCandidate;
              rationale: string;
            }
          | undefined;

        if (diseaseIdHint) {
          const pinned =
            candidates.find((item) => item.id === diseaseIdHint) ??
            (diseaseNameHint
              ? {
                  id: diseaseIdHint,
                  name: diseaseNameHint,
                }
              : null);

          if (pinned) {
            chosen = {
              selected: pinned,
              rationale: "User-pinned disease entity.",
            };
          }
        }

        if (!chosen) {
          if (semanticDisease) {
            const semanticMatch =
              candidates.find((item) => item.id === semanticDisease.id) ??
              ({
                id: semanticDisease.id,
                name: semanticDisease.name,
                description: semanticDisease.description,
              } satisfies DiseaseCandidate);
            chosen = {
              selected: semanticMatch,
              rationale: "Selected via semantic disease concept mapping.",
            };
          }
        }

        if (!chosen) {
          if (candidates.length === 0) {
            throw new Error("No disease candidates found for query.");
          }
          chosen = await chooseBestDiseaseCandidate(query, candidates);
        }

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
                const semanticConcepts = await semanticConceptPromise;
                const semanticTargetSymbols = semanticConcepts
                  .filter(
                    (concept) =>
                      concept.selected?.entityType === "target" &&
                      concept.selected?.name,
                  )
                  .map((concept) => concept.selected!.name);
                const semanticConceptMentions = semanticConcepts
                  .filter(
                    (concept) =>
                      concept.type === "target" ||
                      concept.type === "drug" ||
                      concept.type === "intervention",
                  )
                  .map((concept) => concept.mention);
                const hasInterventionConcept = semanticConcepts.some(
                  (concept) => concept.type === "intervention",
                );

                const brief = generateBriefSections({
                  ranking,
                  nodeMap,
                  edgeMap,
                  sourceHealth,
                  semanticConceptMentions,
                  semanticTargetSymbols,
                  hasInterventionConcept,
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
