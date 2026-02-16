"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";

export type RunMode = "multihop";

export type ResolverCandidate = {
  id: string;
  name: string;
  description?: string;
};

export type ResolverSelection = {
  query: string;
  selected: ResolverCandidate;
  rationale: string;
  candidates: ResolverCandidate[];
};

export type AgentStep = {
  phase: string;
  title: string;
  detail: string;
};

export type PathUpdate = {
  nodeIds: string[];
  edgeIds: string[];
  summary: string;
};

export type RecommendationSection = {
  target: string;
  score: number;
  why: string;
  pathway?: string;
  drugHook?: string;
  interactionHook?: string;
  caveat?: string;
  provisional?: boolean;
};

export type QueryPlan = {
  query: string;
  intent: string;
  anchors: Array<{
    mention: string;
    requestedType: string;
    entityType: "disease" | "target" | "drug";
    id: string;
    name: string;
    confidence: number;
    source: "opentargets" | "chembl";
  }>;
  constraints: Array<{
    text: string;
    polarity: "include" | "avoid" | "optimize";
  }>;
  unresolvedMentions: string[];
  followups: Array<{
    question: string;
    reason: string;
    seedEntityIds: string[];
  }>;
  rationale: string;
};

export type FinalBriefSection = {
  recommendation: {
    target: string;
    score: number;
    why: string;
    pathway: string;
    drugHook: string;
    interactionHook: string;
  } | null;
  alternatives: Array<{
    symbol: string;
    score: number;
    reason: string;
    caveat: string;
  }>;
  evidenceTrace: Array<{
    symbol: string;
    score: number;
    refs: Array<{ field: string; value: string | number | boolean }>;
  }>;
  citations?: Array<{
    index: number;
    kind: "article" | "trial" | "metric";
    label: string;
    source: string;
    url?: string;
  }>;
  evidenceSummary?: {
    targetsWithEvidence: number;
    articleSnippets: number;
    trialSnippets: number;
    citationCount: number;
    citationBreakdown: {
      article: number;
      trial: number;
      metric: number;
    };
  };
  caveats: string[];
  nextActions: string[];
  queryAlignment?: {
    status: "matched" | "anchored" | "mismatch" | "none";
    requestedMentions: string[];
    requestedTargetSymbols: string[];
    matchedTarget?: string;
    baselineTop?: string;
    note: string;
  };
};

export type StatusUpdate = {
  phase: string;
  message: string;
  pct: number;
  elapsedMs?: number;
  partial?: boolean;
  counts?: Record<string, number>;
  sourceHealth?: Record<string, "green" | "yellow" | "red">;
};

export type JourneyEntity = {
  type:
    | "disease"
    | "target"
    | "pathway"
    | "drug"
    | "interaction"
    | "phenotype"
    | "anatomy"
    | "effect"
    | "molecule"
    | "protein";
  label: string;
  primaryId?: string;
};

export type JourneyEntry = {
  id: string;
  ts: string;
  kind:
    | "phase"
    | "tool_start"
    | "tool_result"
    | "insight"
    | "warning"
    | "handoff"
    | "followup"
    | "branch";
  title: string;
  detail: string;
  source:
    | "agent"
    | "planner"
    | "opentargets"
    | "reactome"
    | "chembl"
    | "string"
    | "biomcp"
    | "pubmed";
  pathState?: "active" | "candidate" | "discarded";
  entities: JourneyEntity[];
  graphPatch?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
};

export type AgentFinalAnswer = {
  answer: string;
  biomedicalCase: {
    title: string;
    whyAgentic: string;
  };
  focusThread: {
    pathway: string;
    target: string;
    drug: string;
  };
  keyFindings: string[];
  caveats: string[];
  nextActions: string[];
};

export type CitationBundle = {
  sections: Array<{ section: string; citationIndices: number[] }>;
  citations: Array<{
    index: number;
    kind: "article" | "trial" | "metric";
    label: string;
    source: string;
    url?: string;
  }>;
};

export type LlmCostRollup = {
  key: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  cacheHitRate: number;
};

