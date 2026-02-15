"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Clock3,
  Download,
  Loader2,
  PanelRightOpen,
  Play,
  Search,
} from "lucide-react";
import { DeepDiscoverer } from "@/components/targetgraph/deep-discoverer";
import { PathFirstGraph } from "@/components/targetgraph/path-first-graph";
import {
  type DiscoverEntity,
  type DiscoverJourneyEntry,
  type DiscovererFinal,
} from "@/hooks/useDeepDiscoverStream";
import { type BridgeAnalysis } from "@/components/targetgraph/bridge-analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  useCaseRunStream,
  type PathUpdate,
} from "@/hooks/useCaseRunStream";
import type { GraphEdge, GraphNode } from "@/lib/contracts";

type Props = {
  initialQuery: string;
  initialDiseaseId?: string;
  initialDiseaseName?: string;
};

type SourceHealth = Record<string, "green" | "yellow" | "red">;
type DiscoveryPathState = "active" | "candidate" | "discarded";

const phaseSummaryMap: Record<string, string> = {
  P0: "I am resolving canonical anchors from your query",
  P1: "I am investigating target evidence and priority signals",
  P2: "I am following pathway trails from the active targets",
  P3: "I am checking compound and mechanism support",
  P4: "I am testing network bridges and neighborhood context",
  P5: "I am grounding the path with papers and trials",
  P6: "I am closing with a ranked thread and caveats",
};

function sourceBadgeTone(value: "green" | "yellow" | "red") {
  if (value === "green") return "bg-[#eef8f2] text-[#1d6f45]";
  if (value === "yellow") return "bg-[#fff6ea] text-[#9a5d21]";
  return "bg-[#fff0f1] text-[#a9324f]";
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function pathSignature(path: PathUpdate | null): string {
  if (!path) return "";
  return `${path.nodeIds.slice().sort().join("|")}::${path.edgeIds.slice().sort().join("|")}`;
}

function isQueryAnchorBridgeEdge(edge: GraphEdge | undefined): boolean {
  if (!edge) return false;
  if (edge.type !== "disease_disease") return false;
  const source = String(edge.meta.source ?? "").toLowerCase();
  return source === "query_anchor" || source === "query_gap";
}

function hasExplicitMechanisticPath(path: PathUpdate | null, edges: GraphEdge[]): boolean {
  if (!path) return false;
  if (path.nodeIds.length < 3) return false;
  if (path.edgeIds.length < 2) return false;
  const edgeMap = new Map(edges.map((edge) => [edge.id, edge]));
  const mechanisticEdgeCount = path.edgeIds
    .map((id) => edgeMap.get(id))
    .filter((edge): edge is GraphEdge => Boolean(edge))
    .filter((edge) => !isQueryAnchorBridgeEdge(edge))
    .length;
  return mechanisticEdgeCount >= 2;
}

function compact(value: string, max = 148): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function narrationKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeTrailTitle(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Agent update";
  const sentence = cleaned.split(/[.!?]/)[0]?.trim() ?? cleaned;
  return compact(sentence, 92);
}

function mergeGraphNodes(base: GraphNode[], overlay: GraphNode[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  const aliasByKey = new Map<string, string>();
  const upsert = (node: GraphNode) => {
    const semanticKey = `${node.type}:${node.primaryId}`.toLowerCase();
    const existingId = aliasByKey.get(semanticKey);
    const key = existingId ?? node.id;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, node);
      aliasByKey.set(semanticKey, key);
      return;
    }
    byId.set(key, {
      ...existing,
      ...node,
      meta: {
        ...existing.meta,
        ...node.meta,
      },
      score:
        typeof node.score === "number"
          ? Math.max(existing.score ?? 0, node.score)
          : existing.score,
      size:
        typeof node.size === "number"
          ? Math.max(existing.size ?? 0, node.size)
          : existing.size,
    });
  };

  for (const node of base) upsert(node);
  for (const node of overlay) upsert(node);
  return [...byId.values()];
}

function mergeGraphEdges(base: GraphEdge[], overlay: GraphEdge[]): GraphEdge[] {
  const byId = new Map<string, GraphEdge>();
  const upsert = (edge: GraphEdge) => {
    const existing = byId.get(edge.id);
    if (!existing) {
      byId.set(edge.id, edge);
      return;
    }
    byId.set(edge.id, {
      ...existing,
      ...edge,
      weight: Math.max(existing.weight ?? 0, edge.weight ?? 0),
      meta: {
        ...existing.meta,
        ...edge.meta,
      },
    });
  };

  for (const edge of base) upsert(edge);
  for (const edge of overlay) upsert(edge);
  return [...byId.values()];
}

