"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode, RankingResponse, SankeyRow } from "@/lib/contracts";

type StreamStatus = {
  phase: string;
  message: string;
  pct: number;
  elapsedMs: number;
  counts: Record<string, number>;
  sourceHealth: Record<string, "green" | "yellow" | "red">;
  partial?: boolean;
  timeoutMs?: number;
};

type StreamError = {
  phase: string;
  message: string;
  recoverable: boolean;
};

type EnrichmentMap = Record<string, { articles: unknown[]; trials: unknown[] }>;
type BuildOptions = {
  pathways: boolean;
  drugs: boolean;
  interactions: boolean;
  literature: boolean;
};

export function useGraphStream() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamTokenRef = useRef(0);

  const [nodeMap, setNodeMap] = useState<Map<string, GraphNode>>(new Map());
  const [edgeMap, setEdgeMap] = useState<Map<string, GraphEdge>>(new Map());
  const [sankeyRows, setSankeyRows] = useState<SankeyRow[]>([]);
  const [ranking, setRanking] = useState<RankingResponse | null>(null);
  const [statuses, setStatuses] = useState<Record<string, StreamStatus>>({});
  const [errors, setErrors] = useState<StreamError[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [enrichmentByNode, setEnrichmentByNode] = useState<EnrichmentMap>({});
  const [isStreaming, setIsStreaming] = useState(false);
  const [isDone, setIsDone] = useState(false);

  const reset = useCallback(() => {
    setNodeMap(new Map());
    setEdgeMap(new Map());
    setSankeyRows([]);
    setRanking(null);
    setStatuses({});
    setErrors([]);
    setStats({});
    setEnrichmentByNode({});
    setIsDone(false);
  }, []);

  const stop = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const start = useCallback((
    diseaseQuery: string,
    maxTargets = 20,
    options: BuildOptions = {
      pathways: true,
      drugs: true,
      interactions: true,
      literature: true,
    },
    diseaseIdHint?: string | null,
  ) => {
    stop();
    reset();
    setIsStreaming(true);
    setIsDone(false);
    const token = ++streamTokenRef.current;

    const params = new URLSearchParams({
      diseaseQuery,
      maxTargets: String(maxTargets),
      pathways: options.pathways ? "1" : "0",
      drugs: options.drugs ? "1" : "0",
      interactions: options.interactions ? "1" : "0",
      literature: options.literature ? "1" : "0",
    });
    if (diseaseIdHint) {
      params.set("diseaseId", diseaseIdHint);
    }
    const url = `/api/streamGraph?${params.toString()}`;
    const source = new EventSource(url);
    eventSourceRef.current = source;

    const isCurrentStream = () =>
      eventSourceRef.current === source && streamTokenRef.current === token;

    source.addEventListener("status", (event) => {
      if (!isCurrentStream()) return;
      const status = JSON.parse((event as MessageEvent<string>).data) as StreamStatus;
      setStatuses((prev) => ({
        ...prev,
        [status.phase]: status,
      }));
    });

    source.addEventListener("partial_graph", (event) => {
      if (!isCurrentStream()) return;
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        nodes: GraphNode[];
        edges: GraphEdge[];
        stats: Record<string, number>;
      };

      setNodeMap((prev) => {
        const next = new Map(prev);
        for (const node of payload.nodes) {
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
        for (const edge of payload.edges) {
          if (!next.has(edge.id)) {
            next.set(edge.id, edge);
          }
        }
        return next;
      });

      setStats((prev) => ({
        ...prev,
        ...payload.stats,
      }));
    });

    source.addEventListener("sankey", (event) => {
      if (!isCurrentStream()) return;
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        rows: SankeyRow[];
      };
      setSankeyRows(payload.rows);
    });

    source.addEventListener("ranking", (event) => {
      if (!isCurrentStream()) return;
      const payload = JSON.parse((event as MessageEvent<string>).data) as RankingResponse;
      setRanking(payload);
    });

    source.addEventListener("enrichment_ready", (event) => {
      if (!isCurrentStream()) return;
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        linksByNodeId: EnrichmentMap;
      };

      setEnrichmentByNode(payload.linksByNodeId);
    });

    source.addEventListener("error", (event) => {
      if (!isCurrentStream()) return;
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as StreamError;
        setErrors((prev) => [...prev, payload]);
      } catch {
        setErrors((prev) => [
          ...prev,
          { phase: "stream", message: "Unexpected stream error", recoverable: true },
        ]);
      }
    });

    source.addEventListener("done", (event) => {
      if (!isCurrentStream()) return;
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        stats: Record<string, number>;
      };

      setStats((prev) => ({ ...prev, ...payload.stats }));
      setIsDone(true);
      stop();
    });

    source.onerror = () => {
      if (!isCurrentStream()) return;
      setIsStreaming(false);
      source.close();
    };
  }, [reset, stop]);

  const nodes = useMemo(() => [...nodeMap.values()], [nodeMap]);
  const edges = useMemo(() => [...edgeMap.values()], [edgeMap]);

  return {
    nodes,
    edges,
    sankeyRows,
    ranking,
    statuses,
    errors,
    stats,
    enrichmentByNode,
    isStreaming,
    isDone,
    start,
    stop,
  };
}