export type LlmCostSummary = {
  runId: string;
  query?: string;
  startedAt: string;
  updatedAt: string;
  totalCalls: number;
  totals: {
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    cacheHitRate: number;
  };
  byModel: LlmCostRollup[];
  byOperation: LlmCostRollup[];
  bySource: LlmCostRollup[];
  topCalls: Array<{
    id: string;
    at: string;
    model: string;
    source: string;
    operation: string;
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  }>;
};

type StartOptions = {
  query: string;
  diseaseId?: string | null;
  diseaseName?: string | null;
  mode?: RunMode;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBrowserSessionId(): string {
  if (typeof window === "undefined") return "server-session";
  const storageKey = "targetgraph_session_id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const generated =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  window.localStorage.setItem(storageKey, generated);
  return generated;
}

export function useCaseRunStream() {
  const sourceRef = useRef<EventSource | null>(null);
  const intentionalCloseRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const journeyIdCountRef = useRef<Map<string, number>>(new Map());
  const pendingStartRef = useRef(false);
  const isRunningRef = useRef(false);
  const [runSessionId] = useState(() => {
    const value = getBrowserSessionId();
    sessionIdRef.current = value;
    return value;
  });

  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<StatusUpdate | null>(null);
  const [statuses, setStatuses] = useState<StatusUpdate[]>([]);
  const [resolverCandidates, setResolverCandidates] = useState<ResolverCandidate[]>([]);
  const [resolverSelection, setResolverSelection] = useState<ResolverSelection | null>(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [queryPlan, setQueryPlan] = useState<QueryPlan | null>(null);
  const [pathUpdate, setPathUpdate] = useState<PathUpdate | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, GraphNode>>(new Map());
  const [edgeMap, setEdgeMap] = useState<Map<string, GraphEdge>>(new Map());
  const [recommendation, setRecommendation] = useState<RecommendationSection | null>(null);
  const [finalBrief, setFinalBrief] = useState<FinalBriefSection | null>(null);
  const [journeyEntries, setJourneyEntries] = useState<JourneyEntry[]>([]);
  const [journeyStatusMessage, setJourneyStatusMessage] = useState<string | null>(null);
  const [journeyStartedAtMs, setJourneyStartedAtMs] = useState<number | null>(null);
  const [journeyElapsedMs, setJourneyElapsedMs] = useState<number | null>(null);
  const [journeyIsRunning, setJourneyIsRunning] = useState(false);
  const [agentFinal, setAgentFinal] = useState<AgentFinalAnswer | null>(null);
  const [agentAnswerText, setAgentAnswerText] = useState("");
  const [citationBundle, setCitationBundle] = useState<CitationBundle | null>(null);
  const [llmCost, setLlmCost] = useState<LlmCostSummary | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  const reset = useCallback(() => {
    setStatus(null);
    setStatuses([]);
    setResolverCandidates([]);
    setResolverSelection(null);
    setAgentSteps([]);
    setQueryPlan(null);
    setPathUpdate(null);
    setNodeMap(new Map());
    setEdgeMap(new Map());
    setRecommendation(null);
    setFinalBrief(null);
    setJourneyEntries([]);
    setJourneyStatusMessage(null);
    setJourneyStartedAtMs(null);
    setJourneyElapsedMs(null);
    setJourneyIsRunning(false);
    setAgentFinal(null);
    setAgentAnswerText("");
    setCitationBundle(null);
    setLlmCost(null);
    setErrors([]);
    journeyIdCountRef.current = new Map();
  }, []);

  const postInterrupt = useCallback((sessionId: string) => {
    void fetch(
      `/api/runCaseStream?action=interrupt&sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        cache: "no-store",
        keepalive: true,
      },
    ).catch(() => {
      // best effort
    });
  }, []);

  const stop = useCallback((notifyRemote = true) => {
    intentionalCloseRef.current = true;
    const hadActiveRun = Boolean(activeRunIdRef.current);
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    const sessionId = sessionIdRef.current ?? runSessionId;
    activeRunIdRef.current = null;
    pendingStartRef.current = false;
    isRunningRef.current = false;
    setIsRunning(false);
    setJourneyIsRunning(false);
    if (notifyRemote && hadActiveRun && sessionId) {
      postInterrupt(sessionId);
    }
  }, [postInterrupt, runSessionId]);

  const interrupt = useCallback(async () => {
    stop(true);
  }, [stop]);

  const start = useCallback(
    ({ query, diseaseId, diseaseName, mode = "multihop" }: StartOptions) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      if (isRunningRef.current) {
        setErrors((prev) => [
          ...prev,
          "An active query is running. Interrupt it before starting a new one.",
        ]);
        return;
      }
      if (pendingStartRef.current) {
        return;
      }

      const sessionId = sessionIdRef.current ?? runSessionId;
      const runId =
        typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      pendingStartRef.current = true;

      void (async () => {
        try {
          const readActiveStatus = async () => {
            const response = await fetch(
              `/api/runCaseStream?action=status&sessionId=${encodeURIComponent(sessionId)}`,
              {
                method: "GET",
                cache: "no-store",
              },
            ).catch(() => null);
            if (!response?.ok) return { active: false };
            return (await response.json()) as {
              active?: boolean;
            };
          };

          const firstStatus = await readActiveStatus();
          if (firstStatus.active) {
            await delay(700);
            const secondStatus = await readActiveStatus();
            if (secondStatus.active) {
              setErrors((prev) => [
                ...prev,
                "Another active query exists for this session. Interrupt it first.",
              ]);
              return;
            }
          }

          stop(false);
          reset();
          intentionalCloseRef.current = false;
          isRunningRef.current = true;
          setIsRunning(true);
          setJourneyIsRunning(true);
          setJourneyStartedAtMs(Date.now());
          activeRunIdRef.current = runId;

          const params = new URLSearchParams({
            query: trimmed,
            mode,
            runId,
            sessionId,
          });
          if (diseaseId?.trim()) {
            params.set("diseaseId", diseaseId.trim());
          }
          if (diseaseName?.trim()) {
            params.set("diseaseName", diseaseName.trim());
          }

          const source = new EventSource(`/api/runCaseStream?${params.toString()}`);
          sourceRef.current = source;

          const mergeGraphPatch = (payload: { nodes?: GraphNode[]; edges?: GraphEdge[] }) => {
            setNodeMap((prev) => {
              const next = new Map(prev);
              for (const node of payload.nodes ?? []) {
                const existing = next.get(node.id);
                next.set(
                  node.id,
                  existing
                    ? {
                        ...existing,
                        ...node,
                        meta: {
                          ...existing.meta,
                          ...node.meta,
                        },
                      }
                    : node,
                );
              }
              return next;
            });

            setEdgeMap((prev) => {
              const next = new Map(prev);
              for (const edge of payload.edges ?? []) {
                const existing = next.get(edge.id);
                next.set(
                  edge.id,
                  existing
                    ? {
                        ...existing,
                        ...edge,
                        meta: {
                          ...existing.meta,
                          ...edge.meta,
                        },
                      }
                    : edge,
                );
              }
              return next;
            });
          };

          const appendJourneyEntry = (
            payload: unknown,
            fallbackKind: JourneyEntry["kind"] = "insight",
          ) => {
            if (!payload || typeof payload !== "object") return;
            const row = payload as Record<string, unknown>;
            const title =
              typeof row.title === "string" && row.title.trim().length > 0
                ? row.title
                : "Agent update";
            const detail =
              typeof row.detail === "string" && row.detail.trim().length > 0
                ? row.detail
                : title;
            const id =
              typeof row.id === "string" && row.id.trim().length > 0
                ? row.id
                : `journey-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
            const duplicateCount = journeyIdCountRef.current.get(id) ?? 0;
            journeyIdCountRef.current.set(id, duplicateCount + 1);
            const uniqueId = duplicateCount === 0 ? id : `${id}:${duplicateCount + 1}`;
            const ts =
              typeof row.ts === "string" && row.ts.trim().length > 0
                ? row.ts
                : new Date().toISOString();
            const kind =
              typeof row.kind === "string" && row.kind.trim().length > 0
                ? (row.kind as JourneyEntry["kind"])
                : fallbackKind;
            const sourceName =
              typeof row.source === "string" && row.source.trim().length > 0
                ? (row.source as JourneyEntry["source"])
                : "agent";
            const pathState =
              typeof row.pathState === "string" && row.pathState.trim().length > 0
                ? (row.pathState as JourneyEntry["pathState"])
                : undefined;
            const entities = Array.isArray(row.entities)
              ? (row.entities as JourneyEntity[])
              : [];
            const graphPatch =
              row.graphPatch && typeof row.graphPatch === "object"
                ? (row.graphPatch as JourneyEntry["graphPatch"])
                : undefined;
            const entry: JourneyEntry = {
              id: uniqueId,
              ts,
              kind,
              title,
              detail,
              source: sourceName,
              pathState,
              entities,
              graphPatch,
            };
            setJourneyEntries((prev) => [...prev, entry].slice(-300));
            setJourneyStatusMessage(detail);
            if (graphPatch) {
              mergeGraphPatch({
                nodes: graphPatch.nodes,
                edges: graphPatch.edges,
              });
            }
          };

          source.addEventListener("run_started", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                runId?: string;
                query?: string;
                startedAt?: string;
              };
              setJourneyIsRunning(true);
              if (payload.startedAt) {
                const parsedStartedAtMs = Date.parse(payload.startedAt);
                if (Number.isFinite(parsedStartedAtMs)) {
                  setJourneyStartedAtMs(parsedStartedAtMs);
                }
              }
              if (payload.runId) {
                activeRunIdRef.current = payload.runId;
              }
              if (payload.query) {
                setJourneyStatusMessage(`Running: ${payload.query}`);
              }
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("status", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as StatusUpdate;
              setStatus(payload);
              setStatuses((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.phase === payload.phase && last.message === payload.message) {
                  return prev;
                }
                return [...prev, payload];
              });
              setJourneyStatusMessage(payload.message);
              if (typeof payload.elapsedMs === "number") {
                setJourneyElapsedMs(payload.elapsedMs);
              }
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("resolver_candidates", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                candidates: ResolverCandidate[];
              };
              setResolverCandidates(payload.candidates ?? []);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("resolver_selected", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as ResolverSelection;
              setResolverSelection(payload);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("plan_ready", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                queryPlan?: QueryPlan;
                resolver?: ResolverSelection;
              };
              if (payload.queryPlan) {
                setQueryPlan(payload.queryPlan);
              }
              if (payload.resolver) {
                setResolverSelection(payload.resolver);
              }
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("agent_step", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as AgentStep;
              setAgentSteps((prev) => [...prev, payload]);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("query_plan", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as QueryPlan;
              setQueryPlan(payload);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("path_update", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as PathUpdate;
              setPathUpdate(payload);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("graph_patch", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                nodes: GraphNode[];
                edges: GraphEdge[];
              };
              mergeGraphPatch(payload);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("graph_delta", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                nodes: GraphNode[];
                edges: GraphEdge[];
              };
              mergeGraphPatch(payload);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("brief_section", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                section: string;
                data: unknown;
              };

              if (payload.section === "recommendation") {
                setRecommendation(payload.data as RecommendationSection);
              }

              if (payload.section === "final_brief") {
                setFinalBrief(payload.data as FinalBriefSection);
              }
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("narration_delta", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
              appendJourneyEntry(payload, "insight");
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("branch_update", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
              appendJourneyEntry(payload, "branch");
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("tool_call", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
              appendJourneyEntry(payload, "tool_start");
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("tool_result", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
              appendJourneyEntry(payload, "tool_result");
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("answer_delta", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                text?: string;
              };
              if (typeof payload.text === "string") {
                setAgentAnswerText(payload.text);
              }
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("final_answer", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as AgentFinalAnswer;
              setAgentFinal(payload);
              if (typeof payload.answer === "string") {
                setAgentAnswerText(payload.answer);
              }
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("citation_bundle", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as CitationBundle;
              setCitationBundle(payload);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("run_completed", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                elapsedMs?: number;
                finalAnswer?: AgentFinalAnswer | null;
                llmCost?: LlmCostSummary | null;
              };
              if (typeof payload.elapsedMs === "number") {
                setJourneyElapsedMs(payload.elapsedMs);
              }
              if (payload.finalAnswer) {
                setAgentFinal(payload.finalAnswer);
                if (typeof payload.finalAnswer.answer === "string") {
                  setAgentAnswerText(payload.finalAnswer.answer);
                }
              }
              if (payload.llmCost) {
                setLlmCost(payload.llmCost);
              }
              setJourneyIsRunning(false);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("llm_cost", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as LlmCostSummary;
              setLlmCost(payload);
            } catch {
              // ignore parse errors
            }
          });

          source.addEventListener("run_error", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                message?: string;
              };
              setErrors((prev) => [...prev, payload.message ?? "run error"]);
            } catch {
              setErrors((prev) => [...prev, "run error"]);
            }
          });

          source.addEventListener("error", (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                message?: string;
              };
              setErrors((prev) => [...prev, payload.message ?? "unknown stream error"]);
            } catch {
              setErrors((prev) => [...prev, "unknown stream error"]);
            }
          });

          source.addEventListener("done", (event) => {
            let doneElapsedMs: number | undefined;
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                elapsedMs?: number;
                llmCost?: LlmCostSummary | null;
              };
              if (typeof payload.elapsedMs === "number") {
                doneElapsedMs = payload.elapsedMs;
                setJourneyElapsedMs(payload.elapsedMs);
              }
              if (payload.llmCost) {
                setLlmCost(payload.llmCost);
              }
            } catch {
              // ignore parse errors
            }
            intentionalCloseRef.current = true;
            setStatus((prev) => ({
              phase: "P6",
              message: "Build complete",
              pct: 100,
              elapsedMs: doneElapsedMs ?? prev?.elapsedMs,
              partial: false,
              counts: prev?.counts,
              sourceHealth: prev?.sourceHealth,
            }));
            setJourneyStatusMessage("Build complete");
            setJourneyIsRunning(false);
            isRunningRef.current = false;
            setIsRunning(false);
            sourceRef.current = null;
            activeRunIdRef.current = null;
            pendingStartRef.current = false;
            source.close();
          });

          source.onerror = () => {
            if (intentionalCloseRef.current) {
              source.close();
              sourceRef.current = null;
              activeRunIdRef.current = null;
              return;
            }
            isRunningRef.current = false;
            setIsRunning(false);
            setJourneyIsRunning(false);
            setErrors((prev) => [...prev, "stream interrupted"]);
            sourceRef.current = null;
            activeRunIdRef.current = null;
            pendingStartRef.current = false;
            source.close();
          };
        } finally {
          pendingStartRef.current = false;
        }
      })();
    },
    [reset, runSessionId, stop],
  );

  return useMemo(
    () => ({
      runSessionId,
      isRunning,
      status,
      statuses,
      resolverCandidates,
      resolverSelection,
      agentSteps,
      queryPlan,
      pathUpdate,
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
      recommendation,
      finalBrief,
      journeyEntries,
      journeyStatusMessage,
      journeyStartedAtMs,
      journeyElapsedMs,
      journeyIsRunning,
      agentFinal,
      agentAnswerText,
      citationBundle,
      llmCost,
      errors,
      start,
      stop,
      interrupt,
      reset,
    }),
    [
      agentSteps,
      edgeMap,
      errors,
      finalBrief,
      journeyEntries,
      journeyStatusMessage,
      journeyStartedAtMs,
      journeyElapsedMs,
      journeyIsRunning,
      agentFinal,
      agentAnswerText,
      citationBundle,
      llmCost,
      interrupt,
      isRunning,
      nodeMap,
      pathUpdate,
      queryPlan,
      recommendation,
      runSessionId,
      resolverCandidates,
      resolverSelection,
      reset,
      start,
      status,
      statuses,
      stop,
    ],
  );
}
