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
import { PathFirstGraph } from "@/components/dendrite/path-first-graph";
import { type BridgeAnalysis } from "@/components/dendrite/bridge-analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  useCaseRunStream,
  type AgentFinalAnswer,
  type JourneyEntry,
  type PathUpdate,
} from "@/hooks/useCaseRunStream";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  initialQuery: string;
  initialDiseaseId?: string;
  initialDiseaseName?: string;
  initialReplayId?: string;
};

type SourceHealth = Record<string, "green" | "yellow" | "red">;
type NarrationPathState = "active" | "candidate" | "discarded" | undefined;

const phaseSummaryMap: Record<string, string> = {
  P0: "I am resolving canonical anchors from your query",
  P1: "I am investigating target evidence and priority signals",
  P2: "I am following pathway trails from the active targets",
  P3: "I am checking compound and mechanism support",
  P4: "I am testing network connectivity and neighborhood context",
  P5: "I am grounding the path with papers and trials",
  P6: "I am closing with a ranked thread and caveats",
};

function sourceBadgeTone(value: "green" | "yellow" | "red") {
  if (value === "green") return "bg-[#eef8f2] text-[#1d6f45]";
  if (value === "yellow") return "bg-[#fff6ea] text-[#9a5d21]";
  return "bg-[#fff0f1] text-[#a9324f]";
}

function narrationPathTone(pathState: NarrationPathState): string {
  if (pathState === "active") {
    return "border-[#c4e7d8] bg-[#f2fbf6]";
  }
  if (pathState === "candidate") {
    return "border-[#d5dcf5] bg-[#f6f8ff]";
  }
  if (pathState === "discarded") {
    return "border-[#e3e5ef] bg-[#f8f9fc] opacity-80";
  }
  return "border-[#e1defa] bg-[#faf9ff]";
}

function narrationKindLabel(kind: JourneyEntry["kind"] | "pipeline"): string {
  if (kind === "tool_start") return "tool call";
  if (kind === "tool_result") return "tool result";
  if (kind === "handoff") return "handoff";
  if (kind === "warning") return "warning";
  if (kind === "phase") return "phase";
  if (kind === "followup") return "followup";
  if (kind === "branch") return "branch";
  if (kind === "pipeline") return "pipeline";
  return "insight";
}

