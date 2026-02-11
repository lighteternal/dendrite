"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export type DiscoverEntity = {
  type: "disease" | "target" | "pathway" | "drug" | "interaction";
  label: string;
  primaryId?: string;
};

export type DiscoverJourneyEntry = {
  id: string;
  ts: string;
  kind: "phase" | "tool_start" | "tool_result" | "insight" | "warning";
  title: string;
  detail: string;
  source: "agent" | "opentargets" | "reactome" | "chembl" | "string" | "biomcp";
  entities: DiscoverEntity[];
};

export type DiscovererFinal = {
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

type StreamStatus = {
  phase: string;
  message: string;
  elapsedMs: number;
};

type StartParams = {
  diseaseQuery: string;
  question: string;
  diseaseId?: string | null;
};

export function useDeepDiscoverStream() {
  const sourceRef = useRef<EventSource | null>(null);

  const [entries, setEntries] = useState<DiscoverJourneyEntry[]>([]);
  const [final, setFinal] = useState<DiscovererFinal | null>(null);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const stop = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setIsRunning(false);
  }, []);

  const reset = useCallback(() => {
    setEntries([]);
    setFinal(null);
    setStatus(null);
    setError(null);
    setElapsedMs(null);
  }, []);

  const start = useCallback(
    ({ diseaseQuery, question, diseaseId }: StartParams) => {
      const query = diseaseQuery.trim();
      const q = question.trim();
      if (!query || !q) return;

      stop();
      reset();
      setIsRunning(true);

      const params = new URLSearchParams({
        diseaseQuery: query,
        question: q,
      });
      if (diseaseId?.trim()) {
        params.set("diseaseId", diseaseId.trim());
      }

      const source = new EventSource(`/api/agentDiscover?${params.toString()}`);
      sourceRef.current = source;

      source.addEventListener("status", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as StreamStatus;
          setStatus(payload);
        } catch {
          // noop
        }
      });

      source.addEventListener("journey", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as DiscoverJourneyEntry;
          setEntries((prev) => [...prev, payload]);
        } catch {
          // noop
        }
      });

      source.addEventListener("final", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as DiscovererFinal;
          setFinal(payload);
        } catch {
          // noop
        }
      });

      source.addEventListener("done", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            elapsedMs: number;
          };
          setElapsedMs(payload.elapsedMs);
        } catch {
          // noop
        }
        stop();
      });

      source.addEventListener("error", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            message?: string;
          };
          setError(payload.message ?? "Agent workflow error");
        } catch {
          setError("Agent workflow error");
        }
      });

      source.onerror = () => {
        setIsRunning(false);
        if (!final) {
          setError((prev) => prev ?? "Discoverer stream interrupted");
        }
        source.close();
      };
    },
    [final, reset, stop],
  );

  return useMemo(
    () => ({
      entries,
      final,
      status,
      isRunning,
      error,
      elapsedMs,
      start,
      stop,
      reset,
    }),
    [elapsedMs, entries, error, final, isRunning, reset, start, status, stop],
  );
}
