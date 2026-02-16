import { NextRequest } from "next/server";
import {
  type GraphEdge,
  type GraphNode,
  type SourceName,
  type StreamEventPayload,
} from "@/lib/contracts";
import {
  chunkArray,
  makeEdgeId,
  makeNodeId,
  normalizeScore,
  sleep,
  toSankeyRows,
} from "@/lib/graph";
import { getLiteratureAndTrials } from "@/server/mcp/biomcp";
import { getTargetActivityDrugs } from "@/server/mcp/chembl";
import {
  getDiseaseTargetsSummary,
  getKnownDrugsForTarget,
  searchDiseases,
  searchTargets,
} from "@/server/mcp/opentargets";
import { findPathwaysByGene } from "@/server/mcp/reactome";
import { getInteractionNetwork } from "@/server/mcp/stringdb";
import { rankTargets, rankTargetsFallback } from "@/server/openai/ranking";
import { appConfig, assertRuntimeConfig } from "@/server/config";
import { encodeSseEvent, randomInt } from "@/server/pipeline/sse";
import {
  endRequestLog,
  errorRequestLog,
  startRequestLog,
  stepRequestLog,
} from "@/server/telemetry";
import {
  beginOpenAiRun,
  withOpenAiOperationContext,
  withOpenAiRunContext,
} from "@/server/openai/cost-tracker";
import { withOpenAiApiKeyContext } from "@/server/openai/client";

export const runtime = "nodejs";

type PipelinePhase = "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6";

type SourceHealthState = Record<SourceName, "green" | "yellow" | "red">;

const diseaseEntityPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;

function normalizeApiKey(raw: string | null | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^sk-[A-Za-z0-9._-]{12,}$/.test(value)) return undefined;
  return value;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const cleaned = cleanText(item);
      if (cleaned) return cleaned;
    }
    return undefined;
  }

  if (value && typeof value === "object") {
    const maybeNamed = value as { name?: unknown; displayName?: unknown };
    const cleanedName = cleanText(maybeNamed.name);
    if (cleanedName) return cleanedName;
    const cleanedDisplay = cleanText(maybeNamed.displayName);
    if (cleanedDisplay) return cleanedDisplay;
  }

  return undefined;
}