export function DecisionBriefWorkspace({
  initialQuery,
  initialDiseaseId,
  initialDiseaseName,
}: Props) {
  const router = useRouter();
  const stream = useCaseRunStream();
  const startStream = stream.start;
  const stopStream = stream.stop;

  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [runSequence, setRunSequence] = useState(1);
  const [diseaseIdOverride, setDiseaseIdOverride] = useState<string | null>(initialDiseaseId ?? null);
  const [diseaseNameOverride, setDiseaseNameOverride] = useState<string | null>(initialDiseaseName ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showPathwayContext, setShowPathwayContext] = useState(true);
  const [showDrugContext, setShowDrugContext] = useState(true);
  const [showInteractionContext, setShowInteractionContext] = useState(false);

  const [activePath, setActivePath] = useState<PathUpdate | null>(null);
  const [washedPaths, setWashedPaths] = useState<PathUpdate[]>([]);
  const [bridgeAnalysis, setBridgeAnalysis] = useState<BridgeAnalysis | null>(null);
  const [agentFinalReadout, setAgentFinalReadout] = useState<DiscovererFinal | null>(null);
  const [discoverEntries, setDiscoverEntries] = useState<DiscoverJourneyEntry[]>([]);
  const [discoverStatusMessage, setDiscoverStatusMessage] = useState<string | null>(null);
  const [discoverElapsedMs, setDiscoverElapsedMs] = useState<number | null>(null);
  const [discoverIsRunning, setDiscoverIsRunning] = useState(false);
  const activePathRef = useRef<PathUpdate | null>(null);
  const lastNarrationAtRef = useRef<number>(0);
  const [secondsSinceNarration, setSecondsSinceNarration] = useState(0);

  useEffect(() => {
    lastNarrationAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    startStream({
      query: initialQuery,
      diseaseId: initialDiseaseId ?? null,
      diseaseName: initialDiseaseName ?? null,
    });

    return () => stopStream();
  }, [initialDiseaseId, initialDiseaseName, initialQuery, startStream, stopStream]);

  useEffect(() => {
    const incoming = stream.pathUpdate;
    if (!incoming) return;
    const incomingSignature = pathSignature(incoming);
    const previous = activePathRef.current;
    const previousSignature = pathSignature(previous);
    if (incomingSignature === previousSignature) return;

    if (previous && previous.edgeIds.length > 0) {
      setWashedPaths((prev) => {
        const next = [previous, ...prev.filter((item) => pathSignature(item) !== previousSignature)];
        return next.slice(0, 8);
      });
    }

    activePathRef.current = incoming;
    setActivePath(incoming);
  }, [stream.pathUpdate]);

  const activeSourceHealth = (stream.status?.sourceHealth ?? {}) as SourceHealth;

  const agentGraph = useMemo(() => {
    const nodeMap = new Map<string, GraphNode>();
    const edgeMap = new Map<string, GraphEdge>();
    for (const entry of discoverEntries) {
      const patch = entry.graphPatch;
      if (!patch) continue;
      for (const node of patch.nodes ?? []) {
        const existing = nodeMap.get(node.id);
        nodeMap.set(
          node.id,
          existing
            ? {
                ...existing,
                ...node,
                meta: {
                  ...existing.meta,
                  ...node.meta,
                },
                score:
                  typeof node.score === "number"
                    ? Math.max(existing.score ?? 0, node.score)
                    : existing.score,
              }
            : node,
        );
      }
      for (const edge of patch.edges ?? []) {
        const existing = edgeMap.get(edge.id);
        edgeMap.set(
          edge.id,
          existing
            ? {
                ...existing,
                ...edge,
                weight: Math.max(existing.weight ?? 0, edge.weight ?? 0),
                meta: {
                  ...existing.meta,
                  ...edge.meta,
                },
              }
            : edge,
        );
      }
    }
    return {
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
  }, [discoverEntries]);

  const graphNodes = useMemo(
    () => mergeGraphNodes(stream.nodes, agentGraph.nodes),
    [agentGraph.nodes, stream.nodes],
  );
  const graphEdges = useMemo(
    () => mergeGraphEdges(stream.edges, agentGraph.edges),
    [agentGraph.edges, stream.edges],
  );

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return graphNodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [graphNodes, selectedNodeId]);
  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return null;
    return graphEdges.find((edge) => edge.id === selectedEdgeId) ?? null;
  }, [graphEdges, selectedEdgeId]);

  useEffect(() => {
    lastNarrationAtRef.current = Date.now();
  }, [
    stream.status?.message,
    stream.pathUpdate?.summary,
    stream.agentSteps.length,
    stream.nodes.length,
    stream.edges.length,
  ]);

  useEffect(() => {
    if (!stream.isRunning) return;

    const timer = window.setInterval(() => {
      const deltaSec = Math.max(0, Math.floor((Date.now() - lastNarrationAtRef.current) / 1000));
      setSecondsSinceNarration(deltaSec);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [stream.isRunning]);

  const executionNarration = useMemo(() => {
    const fromAgentSteps = stream.agentSteps
      .map((step, index) => ({
        id: `agent-step-${index}`,
        phase: step.phase,
        title: summarizeTrailTitle(step.title || step.detail || step.phase),
        detail: compact(step.detail || step.title || step.phase, 180),
      }))
      .slice(-42);
    const fromStatuses = stream.statuses
      .map((status, index) => ({
        id: `status-${index}`,
        phase: status.phase,
        title: summarizeTrailTitle(status.message),
        detail: compact(status.message, 180),
      }))
      .slice(-18);

    const raw = fromAgentSteps.length > 0 ? fromAgentSteps : fromStatuses;
    const condensed: Array<{ id: string; phase: string; title: string; detail: string; count: number }> = [];
    const bySemantic = new Map<string, number>();
    for (const entry of raw) {
      const semantic = `${entry.phase}::${narrationKey(entry.title)}`;
      const detailKey = narrationKey(entry.detail);
      const existingIndex = bySemantic.get(semantic);
      if (existingIndex === undefined) {
        bySemantic.set(semantic, condensed.length);
        condensed.push({
          id: entry.id,
          phase: entry.phase,
          title: entry.title,
          detail: entry.detail,
          count: 1,
        });
        continue;
      }

      const existing = condensed[existingIndex];
      if (!existing) continue;
      if (narrationKey(existing.detail) === detailKey) {
        existing.count += 1;
        existing.id = entry.id;
        continue;
      }
      existing.detail = entry.detail;
      existing.id = entry.id;
      existing.count += 1;
    }

    return condensed.slice(-7);
  }, [stream.agentSteps, stream.statuses]);

  const mergedLiveNarration = useMemo(() => {
    const fromAgentTrail = discoverEntries
      .filter((entry) => (entry.title || entry.detail).trim().length > 0)
      .slice(-24)
      .map((entry) => ({
      id: `trail:${entry.id}`,
      title: summarizeTrailTitle(entry.title || entry.detail || "Agent trail"),
      detail: compact(entry.detail || entry.title, 200),
      source: entry.source,
      count: 1,
      pathState: entry.pathState,
    }));
    const fromPipeline = executionNarration.slice(-8).map((entry) => ({
      id: `pipeline:${entry.id}`,
      title: entry.title,
      detail: entry.detail,
      source: "pipeline",
      count: entry.count,
      pathState: undefined as "active" | "candidate" | "discarded" | undefined,
    }));
    const merged = fromAgentTrail.length > 0 ? fromAgentTrail : fromPipeline;
    const bySemantic = new Map<string, number>();
    const condensed: Array<{
      id: string;
      title: string;
      detail: string;
      source: string;
      count: number;
      pathState: "active" | "candidate" | "discarded" | undefined;
    }> = [];
    for (const entry of merged) {
      const semantic = `${narrationKey(entry.title)}::${narrationKey(entry.detail)}`;
      const existingIndex = bySemantic.get(semantic);
      if (existingIndex === undefined) {
        bySemantic.set(semantic, condensed.length);
        condensed.push(entry);
      } else {
        const existing = condensed[existingIndex];
        if (!existing) continue;
        existing.id = entry.id;
        existing.detail = entry.detail;
        existing.count += 1;
        if (entry.pathState) {
          existing.pathState = entry.pathState;
        }
      }
    }
    return condensed.slice(-12);
  }, [discoverEntries, executionNarration]);

  const recommendation = stream.finalBrief?.recommendation ?? stream.recommendation;
  const recommendationIsProvisional = Boolean(
    !stream.finalBrief?.recommendation && stream.recommendation?.provisional,
  );
  const graphPath = activePath ?? stream.pathUpdate;
  const liveTargetFallback = useMemo(() => {
    const diseaseNode = graphNodes.find((node) => node.type === "disease");
    if (!diseaseNode) return null;
    const topEdge = [...graphEdges]
      .filter(
        (edge) =>
          edge.type === "disease_target" &&
          edge.source === diseaseNode.id,
      )
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
    if (!topEdge) return null;
    const targetNode = graphNodes.find((node) => node.id === topEdge.target);
    if (!targetNode) return null;
    return String(targetNode.meta.targetSymbol ?? targetNode.label);
  }, [graphEdges, graphNodes]);
  const finalVerdictReady = !stream.isRunning &&
    !discoverIsRunning &&
    Boolean((!recommendationIsProvisional && recommendation) || liveTargetFallback || stream.finalBrief);
  const queryPlan = stream.queryPlan;
  const hasAgentFinalAnswer = Boolean(
    !stream.isRunning && agentFinalReadout?.answer && agentFinalReadout.answer.trim().length > 0,
  );
  const naturalLanguageBrief = useMemo(() => {
    if (hasAgentFinalAnswer && agentFinalReadout?.answer) {
      return compact(agentFinalReadout.answer, 240);
    }
    if (stream.isRunning || discoverIsRunning) {
      return graphPath?.summary
        ? `Live multihop investigation running. Active trail: ${graphPath.summary}.`
        : "Live multihop investigation running. I am expanding evidence branches and updating the graph.";
    }
    const bestTrail =
      graphPath?.summary ??
      bridgeAnalysis?.activeConnectedPath?.summary ??
      recommendation?.pathway ??
      "not provided";
    return `Agent synthesis unavailable for this run. Showing provisional evidence trail: ${bestTrail}.`;
  }, [
    hasAgentFinalAnswer,
    agentFinalReadout,
    graphPath?.summary,
    bridgeAnalysis?.activeConnectedPath?.summary,
    discoverIsRunning,
    recommendation,
    stream.isRunning,
  ]);

  const queryMode = useMemo(() => {
    const anchors = queryPlan?.anchors ?? [];
    const diseases = [...new Set(anchors.filter((item) => item.entityType === "disease").map((item) => item.name))];
    const hasBridgeIntent = /\b(connect|connection|between|relationship|overlap|link|latent|vs|versus)\b/i.test(
      submittedQuery,
    );
    const hasDrugIntent = anchors.some((item) => item.entityType === "drug");
    const hasTargetIntent = anchors.some((item) => item.entityType === "target");

    if (hasBridgeIntent || diseases.length >= 2) return "bridge";
    if (hasDrugIntent || hasTargetIntent) return "mechanism";
    return "explore";
  }, [queryPlan?.anchors, submittedQuery]);

  const queryAnchorsSummary = useMemo(() => {
    const anchors = queryPlan?.anchors ?? [];
    const uniqueDiseaseAnchors = [...new Set(anchors.filter((item) => item.entityType === "disease").map((item) => item.name))];
    if (uniqueDiseaseAnchors.length >= 2) {
      return uniqueDiseaseAnchors.slice(0, 2).join(" and ");
    }
    if (uniqueDiseaseAnchors.length === 1) {
      return uniqueDiseaseAnchors[0]!;
    }
    const fallback = anchors
      .slice(0, 2)
      .map((item) => item.name)
      .join(" and ");
    return fallback || submittedQuery;
  }, [queryPlan?.anchors, submittedQuery]);

  const scientificVerdict = useMemo(() => {
    const activeThread =
      graphPath?.summary ??
      bridgeAnalysis?.activeConnectedPath?.summary ??
      `${recommendation?.target ?? liveTargetFallback ?? "not provided"} in ${
        recommendation?.pathway ?? "not provided"
      }`;

    const score = recommendation?.score ?? 0;
    const confidenceLabel = recommendation
      ? score >= 0.78
        ? "High confidence"
        : score >= 0.65
          ? "Medium confidence"
          : "Exploratory"
      : bridgeAnalysis?.status === "connected"
        ? "Medium confidence"
        : "Exploratory";

    if (stream.isRunning || discoverIsRunning) {
      return {
        directAnswer:
          queryMode === "bridge"
            ? `I am testing whether ${queryAnchorsSummary} can be connected through an explicit multihop mechanism path.`
            : `I am building and ranking mechanism threads for "${submittedQuery}" as evidence streams in.`,
        mechanismThread: activeThread,
        verdictType: "pending" as const,
        confidence: "In progress",
      };
    }

    if (hasAgentFinalAnswer && agentFinalReadout?.answer) {
      const focusThread = [
        agentFinalReadout.focusThread.pathway,
        agentFinalReadout.focusThread.target,
        agentFinalReadout.focusThread.drug,
      ]
        .filter((item) => item && item !== "not provided")
        .join(" -> ");
      return {
        directAnswer: agentFinalReadout.answer,
        mechanismThread: focusThread || activeThread,
        verdictType: bridgeAnalysis?.status === "connected" ? ("connected" as const) : ("ranked" as const),
        confidence: confidenceLabel,
      };
    }

    if (queryMode === "bridge") {
      const bridgeContext =
        graphPath?.summary ??
        bridgeAnalysis?.activeConnectedPath?.summary ??
        `${queryAnchorsSummary} (no explicit multihop chain closed)`;
      if (bridgeAnalysis?.status === "connected") {
        return {
          directAnswer:
            "Agent final synthesis is missing for this run. A connected multihop trail is present in the graph and should be interpreted as provisional evidence.",
          mechanismThread: bridgeContext,
          verdictType: "connected" as const,
          confidence: confidenceLabel,
        };
      }
      if (bridgeAnalysis?.status === "no_connection") {
        return {
          directAnswer:
            "Agent final synthesis is missing for this run. No complete multihop bridge was closed; the graph keeps unresolved anchor gaps explicit.",
          mechanismThread: bridgeContext,
          verdictType: "no_connection" as const,
          confidence: "Exploratory only",
        };
      }
    }

    return {
      directAnswer:
        "Agent final synthesis is missing for this run. Showing a provisional evidence readout from the active graph state.",
      mechanismThread: activeThread,
      verdictType: recommendation && score >= 0.65 ? ("ranked" as const) : ("partial" as const),
      confidence: recommendation ? confidenceLabel : "Low confidence",
    };
  }, [
    hasAgentFinalAnswer,
    agentFinalReadout,
    bridgeAnalysis,
    graphPath?.summary,
    liveTargetFallback,
    queryAnchorsSummary,
    queryMode,
    recommendation,
    discoverIsRunning,
    stream.isRunning,
    submittedQuery,
  ]);
  const queryAnswer = scientificVerdict.directAnswer;

  const decisionCard = useMemo(() => {
    const score = recommendation?.score ?? 0;
    const caveats = stream.finalBrief?.caveats ?? [];
    const penalty = caveats.reduce((acc, item) => {
      const lowered = item.toLowerCase();
      if (lowered.includes("degraded")) return acc + 2;
      if (lowered.includes("query concept mismatch")) return acc + 2;
      if (lowered.includes("no literature")) return acc + 1;
      if (lowered.includes("no trial")) return acc + 1;
      return acc;
    }, 0);

    if (!recommendation) {
      return {
        action: "Building evidence map",
        confidence: "In progress",
        rationale: "Final ranking is still synthesizing.",
      };
    }

    if (recommendationIsProvisional) {
      return {
        action: "Preliminary lead",
        confidence: "Evidence still updating",
        rationale: "Live graph evidence is available; final ranking still refining.",
      };
    }

    if (score >= 0.78 && penalty <= 1) {
      return {
        action: "Advance to validation",
        confidence: "High confidence",
        rationale: "Strong evidence score with limited data penalties.",
      };
    }

    if (score >= 0.65) {
      return {
        action: "Hold + validate",
        confidence: penalty >= 3 ? "Moderate confidence" : "Medium confidence",
        rationale: "Signal is usable but requires focused de-risking experiments.",
      };
    }

    return {
      action: "Exploratory only",
      confidence: "Low confidence",
      rationale: "Weak or incomplete signal for decision-grade nomination.",
    };
  }, [recommendation, recommendationIsProvisional, stream.finalBrief?.caveats]);

  const scoreBreakdown = useMemo(() => {
    const target = recommendation?.target;
    if (!target) return [];
    const trace = stream.finalBrief?.evidenceTrace?.find((item) => item.symbol === target);
    if (!trace) return [];

    const preferredFields = [
      "openTargetsEvidence",
      "drugActionability",
      "networkCentrality",
      "literatureSupport",
      "drugCount",
      "interactionCount",
    ];

    return trace.refs
      .filter((ref) => preferredFields.includes(ref.field))
      .slice(0, 6)
      .map((ref) => ({
        label: ref.field,
        value: String(ref.value),
      }));
  }, [recommendation?.target, stream.finalBrief?.evidenceTrace]);

  const evidenceSnapshot = useMemo(() => {
    const caveats = stream.finalBrief?.caveats ?? [];
    let articleSnippets = 0;
    let trialSnippets = 0;
    for (const item of caveats) {
      const articleHit = item.match(/(\d+)\s+article snippets provided/i);
      if (articleHit) {
        articleSnippets = Math.max(articleSnippets, Number(articleHit[1] ?? "0"));
      }
      const trialHit = item.match(/(\d+)\s+trial snippets provided/i);
      if (trialHit) {
        trialSnippets = Math.max(trialSnippets, Number(trialHit[1] ?? "0"));
      }
    }
    const caveatCount = caveats.filter((item) => !/snippets provided/i.test(item)).length;
    return {
      articleSnippets,
      trialSnippets,
      caveatCount,
    };
  }, [stream.finalBrief?.caveats]);

  const verdictCitations = useMemo(
    () => (stream.finalBrief?.citations ?? []).slice(0, 6),
    [stream.finalBrief?.citations],
  );
  const citationSuffix = verdictCitations.length
    ? ` ${verdictCitations.map((citation) => `[${citation.index}]`).join(" ")}`
    : "";
  const appendCitationSuffix = !hasAgentFinalAnswer && citationSuffix.length > 0;

  const verdictTarget = recommendation?.target ?? liveTargetFallback ?? "not resolved";
  const verdictPathway = recommendation?.pathway ?? "not provided";
  const verdictHeadingTarget = queryMode === "bridge" ? queryAnchorsSummary : verdictTarget;
  const verdictHeadingPathway = queryMode === "bridge" ? "multihop evidence thread" : verdictPathway;

  const runBrief = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (stream.isRunning) return;

    if (typeof window !== "undefined") {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("query", trimmed);
      if (diseaseIdOverride) {
        nextUrl.searchParams.set("diseaseId", diseaseIdOverride);
      } else {
        nextUrl.searchParams.delete("diseaseId");
      }
      if (diseaseNameOverride) {
        nextUrl.searchParams.set("diseaseName", diseaseNameOverride);
      } else {
        nextUrl.searchParams.delete("diseaseName");
      }
      window.history.replaceState({ query: trimmed }, "", `${nextUrl.pathname}?${nextUrl.searchParams.toString()}`);
    }

    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setActivePath(null);
    activePathRef.current = null;
    setWashedPaths([]);
    setBridgeAnalysis(null);
    setAgentFinalReadout(null);
    setDiscoverEntries([]);
    setDiscoverStatusMessage(null);
    setDiscoverElapsedMs(null);
    setSubmittedQuery(trimmed);
    setRunSequence((prev) => prev + 1);

    stream.start({
      query: trimmed,
      diseaseId: diseaseIdOverride,
      diseaseName: diseaseNameOverride,
    });
  };

  const buildPathForTargetSymbol = useCallback(
    (targetSymbol: string): PathUpdate | null => {
      const diseaseNode = graphNodes.find((node) => node.type === "disease");
      if (!diseaseNode) return null;

      const upper = targetSymbol.trim().toUpperCase();
      const targetNode = graphNodes.find((node) => {
        if (node.type !== "target") return false;
        const symbol = String(node.meta.targetSymbol ?? node.label).toUpperCase();
        return symbol === upper;
      });
      if (!targetNode) return null;

      const diseaseEdge = [...graphEdges]
        .filter(
          (edge) =>
            edge.type === "disease_target" &&
            edge.source === diseaseNode.id &&
            edge.target === targetNode.id,
        )
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
      if (!diseaseEdge) return null;

      const pathwayEdge = [...graphEdges]
        .filter((edge) => edge.type === "target_pathway" && edge.source === targetNode.id)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
      const drugEdge = [...graphEdges]
        .filter((edge) => edge.type === "target_drug" && edge.source === targetNode.id)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];

      const nodeIds = new Set<string>([diseaseNode.id, targetNode.id]);
      const edgeIds = new Set<string>([diseaseEdge.id]);
      let summary = `${diseaseNode.label} -> ${targetNode.label}`;

      if (pathwayEdge) {
        nodeIds.add(pathwayEdge.target);
        edgeIds.add(pathwayEdge.id);
        const pathwayNode = graphNodes.find((node) => node.id === pathwayEdge.target);
        if (pathwayNode) summary += ` -> ${pathwayNode.label}`;
      }

      if (drugEdge) {
        nodeIds.add(drugEdge.target);
        edgeIds.add(drugEdge.id);
        const drugNode = graphNodes.find((node) => node.id === drugEdge.target);
        if (drugNode) summary += ` -> ${drugNode.label}`;
      }

      return {
        nodeIds: [...nodeIds],
        edgeIds: [...edgeIds],
        summary: compact(summary),
      };
    },
    [graphEdges, graphNodes],
  );

  const alternativePaths = useMemo(() => {
    const alternatives = stream.finalBrief?.alternatives;
    if (!alternatives?.length) return [];
    return alternatives
      .slice(0, 3)
      .map((item) => buildPathForTargetSymbol(item.symbol))
      .filter((item): item is PathUpdate => Boolean(item));
  }, [buildPathForTargetSymbol, stream.finalBrief]);

  const mergedWashedPaths = useMemo(() => {
    const activeSignature = pathSignature(activePath);
    const seen = new Set<string>();
    const merged: PathUpdate[] = [];

    for (const item of [...washedPaths, ...alternativePaths]) {
      const signature = pathSignature(item);
      if (!signature || signature === activeSignature || seen.has(signature)) continue;
      seen.add(signature);
      merged.push(item);
      if (merged.length >= 10) break;
    }

    return merged;
  }, [activePath, alternativePaths, washedPaths]);

  const focusEntities = useCallback(
    (entities: DiscoverEntity[], pathState: DiscoveryPathState = "active") => {
      if (entities.length === 0) return;
      const entityLabels = entities
        .map((entity) => entity.label.trim())
        .filter((label) => label.length > 0)
        .slice(0, 6);

      const nodeIds = entities
        .map((entity) => {
          if (entity.primaryId) {
            const byPrimary = graphNodes.find(
              (node) => node.type === entity.type && node.primaryId === entity.primaryId,
            );
            if (byPrimary) return byPrimary.id;
          }

          const normalizedLabel = entity.label.trim().toUpperCase();
          const byLabel = graphNodes.find(
            (node) => node.type === entity.type && node.label.trim().toUpperCase() === normalizedLabel,
          );
          if (byLabel) return byLabel.id;

          if (entity.type === "target") {
            const bySymbol = graphNodes.find(
              (node) =>
                node.type === "target" &&
                String(node.meta.targetSymbol ?? node.label).trim().toUpperCase() === normalizedLabel,
            );
            if (bySymbol) return bySymbol.id;
          }

          return null;
        })
        .filter((id): id is string => Boolean(id));

      if (nodeIds.length === 0) {
        const virtualNodeIds = entityLabels.map((label) =>
          `virtual:${label.toLowerCase().replace(/\s+/g, "-")}`,
        );
        const fallbackPath: PathUpdate = {
          nodeIds: virtualNodeIds,
          edgeIds: [],
          summary: compact(
            `DeepAgents ${pathState} path: ${
              entityLabels.length > 0 ? entityLabels.join(" -> ") : "entity branch"
            }`,
          ),
        };

        if (pathState === "discarded") {
          setWashedPaths((prev) => [fallbackPath, ...prev].slice(0, 8));
          return;
        }
        setWashedPaths((prev) => [fallbackPath, ...prev].slice(0, 8));
        return;
      }

      const uniqueNodeIds = [...new Set(nodeIds)];
      const edgeIds = new Set<string>();
      for (let index = 0; index < uniqueNodeIds.length - 1; index += 1) {
        const source = uniqueNodeIds[index]!;
        const target = uniqueNodeIds[index + 1]!;
        const edge = graphEdges.find(
          (item) =>
            (item.source === source && item.target === target) ||
            (item.source === target && item.target === source),
        );
        if (edge) edgeIds.add(edge.id);
      }

      const labels = uniqueNodeIds
        .map((id) => graphNodes.find((node) => node.id === id)?.label ?? id)
        .slice(0, 6);
      const nextPath: PathUpdate = {
        nodeIds: uniqueNodeIds,
        edgeIds: [...edgeIds],
        summary: compact(`DeepAgents ${pathState} path: ${labels.join(" -> ")}`),
      };

      const edgeById = new Map(graphEdges.map((edge) => [edge.id, edge]));
      const hasOnlyQueryAnchorEdges =
        nextPath.edgeIds.length > 0 &&
        nextPath.edgeIds.every((edgeId) => isQueryAnchorBridgeEdge(edgeById.get(edgeId)));
      const hasStableMechanisticActivePath = hasExplicitMechanisticPath(activePathRef.current, graphEdges);

      if (
        pathState !== "discarded" &&
        hasStableMechanisticActivePath &&
        (hasOnlyQueryAnchorEdges || nextPath.edgeIds.length === 0)
      ) {
        setWashedPaths((prev) => [nextPath, ...prev].slice(0, 8));
        setSelectedNodeId(uniqueNodeIds[uniqueNodeIds.length - 1] ?? null);
        return;
      }

      if (pathState === "discarded") {
        setWashedPaths((prev) => [nextPath, ...prev].slice(0, 8));
        return;
      }
      if (uniqueNodeIds.length >= 2 && edgeIds.size === 0) {
        setWashedPaths((prev) => [nextPath, ...prev].slice(0, 8));
        return;
      }

      const previous = activePathRef.current;
      const previousSignature = pathSignature(previous);
      const nextSignature = pathSignature(nextPath);
      if (previous && previousSignature !== nextSignature) {
        setWashedPaths((prev) => [previous, ...prev].slice(0, 8));
      }

      activePathRef.current = nextPath;
      setActivePath(nextPath);
      setSelectedNodeId(uniqueNodeIds[uniqueNodeIds.length - 1] ?? null);
    },
    [graphEdges, graphNodes],
  );

  const topStatus = stream.status?.message ?? "Preparing run";
  const runLabel = "Multi-hop search";
  const runDescription =
    "Exhaustive traversal across entities, pathways, compounds, interactions, and literature.";
  const resolvedDiseaseId =
    diseaseIdOverride ?? stream.resolverSelection?.selected?.id ?? initialDiseaseId ?? null;
  const deepDiscoverDiseaseQuery = submittedQuery;
  const deepDiscoverAutoStart = submittedQuery.trim().length > 0;
  const deepDiscoverAutoStartKey = `${runSequence}:${submittedQuery
    .trim()
    .toLowerCase()}:${resolvedDiseaseId ?? "pending"}`;

  return (
    <main className="min-h-screen bg-transparent pb-6 text-[#252c52]">
      <header className="sticky top-0 z-40 border-b border-[#d6dbf3] bg-white/95 px-3 py-2 backdrop-blur md:px-6">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2">
            <Badge className="rounded-full bg-[#4d47d8] px-3 py-1 text-white">TargetGraph</Badge>
            <Button
              size="sm"
              variant="secondary"
              className="border-[#d6dbf3] bg-[#f2f3ff] text-[#4b4ea1] hover:bg-[#eceeff]"
              onClick={() => router.push("/")}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Main search
            </Button>
            <Badge className="rounded-full border border-[#d6dbf3] bg-[#f7f8ff] text-[#50598b]">
              {stream.resolverSelection?.selected?.name ?? initialQuery}
            </Badge>
          </div>

          <div className="grid w-full gap-2 xl:w-[820px] xl:grid-cols-[minmax(0,1fr)_160px_152px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#6670a8]" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setDiseaseIdOverride(null);
                  setDiseaseNameOverride(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runBrief();
                }}
                placeholder="Ask one multihop biomedical question"
                className="h-9 w-full rounded-lg border border-[#d6dbf3] bg-[#f9f9ff] pl-9 pr-3 text-sm text-[#232c58] outline-none ring-[#4d47d8] placeholder:text-[#7c83ac] focus:ring-2"
              />
            </div>

            <Button
              className="h-9 bg-[#4d47d8] text-white hover:bg-[#403ab8] disabled:cursor-not-allowed disabled:opacity-55"
              onClick={runBrief}
              disabled={stream.isRunning}
            >
              {stream.isRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Generate brief
            </Button>

            <Button
              className="h-9 border-[#d6dbf3] bg-[#f2f3ff] text-[#4b4ea1] hover:bg-[#eceeff]"
              variant="secondary"
              onClick={() => void stream.interrupt()}
              disabled={!stream.isRunning}
            >
              Interrupt
            </Button>
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[#505b8d]">
          <span className="rounded-full border border-[#d6dbf3] bg-[#f7f8ff] px-3 py-1">
            Search mode: {runLabel}
          </span>
          <span className="rounded-full border border-[#d6dbf3] bg-[#f7f8ff] px-3 py-1">
            {runDescription}
          </span>
          <span className="rounded-full border border-[#d6dbf3] bg-[#f7f8ff] px-3 py-1">{topStatus}</span>
          {queryPlan ? (
            <span className="rounded-full border border-[#d6dbf3] bg-[#f7f8ff] px-3 py-1">
              Query plan: {queryPlan.anchors.length} anchors
            </span>
          ) : null}
        </div>
      </header>

      <section className="px-3 pb-0 pt-2 md:px-6">
        <Card className="border-[#d6dbf3] bg-white/96">
          <CardContent className="space-y-1.5 py-2 text-xs text-[#48558a]">
            <div className="grid gap-1.5 md:grid-cols-[1.6fr_1fr_1fr]">
              <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-2.5 py-1.5">
                <div className="text-[10px] uppercase tracking-[0.12em] text-[#6a64b3]">Direct answer</div>
                <div className="mt-0.5 text-[12px] leading-5 text-[#353f7a]">
                  {queryAnswer}
                  {!stream.isRunning && appendCitationSuffix ? citationSuffix : ""}
                </div>
                <div className="mt-1 text-[11px] text-[#606d9f]">
                  {stream.isRunning
                    ? "Live evidence stream in progress."
                    : "Synthesized from active path evidence and caveats."}
                </div>
              </div>

              <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-2.5 py-1.5">
                <div className="text-[10px] uppercase tracking-[0.12em] text-[#6a64b3]">Primary thread</div>
                <div className="mt-0.5 flex items-center gap-2 text-base font-semibold text-[#303f7f]">
                  <span>{recommendation?.target ?? liveTargetFallback ?? "Building..."}</span>
                  {recommendationIsProvisional ? (
                    <Badge className="border border-[#cbc7fa] bg-[#eeebff] text-[10px] font-medium text-[#4c5199]">
                      provisional
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 text-[11px] text-[#606d9f]">
                  {scientificVerdict.mechanismThread}
                </div>
              </div>

              <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-2.5 py-1.5">
                <div className="text-[10px] uppercase tracking-[0.12em] text-[#6a64b3]">Evidence quality</div>
                <div className="mt-0.5 font-semibold text-[#303f7f]">{decisionCard.action}</div>
                <div className="text-[11px] text-[#606d9f]">{scientificVerdict.confidence}</div>
                <div className="mt-1 text-[11px] text-[#606d9f]">
                  Score {recommendation ? recommendation.score.toFixed(3) : "pending"}
                </div>
                <div className="mt-1 text-[11px] text-[#606d9f]">
                  {evidenceSnapshot.articleSnippets} articles • {evidenceSnapshot.trialSnippets} trials • {evidenceSnapshot.caveatCount} caveats
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-2.5 py-1.5 text-[12px] text-[#3f4e8a]">
              {naturalLanguageBrief}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="px-3 pt-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1 rounded-full border border-[#d4d0fb] bg-[#f4f1ff] px-2.5 py-1 text-xs font-medium text-[#4b49a2]">
              <span className={`h-1.5 w-1.5 rounded-full ${stream.isRunning ? "animate-pulse bg-[#4f46e5]" : "bg-[#7b7fb3]"}`} />
              Live Search
            </div>
            <div className="text-[11px] text-[#607797]">
              Graph + narration + verdict update continuously in one workspace.
            </div>
          </div>

          <Sheet>
            <SheetTrigger asChild>
              <Button
                size="sm"
                variant="secondary"
                className="border-[#d6e1f3] bg-[#f1f6ff] text-[#305b9e] hover:bg-[#e8f0ff]"
              >
                <PanelRightOpen className="h-3.5 w-3.5" /> Details
              </Button>
            </SheetTrigger>
            <SheetContent className="w-full border-l border-[#dbe4f2] bg-[#f9fbff] sm:max-w-[430px]">
              <SheetHeader className="pb-0">
                <SheetTitle className="text-[#28446d]">Run Details</SheetTitle>
                <SheetDescription className="text-[#5a7195]">
                  Resolver, source health, node/edge inspector, and export controls.
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-3 overflow-y-auto px-4 pb-4 text-xs text-[#3f557b]">
                <Card className="border-[#dbe4f2] bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-[#2a456f]">Run Health</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                      <div className="flex items-center gap-1 font-semibold text-[#375782]">
                        <Clock3 className="h-3.5 w-3.5" /> Status
                      </div>
                      <div className="mt-1 text-[#5a7297]">{stream.status?.message ?? "initializing"}</div>
                      <div className="mt-1 text-[11px] text-[#6b82a3]">Session {stream.runSessionId.slice(0, 8)}</div>
                    </div>
                    <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                      <div className="mb-1 font-semibold text-[#375782]">Source health</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(activeSourceHealth).map(([source, health]) => (
                          <span
                            key={source}
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sourceBadgeTone(health)}`}
                          >
                            {source}
                          </span>
                        ))}
                      </div>
                    </div>
                    {stream.errors.length > 0 ? (
                      <div className="rounded-lg border border-[#ead8c6] bg-[#fff7ef] p-2 text-[#915b2d]">
                        {stream.errors.slice(-2).map((error, index) => (
                          <div key={`${error}-${index}`}>• {error}</div>
                        ))}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card className="border-[#dbe4f2] bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-[#2a456f]">Disease Resolver</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {stream.resolverSelection ? (
                      <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                        <div className="font-semibold text-[#31507f]">{stream.resolverSelection.selected.name}</div>
                        <div className="text-[11px] text-[#6b82a3]">{stream.resolverSelection.selected.id}</div>
                        <div className="mt-1 text-[11px] text-[#6b82a3]">{stream.resolverSelection.rationale}</div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2 text-[#6c84a4]">
                        Resolving disease entity...
                      </div>
                    )}

                    {stream.resolverCandidates.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {stream.resolverCandidates.slice(0, 10).map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setDiseaseIdOverride(item.id);
                              setDiseaseNameOverride(item.name);
                            }}
                            className={`rounded-full border px-2 py-0.5 text-[10px] ${
                              diseaseIdOverride === item.id
                                ? "border-[#a7bfeb] bg-[#edf4ff] text-[#315992]"
                                : "border-[#dbe4f2] bg-white text-[#56719a]"
                            }`}
                          >
                            {item.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card className="border-[#dbe4f2] bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-[#2a456f]">Query Plan</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {!queryPlan ? (
                      <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2 text-[#6c84a4]">
                        Planning anchors and constraints...
                      </div>
                    ) : (
                      <>
                        <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                          <div className="text-[11px] uppercase tracking-[0.12em] text-[#6881a4]">Intent</div>
                          <div className="font-semibold text-[#31507f]">{queryPlan.intent}</div>
                          <div className="mt-1 text-[11px] text-[#6b82a3]">{queryPlan.rationale}</div>
                        </div>

                        <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                          <div className="mb-1 font-semibold text-[#375782]">Anchors</div>
                          <div className="flex flex-wrap gap-1.5">
                            {queryPlan.anchors.slice(0, 12).map((anchor) => (
                              <span
                                key={`${anchor.entityType}:${anchor.id}`}
                                className="rounded-full border border-[#d8e4f5] bg-white px-2 py-0.5 text-[10px] text-[#56719a]"
                              >
                                {anchor.name} ({anchor.entityType})
                              </span>
                            ))}
                          </div>
                        </div>

                        {queryPlan.constraints.length > 0 ? (
                          <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                            <div className="mb-1 font-semibold text-[#375782]">Constraints</div>
                            {queryPlan.constraints.slice(0, 6).map((constraint) => (
                              <div key={`${constraint.polarity}-${constraint.text}`} className="text-[11px] text-[#607a9d]">
                                {constraint.polarity}: {constraint.text}
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {queryPlan.followups.length > 0 ? (
                          <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                            <div className="mb-1 font-semibold text-[#375782]">Follow-ups</div>
                            {queryPlan.followups.slice(0, 5).map((followup, index) => (
                              <div key={followup.question} className="text-[11px] text-[#607a9d]">
                                {index + 1}. {followup.question}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-[#dbe4f2] bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-[#2a456f]">Graph Inspector</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {!selectedNode && !selectedEdge ? (
                      <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2 text-[#6c84a4]">
                        Click a graph node or edge to inspect properties.
                      </div>
                    ) : (
                      <>
                        {selectedNode ? (
                          <>
                            <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                              <div className="text-sm font-semibold text-[#284872]">{selectedNode.label}</div>
                              <div className="text-[11px] text-[#6681a3]">{selectedNode.type}</div>
                              <div className="text-[11px] text-[#6681a3]">{selectedNode.primaryId}</div>
                            </div>
                            <div className="max-h-[220px] space-y-1 overflow-auto pr-1">
                              {Object.entries(selectedNode.meta).map(([key, value]) => (
                                <div key={key} className="rounded-md border border-[#e4ebf6] bg-white px-2 py-1.5">
                                  <div className="text-[10px] uppercase tracking-[0.12em] text-[#7a8fae]">{key}</div>
                                  <div className="break-words text-[11px] text-[#3f597f]">
                                    {typeof value === "string" ? value : JSON.stringify(value)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : null}
                        {selectedEdge ? (
                          <>
                            <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                              <div className="text-sm font-semibold text-[#284872]">{selectedEdge.type}</div>
                              <div className="text-[11px] text-[#6681a3]">
                                {graphNodes.find((node) => node.id === selectedEdge.source)?.label ??
                                  selectedEdge.source}{" "}
                                {"->"}{" "}
                                {graphNodes.find((node) => node.id === selectedEdge.target)?.label ??
                                  selectedEdge.target}
                              </div>
                              <div className="text-[11px] text-[#6681a3]">Weight {(selectedEdge.weight ?? 0).toFixed(3)}</div>
                            </div>
                            <div className="max-h-[220px] space-y-1 overflow-auto pr-1">
                              {Object.entries(selectedEdge.meta).map(([key, value]) => (
                                <div
                                  key={key}
                                  className="rounded-md border border-[#e4ebf6] bg-white px-2 py-1.5"
                                >
                                  <div className="text-[10px] uppercase tracking-[0.12em] text-[#7a8fae]">{key}</div>
                                  <div className="break-words text-[11px] text-[#3f597f]">
                                    {typeof value === "string" ? value : JSON.stringify(value)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : null}
                      </>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-[#dbe4f2] bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-[#2a456f]">Case Actions</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Button
                      size="sm"
                      className="w-full bg-[#2f5ca4] text-white hover:bg-[#264b86] disabled:opacity-55"
                      onClick={runBrief}
                      disabled={stream.isRunning}
                    >
                      <Play className="h-3.5 w-3.5" /> Run query
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full border-[#d6e1f3] bg-[#f1f6ff] text-[#315c9f] hover:bg-[#e8f0ff]"
                      onClick={() => void stream.interrupt()}
                      disabled={!stream.isRunning}
                    >
                      Interrupt active query
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full border-[#d6e1f3] bg-[#f1f6ff] text-[#315c9f] hover:bg-[#e8f0ff]"
                      onClick={() => {
                        downloadJson(
                          {
                            query,
                            mode: "multihop",
                            resolver: stream.resolverSelection,
                            recommendation,
                            finalBrief: stream.finalBrief,
                            nodes: graphNodes,
                            edges: graphEdges,
                            steps: stream.agentSteps,
                            activePath: graphPath,
                            washedPaths: mergedWashedPaths,
                            bridgeAnalysis,
                            agentFinalReadout,
                            selectedEdge,
                          },
                          `targetgraph-brief-${query.replace(/\s+/g, "-").toLowerCase()}.json`,
                        );
                      }}
                    >
                      <Download className="h-3.5 w-3.5" /> Export brief JSON
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </SheetContent>
          </Sheet>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(350px,0.72fr)]">
          <Card className="border-[#d9d4fb] bg-white">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm text-[#2a456f]">Interactive Mechanism Network</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#4d668b]">
                  <div className="flex items-center gap-1 rounded-md border border-[#ddd9fb] bg-[#f7f4ff] px-2 py-1.5">
                    <span>Pathways</span>
                    <Switch checked={showPathwayContext} onCheckedChange={setShowPathwayContext} />
                  </div>
                  <div className="flex items-center gap-1 rounded-md border border-[#ddd9fb] bg-[#f7f4ff] px-2 py-1.5">
                    <span>Drugs</span>
                    <Switch checked={showDrugContext} onCheckedChange={setShowDrugContext} />
                  </div>
                  <div className="flex items-center gap-1 rounded-md border border-[#ddd9fb] bg-[#f7f4ff] px-2 py-1.5">
                    <span>Interactions</span>
                    <Switch checked={showInteractionContext} onCheckedChange={setShowInteractionContext} />
                  </div>
                  {stream.isRunning ? (
                    <Badge className="border border-[#cbc8fb] bg-[#efebff] text-[#4f4da5]">Live</Badge>
                  ) : null}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <PathFirstGraph
                query={submittedQuery}
                queryPlan={queryPlan}
                nodes={graphNodes}
                edges={graphEdges}
                pathUpdate={graphPath}
                washedPathUpdates={mergedWashedPaths}
                showPathwayContext={showPathwayContext}
                showDrugContext={showDrugContext}
                showInteractionContext={showInteractionContext}
                isRunning={stream.isRunning}
                onSelectNode={setSelectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onSelectEdge={setSelectedEdgeId}
                onBridgeAnalysisChange={setBridgeAnalysis}
              />
            </CardContent>
          </Card>

          <div className="space-y-2.5">
            <Card className="border-[#d9d4fb] bg-white">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-[#2a456f]">Live Narration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-[#4f688d]">
                <div className="rounded-lg border border-[#d9d4fb] bg-[#f7f4ff] px-2.5 py-2">
                  <div className="font-semibold text-[#3a3a8a]">
                    {discoverStatusMessage ?? stream.status?.message ?? "Initializing search pipeline"}
                  </div>
                  <div className="mt-1 text-[11px] text-[#6166a3]">
                    {phaseSummaryMap[stream.status?.phase ?? ""] ?? "Streaming evidence from connected sources."}
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#ddd9f8]">
                    <div
                      className="h-full rounded-full bg-[#4f46e5] transition-all duration-500"
                      style={{ width: `${Math.max(4, Math.min(100, stream.status?.pct ?? 0))}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-[#696ea6]">
                    Progress {Math.max(0, Math.min(100, Math.round(stream.status?.pct ?? 0)))}%
                  </div>
                  {discoverElapsedMs !== null ? (
                    <div className="mt-1 text-[10px] text-[#696ea6]">
                      Agentic trail {Math.max(0, Math.round(discoverElapsedMs / 1000))}s
                    </div>
                  ) : null}
                  {stream.isRunning && secondsSinceNarration >= 8 ? (
                    <div className="mt-1 text-[11px] text-[#525aa3]">
                      Still working, last narrative update {secondsSinceNarration}s ago.
                    </div>
                  ) : null}
                </div>

                {graphPath ? (
                  <div className="rounded-lg border border-[#d2cffa] bg-[#f4f2ff] px-2.5 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5445a8]">
                      Active path
                    </div>
                    <div className="mt-1 text-[11px] text-[#4f4d95]">{graphPath.summary}</div>
                  </div>
                ) : null}

                <div className="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
                  {mergedLiveNarration.length > 0 ? (
                    mergedLiveNarration.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-md border border-[#e1defa] bg-[#faf9ff] px-2 py-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-[#4a4aa0]">{entry.title}</div>
                          <div className="flex items-center gap-1">
                            <span className="rounded-full border border-[#d8d4f8] bg-white px-1.5 py-0.5 text-[10px] text-[#676ca8]">
                              {entry.source}
                            </span>
                            {entry.pathState ? (
                              <span className="rounded-full border border-[#d8d4f8] bg-white px-1.5 py-0.5 text-[10px] text-[#676ca8]">
                                {entry.pathState}
                              </span>
                            ) : null}
                            {entry.count > 1 ? (
                              <span className="rounded-full border border-[#d8d4f8] bg-white px-1.5 py-0.5 text-[10px] text-[#676ca8]">
                                {entry.count}x
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="text-[11px] text-[#6369a1]">{entry.detail}</div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-md border border-[#e1defa] bg-[#faf9ff] px-2 py-1.5 text-[11px] text-[#6369a1]">
                      Waiting for first trail updates...
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <DeepDiscoverer
              diseaseQuery={deepDiscoverDiseaseQuery}
              diseaseId={resolvedDiseaseId}
              seedQuestion={submittedQuery}
              autoStart={deepDiscoverAutoStart}
              autoStartKey={deepDiscoverAutoStartKey}
              autoFocusLatest={false}
              hideFinalReadout
              compact
              hidePanel
              onFinalReadout={setAgentFinalReadout}
              onFocusEntities={focusEntities}
              onEntriesChange={(payload) => {
                setDiscoverEntries(payload.entries);
                setDiscoverIsRunning(payload.isRunning);
                setDiscoverStatusMessage(payload.statusMessage);
                setDiscoverElapsedMs(payload.elapsedMs);
              }}
            />
          </div>
        </div>

        <Card className="mt-3 border-[#d9d4fb] bg-white">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-[#2a456f]">Final scientific answer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-[#35557f]">
            {stream.isRunning ? (
              <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-3 py-2.5">
                <div className="font-semibold text-[#47429d]">Final verdict pending</div>
                <div className="mt-1 text-[13px] text-[#4f5d91]">{scientificVerdict.directAnswer}</div>
                <div className="mt-1 text-[12px] text-[#6170a2]">
                  Active thread: {scientificVerdict.mechanismThread}
                </div>
                <div className="mt-1 text-[12px] text-[#6170a2]">
                  Current phase: {phaseSummaryMap[stream.status?.phase ?? ""] ?? "Streaming evidence"} (
                  {Math.max(0, Math.min(100, Math.round(stream.status?.pct ?? 0)))}%)
                </div>
              </div>
            ) : finalVerdictReady ? (
              <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-3 py-2.5">
                <div className="font-semibold text-[#47429d]">
                  {hasAgentFinalAnswer
                    ? "Agent scientific answer"
                    : `${verdictHeadingTarget} in ${verdictHeadingPathway}`}
                </div>
                <div className="mt-1 text-[13px] text-[#4f5d91]">
                  {scientificVerdict.directAnswer}
                  {appendCitationSuffix ? citationSuffix : ""}
                </div>
                <div className="mt-1 text-[12px] text-[#6170a2]">
                  Mechanistic thread: {scientificVerdict.mechanismThread}
                </div>
                <div className="mt-1 text-[12px] text-[#6170a2]">
                  Score {recommendation ? recommendation.score.toFixed(3) : "partial"} • Decision: {decisionCard.action}
                </div>
                {bridgeAnalysis?.status === "connected" ? (
                  <div className="mt-1 text-[12px] text-[#2f6f57]">
                    Explicit anchor bridge: connected.
                  </div>
                ) : null}
                {bridgeAnalysis?.status === "no_connection" ? (
                  <div className="mt-1 text-[12px] text-[#6845ad]">
                    Explicit anchor bridge: no-connection (broken bridge shown in graph).
                  </div>
                ) : null}
                {agentFinalReadout?.keyFindings?.length ? (
                  <div className="mt-2 rounded-md border border-[#ddd9fb] bg-white px-2.5 py-2 text-[11px] text-[#576597]">
                    {agentFinalReadout.keyFindings.slice(0, 3).map((item) => (
                      <div key={item}>• {item}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-3 py-2.5">
                <div className="font-semibold text-[#47429d]">No decisive thread yet</div>
                <div className="mt-1 text-[13px] text-[#4f5d91]">
                  The run ended without a stable mechanism thread. Review washed paths and caveats.
                </div>
              </div>
            )}
            {stream.finalBrief?.caveats?.length ? (
              <div className="rounded-lg border border-[#ddd9fb] bg-[#f7f4ff] px-2.5 py-2 text-xs text-[#665ca3]">
                {stream.finalBrief.caveats.slice(0, 3).map((item) => (
                  <div key={item}>• {item}</div>
                ))}
              </div>
            ) : null}
            {verdictCitations.length > 0 ? (
              <div className="rounded-lg border border-[#ddd9fb] bg-white px-2.5 py-2 text-xs text-[#57608f]">
                <div className="mb-1 font-semibold text-[#4a4898]">References</div>
                <div className="space-y-1.5">
                  {verdictCitations.map((citation) => (
                    <div key={`${citation.kind}-${citation.index}`} className="rounded-md border border-[#e1dff9] bg-[#f9f8ff] px-2 py-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[#4d48a6]">[{citation.index}]</span>
                        <span className="rounded-full border border-[#ddd9fb] bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#6a65a9]">
                          {citation.kind}
                        </span>
                        <span className="text-[10px] text-[#6d79ad]">{citation.source}</span>
                      </div>
                      {citation.url ? (
                        <a
                          href={citation.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-0.5 block text-[11px] text-[#3d53a0] underline underline-offset-2 hover:text-[#2c3d7b]"
                        >
                          {citation.label}
                        </a>
                      ) : (
                        <div className="mt-0.5 text-[11px] text-[#4d5f95]">{citation.label}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="mt-3 border-[#d9d4fb] bg-white">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-[#2a456f]">Evidence insights</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs text-[#4f678b]">
            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded-lg border border-[#e1e9f5] bg-[#f8fbff] p-2">
                <div className="mb-1 font-semibold text-[#355782]">Alternative threads</div>
                {stream.finalBrief?.alternatives?.length ? (
                  <div className="space-y-1.5">
                    {stream.finalBrief.alternatives.map((item) => (
                      <div key={item.symbol} className="rounded-md border border-[#e2e9f5] bg-white px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[#355782]">{item.symbol}</span>
                          <span className="text-[#6d84a6]">{item.score.toFixed(3)}</span>
                        </div>
                        <div className="text-[11px] text-[#607a9d]">{item.reason}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[#6c84a4]">Alternatives appear after ranking stage.</div>
                )}
              </div>

              <div className="rounded-lg border border-[#e1e9f5] bg-[#f8fbff] p-2">
                <div className="mb-1 font-semibold text-[#355782]">Why this score</div>
                {scoreBreakdown.length > 0 ? (
                  <div className="grid gap-1">
                    {scoreBreakdown.slice(0, 6).map((entry) => (
                      <div
                        key={`${entry.label}-${entry.value}`}
                        className="rounded-md border border-[#e2e9f5] bg-white px-2 py-1.5 text-[11px]"
                      >
                        <div className="font-semibold text-[#355782]">{entry.label}</div>
                        <div className="text-[#607a9d]">{entry.value}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[#6c84a4]">Component metrics appear after ranking stage.</div>
                )}
              </div>
            </div>
            {stream.finalBrief?.queryAlignment && stream.finalBrief.queryAlignment.status !== "none" ? (
              <div className="rounded-lg border border-[#e1e9f5] bg-[#f8fbff] px-2.5 py-2 text-sm text-[#4f678b]">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6a83a5]">
                  Query alignment
                </div>
                <div className="font-medium capitalize text-[#355782]">
                  {stream.finalBrief.queryAlignment.status}
                </div>
                <div className="mt-1 text-[#607a9d]">{stream.finalBrief.queryAlignment.note}</div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <footer className="px-6 pt-4 text-[11px] text-[#5f7598]">
        <div>Preclinical evidence synthesis only; not for clinical decision-making.</div>
      </footer>
    </main>
  );
}
