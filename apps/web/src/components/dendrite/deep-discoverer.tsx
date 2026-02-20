"use client";

import { useEffect, useMemo, useRef } from "react";
import { Sparkles, Workflow } from "lucide-react";
import {
  type DiscoverJourneyEntry,
  type DiscoverEntity,
  type DiscovererFinal,
  useDeepDiscoverStream,
} from "@/hooks/useDeepDiscoverStream";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

type Props = {
  diseaseQuery: string;
  diseaseId: string | null;
  seedQuestion?: string;
  onFocusEntities: (
    entities: DiscoverEntity[],
    pathState?: "active" | "candidate" | "discarded",
  ) => void;
  autoStart?: boolean;
  autoFocusLatest?: boolean;
  autoStartKey?: string;
  hideFinalReadout?: boolean;
  compact?: boolean;
  onFinalReadout?: (final: DiscovererFinal | null) => void;
  onEntriesChange?: (payload: {
    entries: DiscoverJourneyEntry[];
    isRunning: boolean;
    statusMessage: string | null;
    elapsedMs: number | null;
  }) => void;
  hidePanel?: boolean;
};

const sourceTone: Record<string, string> = {
  agent: "border-[#d6d1fb] bg-[#f2efff] text-[#5143ab]",
  planner: "border-[#d8d1f8] bg-[#f3efff] text-[#5a4cab]",
  opentargets: "border-[#d4d0fb] bg-[#f1edff] text-[#4f4aa8]",
  reactome: "border-[#cde6df] bg-[#eefaf6] text-[#246f58]",
  chembl: "border-[#dcc9ff] bg-[#f5efff] text-[#6f46c8]",
  string: "border-[#d8d4f8] bg-[#f3f1ff] text-[#585da3]",
  biomcp: "border-[#d0e4d6] bg-[#eff9f3] text-[#356f4d]",
  pubmed: "border-[#ddd3f8] bg-[#f7f2ff] text-[#7552ba]",
};

function pathTone(pathState: "active" | "candidate" | "discarded" | undefined): string {
  if (pathState === "active") return "border-[#c2e3d6] bg-[#f2fbf6]";
  if (pathState === "discarded") return "border-[#e0dfec] bg-[#f6f6fa] opacity-75";
  return "border-[#e4ddff] bg-white";
}