function narrationKindTone(kind: JourneyEntry["kind"] | "pipeline"): string {
  if (kind === "warning") return "border-[#e7d2ba] bg-[#fff6ec] text-[#8a5829]";
  if (kind === "tool_start") return "border-[#cad6f2] bg-[#f1f5ff] text-[#3f5f90]";
  if (kind === "tool_result") return "border-[#c6e6d8] bg-[#edf9f1] text-[#2f6d4e]";
  if (kind === "handoff") return "border-[#d6d4f7] bg-[#f5f3ff] text-[#5d4ea1]";
  if (kind === "followup") return "border-[#d3ddf6] bg-[#f3f7ff] text-[#415f93]";
  if (kind === "branch") return "border-[#d7d8eb] bg-[#f6f7fb] text-[#5a6288]";
  return "border-[#d8d4f8] bg-white text-[#676ca8]";
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

function compact(value: string, max = 148): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function narrationKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function hasInlineCitationMarkers(text: string): boolean {
  if (!text) return false;
  return (
    /\[(\d{1,3})\](?!\()/.test(text) ||
    /\[(\d{1,3})\s*[–-]\s*(\d{1,3})\](?!\()/.test(text)
  );
}

function appendCitationSuffixToBlock(block: string, suffix: string): string {
  const lines = block.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const row = lines[index];
    if (!row || row.trim().length === 0) continue;
    lines[index] = `${row.trimEnd()} ${suffix}`;
    return lines.join("\n");
  }
  return block;
}

function injectFallbackInlineCitations(
  text: string,
  citationIndices: ReadonlySet<number>,
): string {
  if (!text || citationIndices.size === 0 || hasInlineCitationMarkers(text)) {
    return text;
  }

  const ordered = [...citationIndices].sort((a, b) => a - b);
  if (ordered.length === 0) return text;

  const markerBudget = ordered.slice(0, Math.min(ordered.length, 10));
  const blocks = text.split(/\n\s*\n/);
  const candidateIndexes = blocks
    .map((block, index) => {
      const trimmed = block.trim();
      if (!trimmed) return -1;
      if (/^#{1,6}\s/.test(trimmed)) return -1;
      if (/^```/.test(trimmed)) return -1;
      if (!/[A-Za-z]/.test(trimmed)) return -1;
      return index;
    })
    .filter((index) => index >= 0);

  if (candidateIndexes.length === 0) {
    return appendCitationSuffixToBlock(
      text,
      markerBudget.map((value) => `[${value}]`).join(""),
    );
  }

  let markerCursor = 0;
  for (let index = 0; index < candidateIndexes.length; index += 1) {
    if (markerCursor >= markerBudget.length) break;
    const blockIndex = candidateIndexes[index];
    if (typeof blockIndex !== "number") continue;
    const remaining = markerBudget.length - markerCursor;
    const allocateCount = index === 0 && remaining >= 2 ? 2 : 1;
    const assigned = markerBudget.slice(markerCursor, markerCursor + allocateCount);
    markerCursor += assigned.length;
    if (assigned.length === 0) continue;
    blocks[blockIndex] = appendCitationSuffixToBlock(
      blocks[blockIndex] ?? "",
      assigned.map((value) => `[${value}]`).join(""),
    );
  }

  return blocks.join("\n\n");
}

function linkInlineCitationMarkers(
  text: string,
  citationIndices: ReadonlySet<number>,
): string {
  if (!text || citationIndices.size === 0) return text;
  const seeded = injectFallbackInlineCitations(text, citationIndices);
  const ranged = seeded.replace(
    /\[(\d{1,3})\s*[–-]\s*(\d{1,3})\](?!\()/g,
    (full, startValue, endValue) => {
      const startIndex = Number(startValue);
      const endIndex = Number(endValue);
      if (
        !Number.isFinite(startIndex) ||
        !Number.isFinite(endIndex) ||
        !citationIndices.has(startIndex) ||
        !citationIndices.has(endIndex)
      ) {
        return full;
      }
      return `([\\[${startIndex}\\]](#ref-${startIndex})–[\\[${endIndex}\\]](#ref-${endIndex}))`;
    },
  );

  return ranged.replace(/\[(\d{1,3})\](?!\()/g, (full, value) => {
    const index = Number(value);
    if (!Number.isFinite(index) || !citationIndices.has(index)) {
      return full;
    }
    return `[\\[${index}\\]](#ref-${index})`;
  });
}

const ANSWER_SECTION_HEADING_PATTERN =
  /^(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*((?:working\s+conclusion(?:\s+and\s+practical\s+next\s+step)?|direct\s+answer|conclusion|evidence\s+synthesis|evidence\s+summary|mechanistic\s+support|biological\s+interpretation|interpretation|self[-\s]*critique(?:\s+and\s+correction)?|critique\s+and\s+correction|alignment\s+check|what\s+to\s+test\s+next|next\s+experiments?|next\s+actions?|experiment\s+plan|residual\s+uncertainty|what\s+remains\s+uncertain|uncertainty))[^:]*\s*(?:\*\*|__)?\s*:?\s*(.*)$/i;

function canonicalAnswerSectionHeading(label: string): string | null {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ");
  if (
    normalized.startsWith("working conclusion") ||
    normalized.startsWith("direct answer") ||
    normalized.startsWith("conclusion")
  ) {
    return "Working conclusion";
  }
  if (
    normalized.startsWith("evidence synthesis") ||
    normalized.startsWith("evidence summary") ||
    normalized.startsWith("mechanistic support")
  ) {
    return "Evidence synthesis";
  }
  if (normalized.startsWith("biological interpretation") || normalized === "interpretation") {
    return "Biological interpretation";
  }
  if (
    normalized.startsWith("what to test next") ||
    normalized.startsWith("next experiments") ||
    normalized.startsWith("next actions") ||
    normalized.startsWith("experiment plan")
  ) {
    return "What to test next";
  }
  if (
    normalized.startsWith("residual uncertainty") ||
    normalized.startsWith("what remains uncertain") ||
    normalized.startsWith("uncertainty")
  ) {
    return "Residual uncertainty";
  }
  if (
    normalized.startsWith("self critique") ||
    normalized.startsWith("self-critique") ||
    normalized.startsWith("critique and correction") ||
    normalized.startsWith("alignment check")
  ) {
    return "Internal critique";
  }
  return null;
}

function normalizeAnswerMarkdownForRender(text: string): string {
  if (!text) return text;
  let normalized = text.replace(/\r/g, "");
  const escapedNewlineCount = (normalized.match(/\\n/g) ?? []).length;
  const realNewlineCount = (normalized.match(/\n/g) ?? []).length;
  if (escapedNewlineCount >= 2 && realNewlineCount <= 1) {
    normalized = normalized
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "  ");
  }
  normalized = normalized.replace(/\\u2022/g, "•");
  const lines = normalized
    .replace(/([^\n])\s+(#{1,6}\s+)/g, "$1\n\n$2")
    .split("\n");
  const rebuilt: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(ANSWER_SECTION_HEADING_PATTERN);
    if (!match) {
      rebuilt.push(line);
      continue;
    }
    const heading = canonicalAnswerSectionHeading(match[1] ?? "");
    if (!heading) {
      rebuilt.push(line);
      continue;
    }
    if (heading === "Internal critique") {
      continue;
    }
    const inlineContent = (match[2] ?? "").trim();
    rebuilt.push(`### ${heading}`);
    if (inlineContent.length > 0) rebuilt.push(inlineContent);
  }
  return rebuilt.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function MarkdownAnswer({
  text,
  className,
  citationIndices,
}: {
  text: string;
  className?: string;
  citationIndices?: ReadonlySet<number>;
}) {
  const normalizedText = useMemo(() => normalizeAnswerMarkdownForRender(text), [text]);
  const linkedText = useMemo(
    () => linkInlineCitationMarkers(normalizedText, citationIndices ?? new Set<number>()),
    [citationIndices, normalizedText],
  );

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-[15px] font-semibold text-[#33457a] first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-[14px] font-semibold text-[#33457a] first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#42508a] first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-[#d4d8f4] pl-3 text-[#556395]">{children}</blockquote>
          ),
          strong: ({ children }) => <strong className="font-semibold text-[#33457a]">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children }) => (
            <code className="rounded bg-[#eef1ff] px-1 py-0.5 text-[12px] text-[#3b4b86]">{children}</code>
          ),
          a: ({ href, children }) => (
            typeof href === "string" && href.startsWith("#ref-") ? (
              <a
                href={href}
                className="text-[#3d53a0] underline underline-offset-2 hover:text-[#2c3d7b]"
              >
                {children}
              </a>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-[#3d53a0] underline underline-offset-2 hover:text-[#2c3d7b]"
              >
                {children}
              </a>
            )
          ),
        }}
      >
        {linkedText}
      </ReactMarkdown>
    </div>
  );
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

const AUTO_START_DEDUP_WINDOW_MS = 4_000;
const recentAutoStarts = new Map<string, number>();

function shouldAutoStart(signature: string): boolean {
  const now = Date.now();
  const lastStartedAt = recentAutoStarts.get(signature);
  if (typeof lastStartedAt === "number" && now - lastStartedAt < AUTO_START_DEDUP_WINDOW_MS) {
    return false;
  }
  recentAutoStarts.set(signature, now);
  const pruneBefore = now - AUTO_START_DEDUP_WINDOW_MS * 5;
  for (const [key, startedAt] of recentAutoStarts) {
    if (startedAt < pruneBefore) {
      recentAutoStarts.delete(key);
    }
  }
  return true;
}

export function DecisionBriefWorkspace({
  initialQuery,
  initialDiseaseId,
  initialDiseaseName,
  initialReplayId,
}: Props) {
  const router = useRouter();
  const stream = useCaseRunStream();
  const startStream = stream.start;
  const stopStream = stream.stop;
  const runSessionId = stream.runSessionId;

  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [diseaseIdOverride, setDiseaseIdOverride] = useState<string | null>(initialDiseaseId ?? null);
  const [diseaseNameOverride, setDiseaseNameOverride] = useState<string | null>(initialDiseaseName ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showPathwayContext, setShowPathwayContext] = useState(true);
  const [showDrugContext, setShowDrugContext] = useState(true);
  const [showInteractionContext, setShowInteractionContext] = useState(false);

  const [activePath, setActivePath] = useState<PathUpdate | null>(null);
  const [candidatePaths, setCandidatePaths] = useState<PathUpdate[]>([]);
  const [washedPaths, setWashedPaths] = useState<PathUpdate[]>([]);
  const [bridgeAnalysis, setBridgeAnalysis] = useState<BridgeAnalysis | null>(null);
  const agentFinalReadout: AgentFinalAnswer | null = stream.agentFinal;
  const discoverEntries: JourneyEntry[] = stream.journeyEntries;
  const discoverStatusMessage = stream.journeyStatusMessage;
  const discoverElapsedMs = stream.journeyElapsedMs;
  const discoverIsRunning = stream.journeyIsRunning;
  const activePathRef = useRef<PathUpdate | null>(null);
  const lastNarrationAtRef = useRef<number>(0);
  const [secondsSinceNarration, setSecondsSinceNarration] = useState(0);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());

  useEffect(() => {
    lastNarrationAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    const autoStartSignature = [
      runSessionId,
      initialQuery.trim().toLowerCase(),
      (initialDiseaseId ?? "").trim().toLowerCase(),
      (initialDiseaseName ?? "").trim().toLowerCase(),
      (initialReplayId ?? "").trim().toLowerCase(),
    ].join("|");
    if (!shouldAutoStart(autoStartSignature)) {
      return;
    }

    startStream({
      query: initialQuery,
      diseaseId: initialDiseaseId ?? null,
      diseaseName: initialDiseaseName ?? null,
      replayId: initialReplayId ?? null,
    });

    return () => stopStream();
  }, [
    initialDiseaseId,
    initialDiseaseName,
    initialQuery,
    initialReplayId,
    runSessionId,
    startStream,
    stopStream,
  ]);

  useEffect(() => {
    activePathRef.current = null;
    setActivePath(null);
    setCandidatePaths([]);
    setWashedPaths([]);
  }, [runSessionId]);

  useEffect(() => {
    const incoming = stream.pathUpdate;
    if (!incoming) return;
    const incomingSignature = pathSignature(incoming);
    const previous = activePathRef.current;
    const previousSignature = pathSignature(previous);
    if (incomingSignature === previousSignature) return;

    const pathState = incoming.pathState ?? "active";
    if (pathState === "discarded") {
      setWashedPaths((prev) => {
        const next = [incoming, ...prev.filter((item) => pathSignature(item) !== incomingSignature)];
        return next.slice(0, 8);
      });
      return;
    }
    if (pathState === "candidate") {
      setCandidatePaths((prev) => {
        const next = [incoming, ...prev.filter((item) => pathSignature(item) !== incomingSignature)];
        return next.slice(0, 6);
      });
      return;
    }

    if (previous && previous.edgeIds.length > 0) {
      setWashedPaths((prev) => {
        const next = [previous, ...prev.filter((item) => pathSignature(item) !== previousSignature)];
        return next.slice(0, 8);
      });
    }

    activePathRef.current = incoming;
    setActivePath(incoming);
    setCandidatePaths((prev) => prev.filter((item) => pathSignature(item) !== incomingSignature));
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
    if (!stream.isRunning && !discoverIsRunning) return;

    const timer = window.setInterval(() => {
      const now = Date.now();
      setLiveNowMs(now);
      const deltaSec = Math.max(0, Math.floor((now - lastNarrationAtRef.current) / 1000));
      setSecondsSinceNarration(deltaSec);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [discoverIsRunning, stream.isRunning]);

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
        kind: entry.kind,
        count: 1,
        pathState: entry.pathState,
      }));
    const fromPipeline = executionNarration.slice(-8).map((entry) => ({
      id: `pipeline:${entry.id}`,
      title: entry.title,
      detail: entry.detail,
      source: "pipeline",
      kind: "pipeline" as const,
      count: entry.count,
      pathState: undefined as NarrationPathState,
    }));
    const merged = fromAgentTrail.length > 0 ? fromAgentTrail : fromPipeline;
    const bySemantic = new Map<string, number>();
    const condensed: Array<{
      id: string;
      title: string;
      detail: string;
      source: string;
      kind: JourneyEntry["kind"] | "pipeline";
      count: number;
      pathState: NarrationPathState;
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
        existing.kind = entry.kind;
        existing.count += 1;
        if (entry.pathState) {
          existing.pathState = entry.pathState;
        }
      }
    }
    return condensed.slice(-12);
  }, [discoverEntries, executionNarration]);

  const journeySignals = useMemo(() => {
    const sourceCounts = new Map<string, number>();
    let active = 0;
    let candidate = 0;
    let discarded = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let warnings = 0;

    for (const entry of discoverEntries) {
      sourceCounts.set(entry.source, (sourceCounts.get(entry.source) ?? 0) + 1);
      if (entry.pathState === "active") active += 1;
      if (entry.pathState === "candidate") candidate += 1;
      if (entry.pathState === "discarded") discarded += 1;
      if (entry.kind === "tool_start") toolCalls += 1;
      if (entry.kind === "tool_result" || entry.kind === "handoff") toolResults += 1;
      if (entry.kind === "warning") warnings += 1;
    }

    const topSources = [...sourceCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);

    return {
      total: discoverEntries.length,
      toolCalls,
      toolResults,
      warnings,
      active,
      candidate,
      discarded,
      topSources,
    };
  }, [discoverEntries]);

  const executionActivity = useMemo(() => {
    const inFlightCalls = Math.max(0, journeySignals.toolCalls - journeySignals.toolResults);
    const latestTrail = mergedLiveNarration[mergedLiveNarration.length - 1];
    const latestToolResult = [...discoverEntries]
      .reverse()
      .find((entry) => entry.kind === "tool_result" || entry.kind === "handoff");
    return {
      inFlightCalls,
      currentOperation: latestTrail?.title ?? "Waiting for first trail updates",
      latestEvidenceUpdate: latestToolResult?.title ?? null,
    };
  }, [discoverEntries, journeySignals.toolCalls, journeySignals.toolResults, mergedLiveNarration]);

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
  const resolvedAgentAnswer =
    agentFinalReadout?.answer?.trim() ||
    stream.agentAnswerText.trim() ||
    "";
  const hasAgentFinalAnswer = Boolean(
    !stream.isRunning && resolvedAgentAnswer.length > 0,
  );
  const finalVerdictReady = !stream.isRunning &&
    !discoverIsRunning &&
    Boolean(
      hasAgentFinalAnswer ||
      ((!recommendationIsProvisional && recommendation) || liveTargetFallback || stream.finalBrief),
    );
  const queryPlan = stream.queryPlan;

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
    const pendingThreadFallback = "Awaiting first target and pathway evidence batches.";
    const activeThread =
      graphPath?.summary ??
      bridgeAnalysis?.activeConnectedPath?.summary ??
      (recommendation?.target && recommendation?.pathway
        ? `${recommendation.target} in ${recommendation.pathway}`
        : pendingThreadFallback);

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
            ? `I am evaluating whether ${queryAnchorsSummary} can be explained through an explicit multihop mechanism path.`
            : `I am building and ranking mechanism threads for "${submittedQuery}" as evidence streams in.`,
        mechanismThread: activeThread,
        verdictType: "pending" as const,
        confidence: "In progress",
      };
    }

    if (hasAgentFinalAnswer && resolvedAgentAnswer) {
      const focusThread = [
        agentFinalReadout?.focusThread.pathway,
        agentFinalReadout?.focusThread.target,
        agentFinalReadout?.focusThread.drug,
      ]
        .filter((item) => item && item !== "not provided")
        .join(" -> ");
      return {
        directAnswer: resolvedAgentAnswer,
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
            "Final synthesis was not produced for this run. A connected multihop mechanism path is present in the graph and should be interpreted as provisional evidence.",
          mechanismThread: bridgeContext,
          verdictType: "connected" as const,
          confidence: confidenceLabel,
        };
      }
      if (bridgeAnalysis?.status === "no_connection") {
        return {
          directAnswer:
            "Final synthesis was not produced for this run. No complete multihop mechanism path was closed; unresolved anchor gaps are shown in the graph.",
          mechanismThread: bridgeContext,
          verdictType: "no_connection" as const,
          confidence: "Exploratory only",
        };
      }
    }

    return {
      directAnswer:
        "Final synthesis was not produced for this run. Showing a provisional readout from the active graph state.",
      mechanismThread: activeThread,
      verdictType: recommendation && score >= 0.65 ? ("ranked" as const) : ("partial" as const),
      confidence: recommendation ? confidenceLabel : "Low confidence",
    };
  }, [
    hasAgentFinalAnswer,
    agentFinalReadout,
    resolvedAgentAnswer,
    bridgeAnalysis,
    graphPath?.summary,
    queryAnchorsSummary,
    queryMode,
    recommendation,
    discoverIsRunning,
    stream.isRunning,
    submittedQuery,
  ]);

  const rawProgressPct = Math.max(0, Math.min(100, Math.round(stream.status?.pct ?? 0)));
  const progressPct = rawProgressPct;
  const progressBarPct = Math.max(4, progressPct);
  const runElapsedMs = useMemo(() => {
    const reported = discoverElapsedMs ?? 0;
    const startedAt = stream.journeyStartedAtMs;
    if ((stream.isRunning || discoverIsRunning) && typeof startedAt === "number") {
      return Math.max(reported, liveNowMs - startedAt);
    }
    if (reported > 0) return reported;
    if (typeof startedAt === "number") {
      return Math.max(0, liveNowMs - startedAt);
    }
    return 0;
  }, [discoverElapsedMs, discoverIsRunning, liveNowMs, stream.isRunning, stream.journeyStartedAtMs]);

  const verdictCitations = useMemo(() => {
    const primary = stream.citationBundle?.citations;
    if (primary && primary.length > 0) return primary;
    return stream.finalBrief?.citations ?? [];
  }, [stream.citationBundle?.citations, stream.finalBrief?.citations]);
  const verdictCitationIndexSet = useMemo(
    () => new Set<number>(verdictCitations.map((citation) => citation.index)),
    [verdictCitations],
  );

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
    setSubmittedQuery(trimmed);

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

  const shortlistPaths = useMemo(() => {
    const candidates = stream.finalBrief?.threadCandidates;
    if (!candidates?.length) return [];
    return candidates
      .slice(0, 3)
      .map((candidate) => {
        const nodeIds = [...new Set(candidate.nodeIds ?? [])];
        const edgeIds = [...new Set(candidate.edgeIds ?? [])];
        if (nodeIds.length === 0 && edgeIds.length === 0) {
          return buildPathForTargetSymbol(candidate.target);
        }
        return {
          nodeIds,
          edgeIds,
          summary: compact(candidate.summary),
        } satisfies PathUpdate;
      })
      .filter((item): item is PathUpdate => Boolean(item));
  }, [buildPathForTargetSymbol, stream.finalBrief]);

  const candidatePathsMerged = useMemo(() => {
    const all = [...candidatePaths, ...shortlistPaths, ...alternativePaths];
    const seen = new Set<string>();
    const merged: PathUpdate[] = [];
    for (const path of all) {
      const signature = pathSignature(path);
      if (!signature || seen.has(signature)) continue;
      seen.add(signature);
      merged.push(path);
      if (merged.length >= 8) break;
    }
    return merged;
  }, [alternativePaths, candidatePaths, shortlistPaths]);

  const mergedWashedPaths = useMemo(() => {
    const activeSignature = pathSignature(activePath);
    const candidateSignatures = new Set(
      candidatePathsMerged.map((path) => pathSignature(path)),
    );
    const seen = new Set<string>();
    const merged: PathUpdate[] = [];

    for (const item of washedPaths) {
      const signature = pathSignature(item);
      if (
        !signature ||
        signature === activeSignature ||
        seen.has(signature) ||
        candidateSignatures.has(signature)
      ) {
        continue;
      }
      seen.add(signature);
      merged.push(item);
      if (merged.length >= 10) break;
    }

    return merged;
  }, [activePath, candidatePathsMerged, washedPaths]);

  const topStatus = stream.status?.message ?? "Preparing run";
  const runLabel = "Multi-hop search";
  const runDescription =
    "Entity resolution and evidence retrieval across OpenTargets, Reactome, ChEMBL, STRING, BioMCP, and PubMed.";

  return (
    <main className="min-h-screen bg-transparent pb-6 text-[#252c52]">
      <header className="sticky top-0 z-40 border-b border-[#d6dbf3] bg-white/95 px-3 py-2 backdrop-blur md:px-6">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2">
            <Badge className="rounded-full bg-[#4d47d8] px-3 py-1 text-white">Dendrite</Badge>
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
              Run analysis
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

      <section className="px-3 pt-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1 rounded-full border border-[#d4d0fb] bg-[#f4f1ff] px-2.5 py-1 text-xs font-medium text-[#4b49a2]">
              <span className={`h-1.5 w-1.5 rounded-full ${stream.isRunning ? "animate-pulse bg-[#4f46e5]" : "bg-[#7b7fb3]"}`} />
              Live Search
            </div>
            <div className="text-[11px] text-[#607797]">
              Graph, execution log, and verdict update continuously in one workspace.
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
                  Resolver output, source health, graph inspector, and export controls.
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
                    <CardTitle className="text-sm text-[#2a456f]">LLM Cost</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {stream.llmCost ? (
                      <>
                        <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                          <div className="text-[11px] uppercase tracking-[0.12em] text-[#6881a4]">
                            Total
                          </div>
                          <div className="mt-0.5 text-lg font-semibold text-[#31507f]">
                            {formatUsd(stream.llmCost.totals.estimatedCostUsd)}
                          </div>
                          <div className="text-[11px] text-[#6b82a3]">
                            {stream.llmCost.totalCalls} calls • {stream.llmCost.totals.totalTokens.toLocaleString()} tokens
                          </div>
                          <div className="text-[11px] text-[#6b82a3]">
                            Cache hit {(stream.llmCost.totals.cacheHitRate * 100).toFixed(1)}%
                          </div>
                        </div>
                        <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2">
                          <div className="mb-1 font-semibold text-[#375782]">Top cost drivers</div>
                          {(stream.llmCost.byOperation ?? []).slice(0, 3).map((row) => (
                            <div key={row.key} className="text-[11px] text-[#607a9d]">
                              {row.key}: {formatUsd(row.estimatedCostUsd)}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg border border-[#dbe4f2] bg-[#f7faff] p-2 text-[#6c84a4]">
                        Cost summary appears after first model calls are recorded.
                      </div>
                    )}
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
                      <Play className="h-3.5 w-3.5" /> Run analysis
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
                          `dendrite-brief-${query.replace(/\s+/g, "-").toLowerCase()}.json`,
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
                candidatePathUpdates={candidatePathsMerged}
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
                <CardTitle className="text-sm text-[#2a456f]">Scientific answer</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-[#35557f] xl:max-h-[72vh] xl:overflow-y-auto xl:pr-1">
                {stream.isRunning ? (
                  <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-3 py-2.5">
                    <div className="font-semibold text-[#47429d]">Answer in progress</div>
                    <MarkdownAnswer
                      text={scientificVerdict.directAnswer}
                      className="mt-1 text-[13px] leading-6 text-[#4f5d91]"
                      citationIndices={verdictCitationIndexSet}
                    />
                    <div className="mt-1 text-[12px] text-[#6170a2]">
                      Active thread: {scientificVerdict.mechanismThread}
                    </div>
                    <div className="mt-1 text-[12px] text-[#6170a2]">
                      Current phase: {phaseSummaryMap[stream.status?.phase ?? ""] ?? "Streaming evidence"} (
                      {progressPct}%)
                    </div>
                  </div>
                ) : finalVerdictReady ? (
                  <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-3 py-2.5">
                    <div className="font-semibold text-[#47429d]">
                      {hasAgentFinalAnswer
                        ? "Final answer"
                        : `${verdictHeadingTarget} in ${verdictHeadingPathway}`}
                    </div>
                    <MarkdownAnswer
                      text={scientificVerdict.directAnswer}
                      className="mt-1 text-[13px] leading-6 text-[#4f5d91]"
                      citationIndices={verdictCitationIndexSet}
                    />
                    <div className="mt-1 text-[12px] text-[#6170a2]">
                      Primary mechanism path: {scientificVerdict.mechanismThread}
                    </div>
                    <div className="mt-1 text-[12px] text-[#6170a2]">
                      Score {recommendation ? recommendation.score.toFixed(3) : "partial"} • Evidence confidence:{" "}
                      {scientificVerdict.confidence}
                    </div>
                    {agentFinalReadout?.keyFindings?.length ? (
                      <div className="mt-2 rounded-md border border-[#ddd9fb] bg-white px-2.5 py-2 text-[11px] text-[#576597]">
                        {agentFinalReadout.keyFindings.slice(0, 4).map((item) => (
                          <div key={item}>• {item}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg border border-[#d3d0fb] bg-[#f7f4ff] px-3 py-2.5">
                    <div className="font-semibold text-[#47429d]">No conclusive mechanism identified</div>
                    <div className="mt-1 text-[13px] text-[#4f5d91]">
                      This run ended without a stable mechanism thread. Review references and the graph trails.
                    </div>
                  </div>
                )}
                {stream.finalBrief?.caveats?.length ? (
                  <div className="rounded-lg border border-[#ddd9fb] bg-[#f7f4ff] px-2.5 py-2 text-xs text-[#665ca3]">
                    {stream.finalBrief.caveats.slice(0, 4).map((item) => (
                      <div key={item}>• {item}</div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="border-[#d9d4fb] bg-white">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-[#2a456f]">Execution log</CardTitle>
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
                      style={{ width: `${progressBarPct}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-[#696ea6]">
                    Progress {progressPct}%
                  </div>
                  {runElapsedMs > 0 ? (
                    <div className="mt-1 text-[10px] text-[#696ea6]">
                      Run time {formatDuration(runElapsedMs)}
                    </div>
                  ) : null}
                  <div className="mt-1 text-[11px] text-[#525aa3]">
                    Current operation: {executionActivity.currentOperation}
                  </div>
                  <div className="mt-1 text-[11px] text-[#525aa3]">
                    In-flight tool calls: {executionActivity.inFlightCalls}
                    {executionActivity.latestEvidenceUpdate
                      ? ` • Last evidence update: ${executionActivity.latestEvidenceUpdate}`
                      : ""}
                  </div>
                  {stream.isRunning && secondsSinceNarration >= 8 ? (
                    <div className="mt-1 text-[11px] text-[#525aa3]">
                      Last update {secondsSinceNarration}s ago.
                    </div>
                  ) : null}
                  <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px] md:grid-cols-4">
                    <div className="rounded border border-[#d5dcf5] bg-white px-1.5 py-1 text-[#4c5b92]">
                      Calls {journeySignals.toolCalls}
                    </div>
                    <div className="rounded border border-[#c6e6d8] bg-white px-1.5 py-1 text-[#2f6d4e]">
                      Results {journeySignals.toolResults}
                    </div>
                    <div className="rounded border border-[#c4e7d8] bg-white px-1.5 py-1 text-[#2e6b4d]">
                      Active {journeySignals.active}
                    </div>
                    <div className="rounded border border-[#e3e5ef] bg-white px-1.5 py-1 text-[#6a718f]">
                      Discarded {journeySignals.discarded}
                    </div>
                  </div>
                  {journeySignals.topSources.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {journeySignals.topSources.map(([source, count]) => (
                        <span
                          key={`${source}-${count}`}
                          className="rounded-full border border-[#d8d4f8] bg-white px-1.5 py-0.5 text-[10px] text-[#676ca8]"
                        >
                          {source} {count}
                        </span>
                      ))}
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
                        className={`rounded-md border px-2 py-1.5 ${narrationPathTone(entry.pathState)}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-[#4a4aa0]">{entry.title}</div>
                          <div className="flex items-center gap-1">
                            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${narrationKindTone(entry.kind)}`}>
                              {narrationKindLabel(entry.kind)}
                            </span>
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

          </div>
        </div>
      </section>

      <section className="px-3 pt-3 md:px-6">
        <Card className="border-[#d9d4fb] bg-white">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-[#2a456f]">
              References ({verdictCitations.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-[#57608f]">
            {verdictCitations.length > 0 ? (
              <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
                {verdictCitations.map((citation) => (
                  <div
                    key={`${citation.kind}-${citation.index}`}
                    id={`ref-${citation.index}`}
                    className="scroll-mt-24 rounded-md border border-[#e1dff9] bg-[#f9f8ff] px-2 py-1"
                  >
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
            ) : (
              <div className="rounded-md border border-[#e1dff9] bg-[#f9f8ff] px-2 py-2 text-[11px] text-[#6369a1]">
                References will appear after evidence retrieval completes.
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <footer className="px-6 pt-4 text-[11px] text-[#5f7598]">
        <div>Preclinical evidence synthesis only; not for clinical decision-making.</div>
      </footer>
    </main>
  );
}