function compactLabel(value: string, max = 32): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(8, max - 1))}\u2026`;
}

function preferredLabel(
  candidates: Array<unknown>,
  fallback: string,
  max = 32,
): string {
  for (const candidate of candidates) {
    const cleaned = cleanText(candidate);
    if (cleaned) return compactLabel(cleaned, max);
  }
  return compactLabel(fallback, max);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

export async function GET(request: NextRequest) {
  assertRuntimeConfig();

  const { searchParams } = new URL(request.url);
  const diseaseQuery = searchParams.get("diseaseQuery")?.trim();
  const diseaseIdHint = searchParams.get("diseaseId")?.trim();
  const runId = searchParams.get("runId")?.trim() || null;
  const maxTargets = Number(searchParams.get("maxTargets") ?? 20);
  const seedTargets = (searchParams.get("seedTargets") ?? "")
    .split(",")
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token.length >= 2)
    .slice(0, 20);
  const includePathways = searchParams.get("pathways") !== "0";
  const includeDrugs = searchParams.get("drugs") !== "0";
  const includeInteractions = searchParams.get("interactions") !== "0";
  const includeLiterature = searchParams.get("literature") !== "0";
  const requestApiKey = normalizeApiKey(
    request.headers.get("x-targetgraph-api-key"),
  );
  const log = startRequestLog("/api/streamGraph", {
    diseaseQuery: diseaseQuery?.slice(0, 120),
    runId,
    maxTargets,
    includePathways,
    includeDrugs,
    includeInteractions,
    includeLiterature,
    seedTargets: seedTargets.length,
  });

  if (!diseaseQuery) {
    endRequestLog(log, { rejected: true, reason: "missing_disease_query" });
    return new Response("Missing diseaseQuery", { status: 400 });
  }

  if (runId) {
    beginOpenAiRun(runId, diseaseQuery);
  }

  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  const sourceHealth: SourceHealthState = {
    opentargets: "green",
    reactome: "green",
    string: "green",
    chembl: "green",
    biomcp: "green",
    pubmed: "green",
    openai: "green",
  };

  const streamState = { closed: false };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const startedAt = Date.now();
      const phaseTimeoutMs = appConfig.stream.phaseTimeoutMs;

      const emit = (event: StreamEventPayload) => {
        if (streamState.closed) return;
        try {
          controller.enqueue(encodeSseEvent(event));
        } catch {
          streamState.closed = true;
        }
      };

      const closeStream = () => {
        if (streamState.closed) return;
        streamState.closed = true;
        try {
          controller.close();
        } catch {
          // noop
        }
      };

      const emitStatus = (
        phase: PipelinePhase,
        message: string,
        pct: number,
        counts: Record<string, number> = {},
        partial = false,
      ) => {
        emit({
          event: "status",
          data: {
            phase,
            message,
            pct,
            counts,
            sourceHealth,
            partial,
            elapsedMs: Date.now() - startedAt,
            timeoutMs: phaseTimeoutMs,
          },
        });
      };

      const emitGraph = (nodes: GraphNode[], edges: GraphEdge[]) => {
        if (nodes.length === 0 && edges.length === 0) {
          return;
        }

        emit({
          event: "partial_graph",
          data: {
            nodes,
            edges,
            stats: {
              totalNodes: nodeMap.size,
              totalEdges: edgeMap.size,
            },
          },
        });
      };

      const pushNodesEdges = (incomingNodes: GraphNode[], incomingEdges: GraphEdge[]) => {
        const newNodes: GraphNode[] = [];
        const newEdges: GraphEdge[] = [];

        for (const node of incomingNodes) {
          const existing = nodeMap.get(node.id);
          if (!existing) {
            nodeMap.set(node.id, node);
            newNodes.push(node);
          } else {
            const merged = {
              ...existing,
              ...node,
              meta: {
                ...existing.meta,
                ...node.meta,
              },
            };
            nodeMap.set(node.id, merged);
            newNodes.push(merged);
          }
        }

        for (const edge of incomingEdges) {
          if (!edgeMap.has(edge.id)) {
            edgeMap.set(edge.id, edge);
            newEdges.push(edge);
          }
        }

        emitGraph(newNodes, newEdges);
      };

      const run = async () => {
        let diseaseId = "";
        let diseaseName = diseaseQuery;
        let diseaseDescription: string | undefined;
        let targetCount = 0;
        let pathwayCount = 0;
        let drugCount = 0;
        let interactionCount = 0;

        const targetNodeIds: string[] = [];
        const targetSymbolByNodeId = new Map<string, string>();
        const pathwaysByTargetId = new Map<string, Set<string>>();
        const drugsByTargetId = new Map<string, Set<string>>();
        const interactionsByTargetId = new Map<string, number>();
        const literatureByTargetId = new Map<string, { articleCount: number; trialCount: number }>();

        try {
          emitStatus("P0", "Resolving disease query", 5);
          if (diseaseIdHint) {
            diseaseId = diseaseIdHint;
            diseaseName = diseaseQuery;

            try {
              const diseases = await withTimeout(searchDiseases(diseaseQuery, 12), phaseTimeoutMs);
              const exact = diseases.find((item) => item.id === diseaseIdHint);
              if (exact?.name) {
                diseaseName = exact.name;
              }
              diseaseDescription = exact?.description;
            } catch {
              sourceHealth.opentargets = "yellow";
            }
          } else {
            const diseases = await withTimeout(searchDiseases(diseaseQuery, 8), phaseTimeoutMs);
            const disease = diseases.find((item) => diseaseEntityPattern.test(item.id)) ?? diseases[0];
            diseaseId = disease?.id ?? `QUERY_${diseaseQuery.replace(/\s+/g, "_")}`;
            diseaseName = disease?.name ?? diseaseQuery;
            diseaseDescription = disease?.description;
          }

          const diseaseNode: GraphNode = {
            id: makeNodeId("disease", diseaseId),
            type: "disease",
            primaryId: diseaseId,
            label: preferredLabel([diseaseName], diseaseId, 40),
            score: 1,
            size: 80,
            meta: {
              description: diseaseDescription,
              displayName: diseaseName,
              query: diseaseQuery,
            },
          };

          nodeMap.set(diseaseNode.id, diseaseNode);
          emitGraph([diseaseNode], []);
          emitStatus(
            "P0",
            diseaseIdHint
              ? `Resolved to ${diseaseName} (${diseaseId}) via disease entity match`
              : `Resolved to ${diseaseName} (${diseaseId})`,
            12,
          );
        } catch (error) {
          sourceHealth.opentargets = "red";
          emit({
            event: "error",
            data: {
              phase: "P0",
              message: `Disease resolution failed: ${error instanceof Error ? error.message : "unknown"}`,
              recoverable: true,
            },
          });

          diseaseId = `QUERY_${diseaseQuery.replace(/\s+/g, "_")}`;
          const diseaseNode: GraphNode = {
            id: makeNodeId("disease", diseaseId),
            type: "disease",
            primaryId: diseaseId,
            label: preferredLabel([diseaseQuery], diseaseId, 40),
            score: 0.5,
            size: 80,
            meta: {
              degraded: true,
            },
          };
          nodeMap.set(diseaseNode.id, diseaseNode);
          emitGraph([diseaseNode], []);
        }

        try {
          emitStatus("P1", "Fetching target evidence from OpenTargets", 18);
          let targets: Awaited<ReturnType<typeof getDiseaseTargetsSummary>> = [];
          try {
            targets = await withTimeout(
              getDiseaseTargetsSummary(diseaseId, Math.min(40, Math.max(5, maxTargets))),
              phaseTimeoutMs,
            );
          } catch {
            sourceHealth.opentargets = "yellow";
          }

          if (targets.length === 0 && seedTargets.length > 0) {
            emitStatus(
              "P1",
              "No disease-target rows returned; switching to query-seeded targets",
              22,
              {
                seedTargets: seedTargets.length,
              },
              true,
            );

            const seededTargetRows = await Promise.all(
              seedTargets.slice(0, maxTargets).map(async (symbol) => {
                const resolved = await withTimeout(
                  searchTargets(symbol, 4),
                  Math.min(phaseTimeoutMs, 3_500),
                ).catch(() => []);
                const best =
                  resolved.find((item) => item.name.toUpperCase() === symbol) ?? resolved[0];
                if (!best) {
                  return {
                    targetId: `QUERY_TARGET_${symbol}`,
                    targetSymbol: symbol,
                    targetName: symbol,
                    associationScore: 0.38,
                  };
                }

                return {
                  targetId: best.id,
                  targetSymbol: symbol,
                  targetName: best.name,
                  associationScore: 0.52,
                };
              }),
            );
            targets = seededTargetRows;
          }

          const diseaseNodeId = makeNodeId("disease", diseaseId);
          for (const batch of chunkArray(targets.slice(0, maxTargets), 5)) {
            const nodes: GraphNode[] = [];
            const edges: GraphEdge[] = [];

            for (const target of batch) {
              const targetNodeId = makeNodeId("target", target.targetId);
              const score = normalizeScore(target.associationScore);
              targetSymbolByNodeId.set(targetNodeId, target.targetSymbol);
              targetNodeIds.push(targetNodeId);
              pathwaysByTargetId.set(targetNodeId, new Set<string>());
              drugsByTargetId.set(targetNodeId, new Set<string>());

              nodes.push({
                id: targetNodeId,
                type: "target",
                primaryId: target.targetId,
                label: preferredLabel(
                  [target.targetSymbol, target.targetName],
                  target.targetId,
                  24,
                ),
                score,
                size: 24 + score * 30,
                meta: {
                  targetSymbol: target.targetSymbol,
                  targetName: target.targetName,
                  displayName: target.targetName || target.targetSymbol,
                  openTargetsEvidence: score,
                  stage: "P1",
                },
              });

              edges.push({
                id: makeEdgeId(diseaseNodeId, targetNodeId, "disease_target"),
                source: diseaseNodeId,
                target: targetNodeId,
                type: "disease_target",
                weight: score,
                meta: {
                  source: "OpenTargets",
                },
              });
            }

            pushNodesEdges(nodes, edges);
            targetCount += batch.length;
            emitStatus("P1", `${targetCount}/${Math.min(maxTargets, targets.length)} targets enriched`, 30, {
              targets: targetCount,
            });
            await sleep(randomInt(appConfig.stream.batchMinDelayMs, appConfig.stream.batchMaxDelayMs));
          }

          if (targetCount === 0) {
            emitStatus(
              "P1",
              "No target evidence rows were available from disease or query-seeded retrieval",
              30,
              { targets: 0, seedTargets: seedTargets.length },
              true,
            );
          }
        } catch (error) {
          sourceHealth.opentargets = "yellow";
          emit({
            event: "error",
            data: {
              phase: "P1",
              message: `OpenTargets target enrichment degraded: ${error instanceof Error ? error.message : "unknown"}`,
              recoverable: true,
            },
          });
        }

        if (!includePathways) {
          emitStatus(
            "P2",
            "Pathway expansion skipped by build profile",
            52,
            { targets: targetCount },
            true,
          );
          emit({
            event: "sankey",
            data: {
              rows: toSankeyRows([...nodeMap.values()], [...edgeMap.values()]),
            },
          });
        } else {
          try {
            emitStatus("P2", "Fetching pathways from Reactome", 36, {
              targets: targetCount,
            });

            const seededTargets = targetNodeIds.slice(0, Math.min(targetNodeIds.length, maxTargets));
            let degradedTargets = 0;
            let budgetTruncated = false;
            const p2Deadline = Date.now() + Math.max(18_000, Math.floor(phaseTimeoutMs * 2));

            for (const batch of chunkArray(seededTargets, 4)) {
              if (Date.now() > p2Deadline) {
                budgetTruncated = true;
                degradedTargets += batch.length;
                break;
              }
              const resolved = await Promise.allSettled(
                batch.map(async (targetNodeId) => {
                  const symbol = targetSymbolByNodeId.get(targetNodeId);
                  if (!symbol) return { targetNodeId, pathways: [] as Awaited<ReturnType<typeof findPathwaysByGene>> };

                  const pathways = await withTimeout(
                    findPathwaysByGene(symbol),
                    Math.min(phaseTimeoutMs, 4_500),
                  );
                  return {
                    targetNodeId,
                    pathways: pathways.slice(0, 8),
                  };
                }),
              );

              const nodes: GraphNode[] = [];
              const edges: GraphEdge[] = [];

              for (const settled of resolved) {
                if (settled.status === "rejected") {
                  degradedTargets += 1;
                  continue;
                }

                const item = settled.value;
                for (const pathway of item.pathways) {
                  const pathwayNodeId = makeNodeId("pathway", pathway.id);
                  pathwaysByTargetId.get(item.targetNodeId)?.add(pathway.id);

                  nodes.push({
                    id: pathwayNodeId,
                    type: "pathway",
                    primaryId: pathway.id,
                    label: preferredLabel([pathway.name], pathway.id, 34),
                    score: 0.6,
                    size: 22,
                    meta: {
                      displayName: cleanText(pathway.name) ?? pathway.id,
                      species: pathway.species,
                      stage: "P2",
                    },
                  });

                  edges.push({
                    id: makeEdgeId(item.targetNodeId, pathwayNodeId, "target_pathway"),
                    source: item.targetNodeId,
                    target: pathwayNodeId,
                    type: "target_pathway",
                    weight: 0.65,
                    meta: {
                      source: "Reactome",
                    },
                  });
                }
              }

              pushNodesEdges(nodes, edges);
              pathwayCount = [...nodeMap.values()].filter((node) => node.type === "pathway").length;
              emitStatus(
                "P2",
                `${pathwayCount} pathways linked`,
                52,
                {
                  targets: targetCount,
                  pathways: pathwayCount,
                  degradedTargets,
                },
                degradedTargets > 0,
              );
              await sleep(randomInt(appConfig.stream.batchMinDelayMs, appConfig.stream.batchMaxDelayMs));
            }

            if (degradedTargets > 0) {
              sourceHealth.reactome = "yellow";
              emit({
                event: "error",
                data: {
                  phase: "P2",
                  message: budgetTruncated
                    ? `Reactome pathway expansion partial: phase budget reached; ${degradedTargets} target-level fetches truncated/degraded`
                    : `Reactome pathway expansion partial: ${degradedTargets} target-level fetches degraded`,
                  recoverable: true,
                },
              });
            }

            emit({
              event: "sankey",
              data: {
                rows: toSankeyRows([...nodeMap.values()], [...edgeMap.values()]),
              },
            });
          } catch (error) {
            sourceHealth.reactome = "yellow";
            emit({
              event: "error",
              data: {
                phase: "P2",
                message: `Reactome pathway expansion degraded: ${error instanceof Error ? error.message : "unknown"}`,
                recoverable: true,
              },
            });
          }
        }

        if (!includeDrugs) {
          emitStatus(
            "P3",
            "Drug enrichment skipped by build profile",
            68,
            {
              targets: targetCount,
              pathways: pathwayCount,
            },
            true,
          );
        } else {
          try {
            emitStatus("P3", "Fetching drugs from OpenTargets and ChEMBL", 58, {
              targets: targetCount,
              pathways: pathwayCount,
            });

            const seedTargets = targetNodeIds.slice(0, Math.min(targetNodeIds.length, 10));
            let degradedTargets = 0;
            let budgetTruncated = false;
            const p3Deadline = Date.now() + Math.max(20_000, Math.floor(phaseTimeoutMs * 2));

            for (const batch of chunkArray(seedTargets, 2)) {
              if (Date.now() > p3Deadline) {
                budgetTruncated = true;
                degradedTargets += batch.length;
                break;
              }
              const settledBatch = await Promise.allSettled(
                batch.map(async (targetNodeId) => {
                const targetPrimaryId = nodeMap.get(targetNodeId)?.primaryId;
                const targetSymbol = targetSymbolByNodeId.get(targetNodeId);
                if (!targetPrimaryId || !targetSymbol) {
                  throw new Error(`missing target metadata for ${targetNodeId}`);
                }

                const [knownDrugs, activityDrugs] = await Promise.allSettled([
                  withTimeout(
                    getKnownDrugsForTarget(targetPrimaryId, 8),
                    Math.min(phaseTimeoutMs, 4_500),
                  ),
                  withTimeout(
                    getTargetActivityDrugs(targetSymbol, 8),
                    Math.min(phaseTimeoutMs, 4_500),
                  ),
                ]);

                const nodes: GraphNode[] = [];
                const edges: GraphEdge[] = [];

                if (knownDrugs.status === "fulfilled") {
                  for (const drug of knownDrugs.value) {
                    const drugNodeId = makeNodeId("drug", drug.drugId);
                    drugsByTargetId.get(targetNodeId)?.add(drug.drugId);

                    nodes.push({
                      id: drugNodeId,
                      type: "drug",
                      primaryId: drug.drugId,
                      label: preferredLabel([drug.name], drug.drugId, 28),
                      score: normalizeScore((drug.phase ?? 0) / 4),
                      size: 18 + (drug.phase ?? 0) * 2,
                      meta: {
                        displayName: drug.name,
                        phase: drug.phase,
                        status: drug.status,
                        modality: drug.drugType,
                        mechanism: drug.mechanismOfAction,
                        stage: "P3",
                      },
                    });

                    edges.push({
                      id: makeEdgeId(targetNodeId, drugNodeId, "target_drug"),
                      source: targetNodeId,
                      target: drugNodeId,
                      type: "target_drug",
                      weight: normalizeScore((drug.phase ?? 0) / 4),
                      meta: {
                        source: "OpenTargets",
                      },
                    });
                  }
                }

                if (activityDrugs.status === "fulfilled") {
                  for (const drug of activityDrugs.value) {
                    const drugNodeId = makeNodeId("drug", drug.moleculeId);
                    drugsByTargetId.get(targetNodeId)?.add(drug.moleculeId);

                    nodes.push({
                      id: drugNodeId,
                      type: "drug",
                      primaryId: drug.moleculeId,
                      label: preferredLabel([drug.name], drug.moleculeId, 28),
                      score: drug.potency ? normalizeScore(1 / (1 + drug.potency / 1000)) : 0.4,
                      size: 18,
                      meta: {
                        displayName: drug.name,
                        activityType: drug.activityType,
                        potency: drug.potency,
                        potencyUnits: drug.potencyUnits,
                        stage: "P3",
                      },
                    });

                    edges.push({
                      id: makeEdgeId(targetNodeId, drugNodeId, "target_drug"),
                      source: targetNodeId,
                      target: drugNodeId,
                      type: "target_drug",
                      weight: drug.potency ? normalizeScore(1 / (1 + drug.potency / 1000)) : 0.4,
                      meta: {
                        source: "ChEMBL",
                      },
                    });
                  }
                }

                  return { nodes, edges };
                }),
              );

              for (const settled of settledBatch) {
                if (settled.status === "fulfilled") {
                  pushNodesEdges(settled.value.nodes, settled.value.edges);
                } else {
                  degradedTargets += 1;
                }
              }

              drugCount = [...nodeMap.values()].filter((node) => node.type === "drug").length;
              emitStatus("P3", `${drugCount} compounds linked`, 68, {
                targets: targetCount,
                pathways: pathwayCount,
                drugs: drugCount,
                degradedTargets,
              });
              await sleep(
                randomInt(
                  Math.max(50, Math.floor(appConfig.stream.batchMinDelayMs / 2)),
                  Math.max(120, Math.floor(appConfig.stream.batchMaxDelayMs / 2)),
                ),
              );
            }

            if (degradedTargets > 0) {
              sourceHealth.chembl = "yellow";
              emit({
                event: "error",
                data: {
                  phase: "P3",
                  message: budgetTruncated
                    ? `Drug enrichment partial: phase budget reached; ${degradedTargets} target-level fetches truncated/degraded`
                    : `Drug enrichment partial: ${degradedTargets} target-level fetches degraded`,
                  recoverable: true,
                },
              });
            }

            emit({
              event: "sankey",
              data: {
                rows: toSankeyRows([...nodeMap.values()], [...edgeMap.values()]),
              },
            });
          } catch (error) {
            sourceHealth.chembl = "yellow";
            emit({
              event: "error",
              data: {
                phase: "P3",
                message: `Drug enrichment degraded: ${error instanceof Error ? error.message : "unknown"}`,
                recoverable: true,
              },
            });
          }
        }

        if (!includeInteractions) {
          emitStatus(
            "P4",
            "Interaction overlay skipped by build profile",
            80,
            {
              targets: targetCount,
              drugs: drugCount,
            },
            true,
          );
        } else {
          try {
            emitStatus("P4", "Fetching STRING interaction neighborhood", 72, {
              targets: targetCount,
              drugs: drugCount,
            });

            const seedSymbols = targetNodeIds
              .slice(0, Math.min(12, targetNodeIds.length))
              .map((id) => targetSymbolByNodeId.get(id))
              .filter((symbol): symbol is string => Boolean(symbol));

            if (seedSymbols.length > 1) {
              const interaction = await withTimeout(
                getInteractionNetwork(
                  seedSymbols,
                  appConfig.string.confidenceDefault,
                  appConfig.string.maxNeighborsPerSeed,
                ),
                Math.min(phaseTimeoutMs, 5_000),
              );

              const nodes: GraphNode[] = [];
              const edges: GraphEdge[] = [];

            for (const node of interaction.nodes.slice(0, appConfig.string.maxAddedNodes)) {
              const existingTarget = targetNodeIds.find(
                (id) => targetSymbolByNodeId.get(id) === node.symbol,
              );
              if (existingTarget) continue;

              const nodeId = makeNodeId("interaction", node.symbol);
              nodes.push({
                id: nodeId,
                type: "interaction",
                primaryId: node.symbol,
                label: preferredLabel([node.symbol, node.annotation], node.id, 24),
                score: 0.35,
                size: 16,
                meta: {
                  displayName: node.annotation || node.symbol,
                  annotation: node.annotation,
                  stage: "P4",
                },
              });
            }

            for (const edge of interaction.edges.slice(0, appConfig.string.maxAddedEdges)) {
              const sourceTargetId = targetNodeIds.find(
                (id) => targetSymbolByNodeId.get(id) === edge.sourceSymbol,
              );
              const targetTargetId = targetNodeIds.find(
                (id) => targetSymbolByNodeId.get(id) === edge.targetSymbol,
              );

              const sourceId = sourceTargetId ?? makeNodeId("interaction", edge.sourceSymbol);
              const targetId = targetTargetId ?? makeNodeId("interaction", edge.targetSymbol);

              if (sourceId === targetId) continue;

              edges.push({
                id: makeEdgeId(sourceId, targetId, "target_target"),
                source: sourceId,
                target: targetId,
                type: "target_target",
                weight: normalizeScore(edge.score),
                meta: {
                  source: "STRING",
                  evidence: edge.evidence,
                },
              });

              if (sourceTargetId) {
                interactionsByTargetId.set(
                  sourceTargetId,
                  (interactionsByTargetId.get(sourceTargetId) ?? 0) + 1,
                );
              }
              if (targetTargetId) {
                interactionsByTargetId.set(
                  targetTargetId,
                  (interactionsByTargetId.get(targetTargetId) ?? 0) + 1,
                );
              }
            }

              pushNodesEdges(nodes, edges);
              interactionCount = edges.length;
            }

            emitStatus("P4", `${interactionCount} interaction edges added`, 80, {
              interactions: interactionCount,
              targets: targetCount,
              drugs: drugCount,
            });
          } catch (error) {
            sourceHealth.string = "yellow";
            emit({
              event: "error",
              data: {
                phase: "P4",
                message: `STRING interactions degraded: ${error instanceof Error ? error.message : "unknown"}`,
                recoverable: true,
              },
            });
          }
        }

        if (!includeLiterature) {
          emitStatus(
            "P5",
            "Literature/trials enrichment skipped by build profile",
            90,
            {
              targets: targetCount,
              pathways: pathwayCount,
              drugs: drugCount,
              interactions: interactionCount,
            },
            true,
          );
        } else {
          try {
            emitStatus("P5", "Fetching literature and trial snippets", 84, {
              targets: targetCount,
              pathways: pathwayCount,
              drugs: drugCount,
              interactions: interactionCount,
            });

          const linkByNodeId: Record<string, { articles: unknown[]; trials: unknown[] }> = {};
          const focusTargets = targetNodeIds.slice(
            0,
            Math.min(appConfig.stream.maxLiteratureTargets, targetNodeIds.length),
          );
          const phaseBudgetDeadline = Date.now() + appConfig.stream.p5BudgetMs;
          const perTargetTimeoutMs = Math.min(
            phaseTimeoutMs,
            appConfig.stream.p5PerTargetTimeoutMs,
          );
          let failedTargets = 0;
          let skippedTargets = 0;

          const focusBatches = chunkArray(focusTargets, 3);
          for (let batchIdx = 0; batchIdx < focusBatches.length; batchIdx += 1) {
            const batch = focusBatches[batchIdx];
            if (Date.now() > phaseBudgetDeadline) {
              skippedTargets += focusTargets.length - batchIdx * 3;
              break;
            }

            const settled = await Promise.allSettled(
              batch.map(async (targetNodeId) => {
                const targetSymbol = targetSymbolByNodeId.get(targetNodeId);
                if (!targetSymbol) {
                  throw new Error(`missing target symbol for ${targetNodeId}`);
                }

                const firstDrugId = [...(drugsByTargetId.get(targetNodeId) ?? [])][0];
                const firstDrugName =
                  firstDrugId && nodeMap.get(makeNodeId("drug", firstDrugId))?.label
                    ? nodeMap.get(makeNodeId("drug", firstDrugId))?.label
                    : undefined;

                const enrichment = await withTimeout(
                  getLiteratureAndTrials(diseaseName, targetSymbol, firstDrugName),
                  perTargetTimeoutMs,
                );

                return {
                  targetNodeId,
                  enrichment,
                };
              }),
            );

            for (const result of settled) {
              if (result.status === "rejected") {
                failedTargets += 1;
                continue;
              }

              const { targetNodeId, enrichment } = result.value;
              linkByNodeId[targetNodeId] = {
                articles: enrichment.articles,
                trials: enrichment.trials,
              };

              literatureByTargetId.set(targetNodeId, {
                articleCount: enrichment.articles.length,
                trialCount: enrichment.trials.length,
              });

              const current = nodeMap.get(targetNodeId);
              if (current) {
                current.meta.articleCount = enrichment.articles.length;
                current.meta.trialCount = enrichment.trials.length;
                nodeMap.set(targetNodeId, current);
                emitGraph([current], []);
              }
            }

            emitStatus(
              "P5",
              `${Object.keys(linkByNodeId).length}/${focusTargets.length} targets enriched with literature/trials`,
              90,
              {
                literatureTargets: Object.keys(linkByNodeId).length,
                degradedTargets: failedTargets,
                skippedTargets,
              },
              failedTargets > 0 || skippedTargets > 0,
            );
            await sleep(120);
          }

          if (failedTargets > 0 || skippedTargets > 0) {
            sourceHealth.biomcp = "yellow";
            emit({
              event: "error",
              data: {
                phase: "P5",
                message:
                  skippedTargets > 0
                    ? `BioMCP enrichment partial: ${failedTargets} timed out, ${skippedTargets} skipped by phase budget`
                    : `BioMCP enrichment partial: ${failedTargets} target enrichments timed out`,
                recoverable: true,
              },
            });
          }

            emit({
              event: "enrichment_ready",
              data: {
                linksByNodeId: linkByNodeId,
              },
            });
          } catch (error) {
            sourceHealth.biomcp = "yellow";
            emit({
              event: "error",
              data: {
                phase: "P5",
                message: `BioMCP enrichment degraded: ${error instanceof Error ? error.message : "unknown"}`,
                recoverable: true,
              },
            });
          }
        }

        emitStatus("P6", "Ranking targets and generating summary", 94, {
          targets: targetCount,
          pathways: pathwayCount,
          drugs: drugCount,
          interactions: interactionCount,
        });

        const rankingRows = targetNodeIds.map((targetNodeId) => {
          const node = nodeMap.get(targetNodeId);
          const pathways = [...(pathwaysByTargetId.get(targetNodeId) ?? new Set<string>())];
          const drugs = [...(drugsByTargetId.get(targetNodeId) ?? new Set<string>())];
          const interactions = interactionsByTargetId.get(targetNodeId) ?? 0;
          const literature = literatureByTargetId.get(targetNodeId) ?? {
            articleCount: 0,
            trialCount: 0,
          };

          return {
            id: node?.primaryId ?? targetNodeId,
            symbol: String(node?.label ?? targetNodeId),
            pathwayIds: pathways,
            openTargetsEvidence: Number(node?.meta?.openTargetsEvidence ?? node?.score ?? 0),
            drugActionability: Math.min(1, drugs.length / 8),
            networkCentrality: Math.min(1, interactions / 8),
            literatureSupport: Math.min(1, (literature.articleCount + literature.trialCount) / 10),
            drugCount: drugs.length,
            interactionCount: interactions,
            articleCount: literature.articleCount,
            trialCount: literature.trialCount,
          };
        });

        emit({
          event: "ranking",
          data: rankTargetsFallback(rankingRows),
        });
        emitStatus("P6", "Baseline ranking ready; refining narrative", 96, {
          targets: targetCount,
          pathways: pathwayCount,
          drugs: drugCount,
          interactions: interactionCount,
        });

        try {
          const ranking = await withOpenAiOperationContext(
            "stream_graph.rank_targets",
            () =>
              withTimeout(
                rankTargets(rankingRows),
                appConfig.stream.rankingTimeoutMs,
              ),
          );
          emit({ event: "ranking", data: ranking });
          emitStatus("P6", "AI narrative refinement complete", 98, {
            targets: targetCount,
            pathways: pathwayCount,
            drugs: drugCount,
            interactions: interactionCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown";
          const timedOut = message.includes("timeout");
          if (timedOut) {
            emitStatus("P6", "Baseline ranking finalized (AI refinement deferred)", 98, {
              targets: targetCount,
              pathways: pathwayCount,
              drugs: drugCount,
              interactions: interactionCount,
            }, true);
          } else {
            sourceHealth.openai = "yellow";
            emit({
              event: "error",
              data: {
                phase: "P6",
                message: `Ranking degraded: ${message}`,
                recoverable: true,
              },
            });
          }
        }

        emitStatus("P6", "Build complete", 100, {
          totalNodes: nodeMap.size,
          totalEdges: edgeMap.size,
          targets: targetCount,
          pathways: pathwayCount,
          drugs: drugCount,
          interactions: interactionCount,
        });

        emit({
          event: "done",
          data: {
            stats: {
              totalNodes: nodeMap.size,
              totalEdges: edgeMap.size,
              targets: targetCount,
              pathways: pathwayCount,
              drugs: drugCount,
              interactions: interactionCount,
            },
          },
        });
        stepRequestLog(log, "stream_graph.done", {
          totalNodes: nodeMap.size,
          totalEdges: edgeMap.size,
          targets: targetCount,
          pathways: pathwayCount,
          drugs: drugCount,
          interactions: interactionCount,
        });
        endRequestLog(log, { completed: true });

        closeStream();
      };

      const execute = runId
        ? () => withOpenAiRunContext(runId, run)
        : run;

      withOpenAiApiKeyContext(requestApiKey, execute).catch((error) => {
        emit({
          event: "error",
          data: {
            phase: "fatal",
            message: error instanceof Error ? error.message : "unknown",
            recoverable: false,
          },
        });
        errorRequestLog(log, "stream_graph.fatal", error);
        endRequestLog(log, { completed: false });
        closeStream();
      });
    },
    cancel() {
      // Client disconnected; stop emitting gracefully.
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
