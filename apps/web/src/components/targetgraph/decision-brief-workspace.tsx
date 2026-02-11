"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Clock3,
  Download,
  Loader2,
  Play,
  Search,
  ShieldAlert,
  Sparkles,
  Telescope,
} from "lucide-react";
import { PathFirstGraph } from "@/components/targetgraph/path-first-graph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useCaseRunStream, type RunMode } from "@/hooks/useCaseRunStream";

type Props = {
  initialQuery: string;
  initialDiseaseId?: string;
  initialMode?: RunMode;
};

type SourceHealth = Record<string, "green" | "yellow" | "red">;

const modeLabel: Record<RunMode, string> = {
  fast: "Fast",
  balanced: "Balanced",
  deep: "Deep",
};

const modeDescription: Record<RunMode, string> = {
  fast: "Core mechanism brief quickly (targets + pathways + drugs).",
  balanced: "Adds interactions for better mechanistic context.",
  deep: "Full-depth context including literature/trials enrichment.",
};

const phaseOrder = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];

function sourceBadgeTone(value: "green" | "yellow" | "red") {
  if (value === "green") return "bg-[#e6f9ef] text-[#126b3a]";
  if (value === "yellow") return "bg-[#fff4e6] text-[#965716]";
  return "bg-[#ffe9ec] text-[#a0233f]";
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

export function DecisionBriefWorkspace({ initialQuery, initialDiseaseId, initialMode = "balanced" }: Props) {
  const router = useRouter();
  const stream = useCaseRunStream();
  const startStream = stream.start;
  const stopStream = stream.stop;

  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState<RunMode>(initialMode);
  const [diseaseIdOverride, setDiseaseIdOverride] = useState<string | null>(initialDiseaseId ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showPathwayContext, setShowPathwayContext] = useState(true);
  const [showDrugContext, setShowDrugContext] = useState(true);
  const [showInteractionContext, setShowInteractionContext] = useState(false);

  useEffect(() => {
    startStream({
      query: initialQuery,
      diseaseId: initialDiseaseId ?? null,
      mode: initialMode,
    });

    return () => stopStream();
  }, [initialDiseaseId, initialMode, initialQuery, startStream, stopStream]);

  const activeSourceHealth = (stream.status?.sourceHealth ?? {}) as SourceHealth;

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return stream.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [selectedNodeId, stream.nodes]);

  const phaseProgress = useMemo(() => {
    const indexByPhase = new Map<string, number>(phaseOrder.map((phase, idx) => [phase, idx]));
    const reached = new Set<string>();
    for (const status of stream.statuses) {
      const idx = indexByPhase.get(status.phase);
      if (idx === undefined) continue;
      for (let i = 0; i <= idx; i += 1) {
        reached.add(phaseOrder[i]!);
      }
    }
    return reached;
  }, [stream.statuses]);

  const recommendation = stream.finalBrief?.recommendation ?? stream.recommendation;
  const naturalLanguageBrief = useMemo(() => {
    if (!recommendation) {
      return "Target ranking is still running. Early graph structure is already explorable while narrative synthesis completes.";
    }

    const pathway =
      stream.finalBrief?.recommendation?.pathway ??
      recommendation.pathway ??
      "not provided";
    const drugHook =
      stream.finalBrief?.recommendation?.drugHook ??
      recommendation.drugHook ??
      "not provided";
    const why = recommendation.why || "not provided";

    return `Current strongest thread: ${recommendation.target} in ${pathway}. Why now: ${why}. Primary tractability hook: ${drugHook}.`;
  }, [
    recommendation,
    stream.finalBrief?.recommendation?.drugHook,
    stream.finalBrief?.recommendation?.pathway,
  ]);

  const runBrief = () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    router.replace(
      `/brief?query=${encodeURIComponent(trimmed)}&mode=${mode}${
        diseaseIdOverride ? `&diseaseId=${encodeURIComponent(diseaseIdOverride)}` : ""
      }`,
    );

    stream.start({
      query: trimmed,
      diseaseId: diseaseIdOverride,
      mode,
    });
  };

  return (
    <main className="min-h-screen bg-transparent pb-8 text-[#2f2a70]">
      <header className="sticky top-0 z-40 border-b border-[#ddd9ff] bg-white/95 px-3 py-3 backdrop-blur md:px-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2">
            <Badge className="rounded-full bg-[#5b57e6] px-3 py-1 text-white">TargetGraph</Badge>
            <Button
              size="sm"
              variant="secondary"
              className="border-[#ddd9ff] bg-[#f3f1ff] text-[#4a4390] hover:bg-[#e7e3ff]"
              onClick={() => router.push("/")}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Main search
            </Button>
            <Badge className="rounded-full bg-[#f3f1ff] text-[#4a4390]">
              {stream.resolverSelection?.selected?.name ?? initialQuery}
            </Badge>
          </div>

          <div className="grid w-full gap-2 xl:w-[780px] xl:grid-cols-[minmax(0,1fr)_160px_140px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#746fb2]" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setDiseaseIdOverride(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    runBrief();
                  }
                }}
                placeholder="Ask a translational disease question"
                className="h-10 w-full rounded-lg border border-[#d6d1ff] bg-[#faf9ff] pl-9 pr-3 text-sm text-[#332f78] outline-none ring-[#5b57e6] placeholder:text-[#827dbb] focus:ring-2"
              />
            </div>

            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as RunMode)}
              className="h-10 rounded-lg border border-[#d6d1ff] bg-[#faf9ff] px-3 text-sm text-[#352f79]"
            >
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="deep">Deep</option>
            </select>

            <Button className="h-10 bg-[#5b57e6] text-white hover:bg-[#4a42ce]" onClick={runBrief}>
              {stream.isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run brief
            </Button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#6863aa]">
          <span className="rounded-full border border-[#dfdbff] bg-[#f7f5ff] px-3 py-1">
            Decision brief mode: {modeLabel[mode]}
          </span>
          <span className="rounded-full border border-[#dfdbff] bg-[#f7f5ff] px-3 py-1">
            {modeDescription[mode]}
          </span>
          <span className="rounded-full border border-[#dfdbff] bg-[#f7f5ff] px-3 py-1">
            {stream.status?.message ?? "Preparing run"}
          </span>
        </div>
      </header>

      <section className="border-b border-[#ddd9ff] bg-white/80 px-3 py-3 md:px-6">
        <div className="grid gap-2 md:grid-cols-7">
          {phaseOrder.map((phase) => {
            const reached = phaseProgress.has(phase);
            const active = stream.status?.phase === phase;
            return (
              <div key={phase} className="rounded-lg border border-[#ddd9ff] bg-[#fefeff] px-2.5 py-2 text-[11px]">
                <div className="flex items-center justify-between gap-2 font-semibold text-[#3a347f]">
                  <span>{phase}</span>
                  {active ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#5b57e6]" />
                  ) : reached ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Circle className="h-3 w-3 text-[#918bc9]" />
                  )}
                </div>
                <div className="mt-1 text-[#6f6aad]">{active ? stream.status?.message : "pending"}</div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-3 px-3 pt-3 md:px-6 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
        <aside className="order-2 space-y-3 xl:order-1 xl:sticky xl:top-[210px] xl:self-start">
          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">How We Found It</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#58539a]">
              <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                <div className="font-semibold text-[#433d87]">Disease Resolver</div>
                {stream.resolverSelection ? (
                  <>
                    <div className="mt-1">Matched: {stream.resolverSelection.selected.name}</div>
                    <div className="text-[#6c67ad]">{stream.resolverSelection.selected.id}</div>
                    <div className="mt-1 text-[#6c67ad]">{stream.resolverSelection.rationale}</div>
                  </>
                ) : (
                  <div className="mt-1 text-[#7a75b6]">Resolving disease entity...</div>
                )}
              </div>

              {stream.resolverCandidates.length > 0 ? (
                <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                  <div className="mb-1 font-semibold text-[#433d87]">Candidate entities</div>
                  <div className="flex flex-wrap gap-1.5">
                    {stream.resolverCandidates.slice(0, 8).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setDiseaseIdOverride(item.id);
                          setQuery(item.name);
                        }}
                        className={`rounded-full border px-2 py-0.5 text-[10px] ${
                          diseaseIdOverride === item.id
                            ? "border-[#5b57e6] bg-[#ebe8ff] text-[#3a347f]"
                            : "border-[#d7d2ff] bg-white text-[#5f599f]"
                        }`}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                <div className="mb-1 flex items-center gap-1 font-semibold text-[#433d87]">
                  <Telescope className="h-3.5 w-3.5" /> Agent timeline
                </div>
                <div className="max-h-[320px] space-y-1 overflow-auto pr-1">
                  {stream.agentSteps.length === 0 ? (
                    <div className="text-[#7a75b6]">Waiting for pipeline steps...</div>
                  ) : (
                    stream.agentSteps.map((step, index) => (
                      <div key={`${step.phase}-${index}`} className="rounded-md border border-[#e5e1ff] bg-white px-2 py-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7d78b8]">
                          {step.phase}
                        </div>
                        <div className="font-medium text-[#3f387f]">{step.title}</div>
                        <div className="text-[11px] text-[#6b65a9]">{step.detail}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">Graph Context</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#575299]">
              <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-2.5 py-2">
                <span>Pathway context</span>
                <Switch checked={showPathwayContext} onCheckedChange={setShowPathwayContext} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-2.5 py-2">
                <span>Drug context</span>
                <Switch checked={showDrugContext} onCheckedChange={setShowDrugContext} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-2.5 py-2">
                <span>Interaction context</span>
                <Switch checked={showInteractionContext} onCheckedChange={setShowInteractionContext} />
              </div>
            </CardContent>
          </Card>
        </aside>

        <section className="order-1 space-y-3 xl:order-2">
          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">Decision Brief</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-xs text-[#59539a]">
              <div className="grid gap-2 md:grid-cols-[1.3fr_1fr_1fr]">
                <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-[#7f79b8]">Recommendation</div>
                  <div className="mt-1 text-xl font-semibold text-[#352f7a]">
                    {recommendation?.target ?? "Pending target"}
                  </div>
                  <div className="mt-1 text-sm text-[#6f6aad]">{recommendation?.why ?? "Synthesizing rationale from streamed evidence."}</div>
                </div>

                <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-[#7f79b8]">Mechanism anchor</div>
                  <div className="mt-1 text-base font-semibold text-[#352f7a]">
                    {stream.finalBrief?.recommendation?.pathway ?? "not provided"}
                  </div>
                  <div className="mt-1 text-sm text-[#6f6aad]">{recommendation?.interactionHook ?? "Pathway hooks streaming."}</div>
                </div>

                <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] p-2">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-[#a7692a]">Score</div>
                  <div className="mt-1 text-xl font-semibold text-[#8b5728]">
                    {(recommendation?.score ?? 0).toFixed(3)}
                  </div>
                  <div className="mt-1 text-sm text-[#8f5b2d]">{stream.finalBrief?.recommendation?.drugHook ?? "Drugability hook pending"}</div>
                </div>
              </div>

              <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] px-2.5 py-2.5 text-sm leading-6 text-[#7f5129]">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#a7692a]">
                  Natural language brief
                </div>
                {naturalLanguageBrief}
              </div>

              {stream.finalBrief?.caveats?.length ? (
                <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] px-2.5 py-2 text-[#87572e]">
                  <div className="mb-1 flex items-center gap-1 font-semibold">
                    <ShieldAlert className="h-3.5 w-3.5" /> Key caveats
                  </div>
                  <ul className="space-y-1">
                    {stream.finalBrief.caveats.slice(0, 3).map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">Mechanism Path Graph</CardTitle>
            </CardHeader>
            <CardContent>
              <PathFirstGraph
                nodes={stream.nodes}
                edges={stream.edges}
                pathUpdate={stream.pathUpdate}
                showPathwayContext={showPathwayContext}
                showDrugContext={showDrugContext}
                showInteractionContext={showInteractionContext}
                onSelectNode={setSelectedNodeId}
              />
            </CardContent>
          </Card>

          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">Alternatives and Evidence Trace</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2 text-xs text-[#5c56a0]">
                  <div className="mb-1 font-semibold text-[#3e387f]">Alternative threads</div>
                  {stream.finalBrief?.alternatives?.length ? (
                    <div className="space-y-1.5">
                      {stream.finalBrief.alternatives.map((item) => (
                        <div key={item.symbol} className="rounded-md border border-[#e2ddff] bg-white px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-[#3e387f]">{item.symbol}</span>
                            <span className="text-[#8d87c2]">{item.score.toFixed(3)}</span>
                          </div>
                          <div className="text-[11px] text-[#6b65a9]">{item.reason}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[#7a75b6]">Alternatives appear after ranking stage.</div>
                  )}
                </div>

                <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2 text-xs text-[#5c56a0]">
                  <div className="mb-1 font-semibold text-[#3e387f]">Top evidence references</div>
                  {stream.finalBrief?.evidenceTrace?.length ? (
                    <div className="space-y-1.5">
                      {stream.finalBrief.evidenceTrace.map((item) => (
                        <div key={item.symbol} className="rounded-md border border-[#e2ddff] bg-white px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-[#3e387f]">{item.symbol}</span>
                            <span className="text-[#8d87c2]">{item.score.toFixed(3)}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-[#6b65a9]">
                            {item.refs.slice(0, 3).map((ref) => `${ref.field}:${String(ref.value)}`).join(" • ")}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[#7a75b6]">Evidence trace appears after ranking stage.</div>
                  )}
                </div>
              </div>

              <Separator className="bg-[#e0dcff]" />

              <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2 text-xs text-[#5c56a0]">
                <div className="mb-1 flex items-center gap-1 font-semibold text-[#3e387f]">
                  <Sparkles className="h-3.5 w-3.5" /> Next experiments
                </div>
                {stream.finalBrief?.nextActions?.length ? (
                  <ol className="space-y-1">
                    {stream.finalBrief.nextActions.map((item, index) => (
                      <li key={item}>{index + 1}. {item}</li>
                    ))}
                  </ol>
                ) : (
                  <div className="text-[#7a75b6]">Next-experiment suggestions appear after brief assembly.</div>
                )}
              </div>
            </CardContent>
          </Card>
        </section>

        <aside className="order-3 space-y-3 xl:sticky xl:top-[210px] xl:self-start">
          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">Run Health</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#575299]">
              <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                <div className="flex items-center gap-1 font-semibold text-[#433d87]">
                  <Clock3 className="h-3.5 w-3.5" /> Current status
                </div>
                <div className="mt-1 text-[#6b65a9]">{stream.status?.message ?? "initializing"}</div>
              </div>

              <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                <div className="mb-1 font-semibold text-[#433d87]">Source health</div>
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
                <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] p-2 text-[#8f5b2d]">
                  {stream.errors.slice(-2).map((error, index) => (
                    <div key={`${error}-${index}`}>• {error}</div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">Node Inspector</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#575299]">
              {!selectedNode ? (
                <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2 text-[#6f6aad]">
                  Click a graph node to inspect properties and evidence metadata.
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                    <div className="text-sm font-semibold text-[#3d367f]">{selectedNode.label}</div>
                    <div className="text-[11px] text-[#6f6aad]">{selectedNode.type}</div>
                    <div className="mt-1 text-[11px] text-[#6f6aad]">{selectedNode.primaryId}</div>
                  </div>
                  <div className="max-h-[220px] space-y-1 overflow-auto pr-1">
                    {Object.entries(selectedNode.meta).map(([key, value]) => (
                      <div key={key} className="rounded-md border border-[#e5e1ff] bg-white px-2 py-1.5">
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[#827dbb]">{key}</div>
                        <div className="text-[11px] text-[#4e488f] break-words">
                          {typeof value === "string" ? value : JSON.stringify(value)}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-[#d7d2ff] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#342f7b]">Case Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#575299]">
              <Button
                size="sm"
                className="w-full bg-[#5b57e6] text-white hover:bg-[#4a42ce]"
                onClick={runBrief}
              >
                <Play className="h-3.5 w-3.5" /> Re-run current brief
              </Button>

              <Button
                size="sm"
                variant="secondary"
                className="w-full border-[#d8d3ff] bg-[#f0edff] text-[#4a4390] hover:bg-[#e5e0ff]"
                onClick={() => {
                  downloadJson(
                    {
                      query,
                      mode,
                      resolver: stream.resolverSelection,
                      recommendation,
                      finalBrief: stream.finalBrief,
                      nodes: stream.nodes,
                      edges: stream.edges,
                      steps: stream.agentSteps,
                    },
                    `targetgraph-brief-${query.replace(/\s+/g, "-").toLowerCase()}.json`,
                  );
                }}
              >
                <Download className="h-3.5 w-3.5" /> Export brief JSON
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>

      <footer className="px-6 pt-4 text-[11px] text-[#6f6aad]">
        <div>Research evidence summary — not clinical guidance.</div>
      </footer>
    </main>
  );
}
