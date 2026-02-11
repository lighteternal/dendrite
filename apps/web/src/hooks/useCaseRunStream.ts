"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";

export type RunMode = "fast" | "balanced" | "deep";

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
  caveats: string[];
  nextActions: string[];
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
  mode: RunMode;
};

export function useCaseRunStream() {
  const sourceRef = useRef<EventSource | null>(null);
  const intentionalCloseRef = useRef(false);

  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<StatusUpdate | null>(null);
  const [statuses, setStatuses] = useState<StatusUpdate[]>([]);
  const [resolverCandidates, setResolverCandidates] = useState<ResolverCandidate[]>([]);
  const [resolverSelection, setResolverSelection] = useState<ResolverSelection | null>(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [pathUpdate, setPathUpdate] = useState<PathUpdate | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, GraphNode>>(new Map());
  const [edgeMap, setEdgeMap] = useState<Map<string, GraphEdge>>(new Map());
  const [recommendation, setRecommendation] = useState<RecommendationSection | null>(null);
  const [finalBrief, setFinalBrief] = useState<FinalBriefSection | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const reset = useCallback(() => {
    setStatus(null);
    setStatuses([]);
    setResolverCandidates([]);
    setResolverSelection(null);
    setAgentSteps([]);
    setPathUpdate(null);
    setNodeMap(new Map());
    setEdgeMap(new Map());
    setRecommendation(null);
    setFinalBrief(null);
    setErrors([]);
  }, []);

  const stop = useCallback(() => {
    intentionalCloseRef.current = true;
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setIsRunning(false);
  }, []);

  const start = useCallback(
    ({ query, diseaseId, diseaseName, mode }: StartOptions) => {
      const trimmed = query.trim();
      if (!trimmed) return;

      stop();
      reset();
      intentionalCloseRef.current = false;
      setIsRunning(true);

      const params = new URLSearchParams({
        query: trimmed,
        mode,
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
          setStatuses((prev) => [...prev, payload]);
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
              if (!next.has(edge.id)) {
                next.set(edge.id, edge);
              }
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
        setIsRunning(false);
        source.close();
      });

      source.onerror = () => {
        if (intentionalCloseRef.current) {
          source.close();
          return;
        }
        setIsRunning(false);
        setErrors((prev) => [...prev, "stream interrupted"]);
        source.close();
      };
    },
    [reset, stop],
  );

  return useMemo(
    () => ({
      isRunning,
      status,
      statuses,
      resolverCandidates,
      resolverSelection,
      agentSteps,
      pathUpdate,
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
      recommendation,
      finalBrief,
      errors,
      start,
      stop,
      reset,
    }),
    [
      agentSteps,
      edgeMap,
      errors,
      finalBrief,
      isRunning,
      nodeMap,
      pathUpdate,
      recommendation,
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
