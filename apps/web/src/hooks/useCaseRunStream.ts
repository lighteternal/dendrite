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
    setErrors([]);
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

          source.addEventListener("done", () => {
            intentionalCloseRef.current = true;
            setStatus((prev) => ({
              phase: "P6",
              message: "Build complete",
              pct: 100,
              elapsedMs: prev?.elapsedMs,
              partial: false,
              counts: prev?.counts,
              sourceHealth: prev?.sourceHealth,
            }));
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