export function DeepDiscoverer({
  diseaseQuery,
  diseaseId,
  seedQuestion,
  onFocusEntities,
  autoStart = false,
  autoFocusLatest = false,
  autoStartKey = "default",
  hideFinalReadout = false,
  compact = false,
  onFinalReadout,
  onEntriesChange,
  hidePanel = false,
}: Props) {
  const stream = useDeepDiscoverStream();
  const startDeepDiscover = stream.start;
  const autoStartedKeyRef = useRef<string>("");
  const effectiveQuestion = useMemo(
    () => {
      const seed = seedQuestion?.trim();
      if (seed) return seed;
      const disease = diseaseQuery.trim();
      return disease || "Run multihop biomedical discovery.";
    },
    [diseaseQuery, seedQuestion],
  );

  useEffect(() => {
    if (!autoStart) return;
    const disease = diseaseQuery.trim();
    if (!disease) return;
    const key = `${autoStartKey}::${disease.toLowerCase()}::${effectiveQuestion.toLowerCase()}`;
    if (!diseaseQuery.trim() || autoStartedKeyRef.current === key) return;
    autoStartedKeyRef.current = key;
    startDeepDiscover({
      diseaseQuery,
      diseaseId,
      question: effectiveQuestion,
    });
  }, [autoStart, autoStartKey, diseaseId, diseaseQuery, effectiveQuestion, startDeepDiscover]);

  useEffect(() => {
    if (!autoFocusLatest || stream.entries.length === 0) return;
    const latest = stream.entries[stream.entries.length - 1];
    if (!latest || latest.entities.length === 0) return;
    onFocusEntities(latest.entities, latest.pathState);
  }, [autoFocusLatest, onFocusEntities, stream.entries]);

  useEffect(() => {
    onFinalReadout?.(stream.final ?? null);
  }, [onFinalReadout, stream.final]);

  useEffect(() => {
    onEntriesChange?.({
      entries: stream.entries,
      isRunning: stream.isRunning,
      statusMessage: stream.status?.message ?? null,
      elapsedMs: stream.elapsedMs,
    });
  }, [onEntriesChange, stream.elapsedMs, stream.entries, stream.isRunning, stream.status?.message]);

  const condensedEntries = useMemo(() => {
    const out: DiscoverJourneyEntry[] = [];
    const seen = new Map<string, number>();
    let previousKey = "";
    for (const entry of stream.entries) {
      const semantic = `${entry.kind}:${entry.source}:${entry.title
        .toLowerCase()
        .replace(/\d+/g, "#")
        .trim()}`;
      const detailKey = entry.detail.toLowerCase().replace(/\d+/g, "#").trim();
      const dedupeKey = `${semantic}:${detailKey}`;
      if (dedupeKey === previousKey) continue;
      const count = seen.get(semantic) ?? 0;
      if (count >= 2) continue;
      seen.set(semantic, count + 1);
      previousKey = dedupeKey;
      out.push(entry);
    }
    return out.slice(-24);
  }, [stream.entries]);

  const totalEntityRefs = useMemo(
    () => condensedEntries.reduce((acc, entry) => acc + entry.entities.length, 0),
    [condensedEntries],
  );

  const activeCount = useMemo(
    () => condensedEntries.filter((entry) => entry.pathState === "active").length,
    [condensedEntries],
  );
  const discardedCount = useMemo(
    () => condensedEntries.filter((entry) => entry.pathState === "discarded").length,
    [condensedEntries],
  );
  const journeyHeightClass = compact ? "h-[260px]" : "h-[420px]";

  if (hidePanel) {
    return null;
  }

  return (
    <Card className="border-[#d9d4fb] bg-white/95 shadow-[0_10px_32px_rgba(79,70,229,0.09)]">
      <CardHeader className={`${compact ? "space-y-1.5 pb-3" : "space-y-2 pb-4"} border-b border-[#e4e7f7]`}>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className={`${compact ? "text-sm" : "text-base"} text-[#303f7f]`}>Agentic narration</CardTitle>
          {stream.isRunning ? (
            <Badge className="border border-[#d4daf6] bg-[#eff1ff] text-[#4b4f98]">Live</Badge>
          ) : null}
          <Badge className="border border-[#d4daf6] bg-[#eef0ff] text-[#464da1]">
            <Workflow className="mr-1 h-3.5 w-3.5" />
            Multihop
          </Badge>
          <Badge className="border border-[#ded4fb] bg-[#f8f4ff] text-[#6f56af]">
            PubMed MCP + BioMCP
          </Badge>
        </div>
        {!compact ? (
          <>
            <p className="text-xs text-[#59679a]">
              Live branch-by-branch updates synchronized with the mechanism graph.
            </p>
            <div className="flex flex-wrap gap-1.5 text-[10px] text-[#5d6ba0]">
              <span className="rounded-full border border-[#c2e3d6] bg-[#f2fbf6] px-2 py-0.5">Active</span>
              <span className="rounded-full border border-[#e4ddff] bg-white px-2 py-0.5">Candidate</span>
              <span className="rounded-full border border-[#e0dfec] bg-[#f6f6fa] px-2 py-0.5">Discarded</span>
            </div>
          </>
        ) : null}
      </CardHeader>

      <CardContent className={`${compact ? "space-y-2.5 pt-3" : "space-y-3 pt-4"} text-xs text-[#3f4f7d]`}>
        {!compact ? (
          <div className="rounded-xl border border-[#dbe4f2] bg-[#f7faff] px-3 py-2.5 text-[11px] text-[#4f688d]">
            Updates include tool calls, branch decisions, and fallback handling in real time.
          </div>
        ) : null}

        <div className={`grid gap-2 ${compact ? "grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4"}`}>
          <div className="rounded-lg border border-[#d9e2f2] bg-[#f8fbff] px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[#6c7e9e]">Status</div>
            <div className="mt-0.5 font-semibold text-[#264272]">
              {stream.status?.message ?? (stream.isRunning ? "running" : "idle")}
            </div>
          </div>
          <div className="rounded-lg border border-[#d9e2f2] bg-[#f8fbff] px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[#6c7e9e]">Journey</div>
            <div className="mt-0.5 font-semibold text-[#264272]">{condensedEntries.length} events</div>
            {!compact ? <div className="mt-0.5 text-[10px] text-[#6c7e9e]">Handoffs and branch updates</div> : null}
          </div>
          {!compact ? (
            <div className="rounded-lg border border-[#d9e2f2] bg-[#f8fbff] px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#6c7e9e]">Entities</div>
              <div className="mt-0.5 font-semibold text-[#264272]">{totalEntityRefs} refs</div>
              <div className="mt-0.5 text-[10px] text-[#6c7e9e]">Resolved concepts touched so far</div>
            </div>
          ) : null}
          <div className="rounded-lg border border-[#d9e2f2] bg-[#f8fbff] px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[#6c7e9e]">Path State</div>
            <div className="mt-0.5 font-semibold text-[#264272]">
              {activeCount} active / {discardedCount} discarded
            </div>
            {!compact ? (
              <div className="mt-0.5 text-[10px] text-[#6c7e9e]">Leading branch vs deprioritized paths</div>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-[#dbe4f2] bg-[#fbfcff]">
          <div className="flex items-center justify-between border-b border-[#e6ecf5] px-3 py-2 text-[11px] font-semibold text-[#355385]">
            <span>Live Discovery Path</span>
            {stream.elapsedMs !== null ? <span>{(stream.elapsedMs / 1000).toFixed(1)}s</span> : null}
          </div>
          <ScrollArea className={`${journeyHeightClass} px-2.5 py-2`}>
            <div className="space-y-2">
              {condensedEntries.length === 0 ? (
                <div className="rounded-lg border border-[#e2e9f4] bg-white px-2.5 py-2 text-[11px] text-[#6f81a1]">
                  Waiting for first subagent update...
                </div>
              ) : (
                condensedEntries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${pathTone(entry.pathState)}`}
                    onClick={() => {
                      if (entry.entities.length > 0) {
                        onFocusEntities(entry.entities, entry.pathState);
                      }
                    }}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-[#2b4471]">{entry.title}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge className="border border-[#dbe4f5] bg-white text-[10px] text-[#5b6f92]">
                          {entry.kind.replace("_", " ")}
                        </Badge>
                        {entry.pathState ? (
                          <Badge className="border border-[#dbe4f5] bg-white text-[10px] text-[#5b6f92]">
                            {entry.pathState}
                          </Badge>
                        ) : null}
                        <Badge className={`border text-[10px] ${sourceTone[entry.source] ?? sourceTone.agent}`}>
                          {entry.source}
                        </Badge>
                      </div>
                    </div>
                    <div className="text-[11px] text-[#58709a]">{entry.detail}</div>
                    {entry.entities.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {entry.entities.slice(0, 8).map((entity) => (
                          <span
                            key={`${entry.id}-${entity.type}-${entity.label}`}
                            className="rounded-full border border-[#d6e0f0] bg-white px-2 py-0.5 text-[10px] text-[#415d8d]"
                          >
                            {entity.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {stream.error ? (
          <div className="rounded-lg border border-[#e7d7c8] bg-[#fff7ef] px-2.5 py-2 text-[#8f5626]">
            Stream error: {stream.error}
          </div>
        ) : null}

        {!hideFinalReadout && stream.final ? (
          <div className="space-y-2 rounded-xl border border-[#d5e0f3] bg-[#f8fbff] p-3">
            <div className="flex items-center gap-1 text-[11px] font-semibold text-[#2f4e81]">
              <Sparkles className="h-3.5 w-3.5" /> Summary readout
            </div>
            <div className="rounded-lg border border-[#dce5f4] bg-white px-2.5 py-2 text-[11px] text-[#27416f]">
              {stream.final.answer}
            </div>
            <div className="rounded-lg border border-[#dce5f4] bg-white px-2.5 py-2 text-[11px] text-[#3f5f90]">
              Focus path: {stream.final.focusThread.pathway} {"->"} {stream.final.focusThread.target} {"->"}{" "}
              {stream.final.focusThread.drug}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
