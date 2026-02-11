"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, Filter, Play, RefreshCw, Search, Sparkles } from "lucide-react";
import { BuildStepper } from "@/components/targetgraph/build-stepper";
import { buildEvidenceTable } from "@/components/targetgraph/evidence";
import { HypothesisPanel } from "@/components/targetgraph/hypothesis-panel";
import { MechanismSankey } from "@/components/targetgraph/mechanism-sankey";
import { NodeInspector } from "@/components/targetgraph/node-inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useGraphStream } from "@/hooks/useGraphStream";
import { toast } from "sonner";

const GraphCanvas = dynamic(
  () => import("@/components/targetgraph/graph-canvas").then((mod) => mod.GraphCanvas),
  { ssr: false },
);

type BuildProfile = {
  pathways: boolean;
  drugs: boolean;
  interactions: boolean;
  literature: boolean;
};

type Props = {
  diseaseQuery: string;
  defaults?: BuildProfile;
  initialMaxTargets?: number;
};

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const recentStorageKey = "targetgraph_recent_cases";

export function GraphWorkbench({ diseaseQuery, defaults, initialMaxTargets = 6 }: Props) {
  const router = useRouter();
  const stream = useGraphStream();
  const { start, stop } = stream;

  const initialProfile = useMemo<BuildProfile>(
    () => ({
      pathways: defaults?.pathways ?? true,
      drugs: defaults?.drugs ?? true,
      interactions: defaults?.interactions ?? false,
      literature: defaults?.literature ?? false,
    }),
    [defaults?.drugs, defaults?.interactions, defaults?.literature, defaults?.pathways],
  );

  const [nextDiseaseQuery, setNextDiseaseQuery] = useState(diseaseQuery);
  const [maxTargets, setMaxTargets] = useState(initialMaxTargets);
  const [sankeyOpen, setSankeyOpen] = useState(true);
  const [showPathways, setShowPathways] = useState(initialProfile.pathways);
  const [showDrugs, setShowDrugs] = useState(initialProfile.drugs);
  const [showInteractions, setShowInteractions] = useState(initialProfile.interactions);
  const [showLiterature, setShowLiterature] = useState(initialProfile.literature);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<Set<string>>(new Set());
  const [recentCases, setRecentCases] = useState<string[]>([]);

  useEffect(() => {
    start(diseaseQuery, maxTargets, initialProfile);
    return () => stop();
  }, [diseaseQuery, initialProfile, maxTargets, start, stop]);

  useEffect(() => {
    setNextDiseaseQuery(diseaseQuery);
    setSelectedNodeId(null);
    setHighlightedNodeIds(new Set());
    setHighlightedEdgeIds(new Set());
  }, [diseaseQuery]);

  useEffect(() => {
    setShowPathways(initialProfile.pathways);
    setShowDrugs(initialProfile.drugs);
    setShowInteractions(initialProfile.interactions);
    setShowLiterature(initialProfile.literature);
  }, [initialProfile]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(recentStorageKey);
      const parsed = raw ? (JSON.parse(raw) as string[]) : [];
      setRecentCases(parsed);
    } catch {
      setRecentCases([]);
    }
  }, []);

  useEffect(() => {
    if (!diseaseQuery.trim()) return;
    setRecentCases((prev) => {
      const next = [diseaseQuery, ...prev.filter((item) => item !== diseaseQuery)].slice(0, 8);
      localStorage.setItem(recentStorageKey, JSON.stringify(next));
      return next;
    });
  }, [diseaseQuery]);

  const currentBuildProfile: BuildProfile = {
    pathways: showPathways,
    drugs: showDrugs,
    interactions: showInteractions,
    literature: showLiterature,
  };

  const filtered = useMemo(() => {
    const hiddenTypes = new Set<string>();
    if (!showPathways) hiddenTypes.add("pathway");
    if (!showDrugs) hiddenTypes.add("drug");
    if (!showInteractions) hiddenTypes.add("interaction");

    const nodes = stream.nodes.filter((node) => !hiddenTypes.has(node.type));
    const nodeIdSet = new Set(nodes.map((node) => node.id));
    const edges = stream.edges.filter(
      (edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target),
    );

    return { nodes, edges };
  }, [showDrugs, showInteractions, showPathways, stream.edges, stream.nodes]);

  const selectedNode = useMemo(
    () => filtered.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [filtered.nodes, selectedNodeId],
  );

  const diseaseNode = useMemo(
    () => stream.nodes.find((node) => node.type === "disease") ?? null,
    [stream.nodes],
  );

  const rankingRows = useMemo(
    () => buildEvidenceTable(stream.nodes, stream.edges),
    [stream.edges, stream.nodes],
  );

  const decisionBrief = useMemo(() => {
    if (!stream.ranking) return null;
    const top = stream.ranking.rankedTargets[0];
    return {
      topTarget: top?.symbol ?? "not provided",
      topReason: top?.reasons[0] ?? "not provided",
      pathways: stream.ranking.systemSummary.keyPathways.slice(0, 3),
      gaps: stream.ranking.systemSummary.dataGaps.slice(0, 2),
    };
  }, [stream.ranking]);

  const pipelineElapsedMs = useMemo(() => {
    const done = stream.statuses.P6;
    if (done && done.pct >= 100) return done.elapsedMs;
    const phases = Object.values(stream.statuses);
    if (phases.length === 0) return null;
    return phases.reduce((best, item) => (item.elapsedMs > best ? item.elapsedMs : best), 0);
  }, [stream.statuses]);

  const nodeIdsByLabel = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const node of stream.nodes) {
      map.set(node.label, [...(map.get(node.label) ?? []), node.id]);
    }
    return map;
  }, [stream.nodes]);

  const onSankeyBandClick = (source: string, target: string) => {
    const sourceNodes = nodeIdsByLabel.get(source) ?? [];
    const targetNodes = nodeIdsByLabel.get(target) ?? [];
    const sourceSet = new Set(sourceNodes);
    const targetSet = new Set(targetNodes);
    const nodeIds = new Set<string>([...sourceNodes, ...targetNodes]);
    const edgeIds = new Set<string>();

    for (const edge of stream.edges) {
      if (sourceSet.has(edge.source) && targetSet.has(edge.target)) {
        edgeIds.add(edge.id);
      }
    }

    setHighlightedNodeIds(nodeIds);
    setHighlightedEdgeIds(edgeIds);
  };

  const runNewSearch = () => {
    const query = nextDiseaseQuery.trim();
    if (!query) return;

    const url =
      `/graph?disease=${encodeURIComponent(query)}` +
      `&pathways=${showPathways ? 1 : 0}` +
      `&drugs=${showDrugs ? 1 : 0}` +
      `&interactions=${showInteractions ? 1 : 0}` +
      `&literature=${showLiterature ? 1 : 0}` +
      `&maxTargets=${maxTargets}`;

    router.push(url);
  };

  const rebuildCurrent = () => {
    start(diseaseQuery, maxTargets, currentBuildProfile);
    toast.success("Rebuilding with current profile");
  };

  const handleContinuePartial = (phase: string) => {
    toast.info(`Continuing ${phase} with partial data`);
  };

  return (
    <div className="min-h-screen bg-transparent pb-5 text-[#17385f]">
      <header className="sticky top-0 z-40 border-b border-[#cedff8] bg-white/96 px-3 py-3 backdrop-blur md:px-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2">
            <Badge className="rounded-full bg-[#1c56db] px-3 py-1 text-white">TargetGraph</Badge>
            <Button
              size="sm"
              variant="secondary"
              className="border-[#cfe1fb] bg-[#edf4ff] text-[#264f7f] hover:bg-[#dfeaff]"
              onClick={() => router.push("/")}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Main search
            </Button>
            <Badge className="rounded-full bg-[#edf4ff] text-[#315d92]">{diseaseQuery}</Badge>
          </div>

          <div className="flex w-full flex-col gap-2 xl:w-[680px] xl:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#6387b2]" />
              <input
                className="h-10 w-full rounded-lg border border-[#c7dbf8] bg-[#f8fbff] pl-9 pr-3 text-sm text-[#1d446f] outline-none ring-[#7ca9ec] placeholder:text-[#6f8fb4] focus:ring-2"
                value={nextDiseaseQuery}
                onChange={(event) => setNextDiseaseQuery(event.target.value)}
                placeholder="Start another disease search without leaving the workbench"
                onKeyDown={(event) => {
                  if (event.key === "Enter") runNewSearch();
                }}
              />
            </div>
            <Button className="h-10 bg-[#1a56db] text-white hover:bg-[#1546b4]" onClick={runNewSearch}>
              <Play className="h-3.5 w-3.5" /> Run search
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#587ca7]">
          <span className="rounded-full border border-[#d0e1fa] bg-[#f6faff] px-3 py-1">
            Research evidence summary — not clinical guidance.
          </span>
          <span className="rounded-full border border-[#d0e1fa] bg-[#f6faff] px-3 py-1">
            In-memory session, no persistence
          </span>
          <span className="rounded-full border border-[#d0e1fa] bg-[#f6faff] px-3 py-1">
            Streaming phases: disease → targets → pathways → drugs → interactions → narrative
          </span>
          <span className="rounded-full border border-[#d0e1fa] bg-[#f6faff] px-3 py-1">
            {stream.isStreaming
              ? "Status: building live network"
              : stream.isDone
                ? `Status: complete${pipelineElapsedMs ? ` in ${(pipelineElapsedMs / 1000).toFixed(1)}s` : ""}`
                : "Status: idle"}
          </span>
        </div>
      </header>

      <BuildStepper statuses={stream.statuses} onContinuePartial={handleContinuePartial} />

      <div className="grid gap-3 px-3 pt-3 xl:grid-cols-[310px_minmax(0,1fr)_370px] md:px-6">
        <div className="order-2 space-y-3 xl:order-1 xl:sticky xl:top-[178px] xl:self-start">
          <Card className="border-[#cfe1fb] bg-white/95">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-[#163f6b]">Case Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-[#3f638f]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5b7da5]">
                Build Profile
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#d5e4fa] bg-[#f7fbff] px-3 py-2">
                <span className="flex items-center gap-2"><Filter className="h-3 w-3" /> Pathways</span>
                <Switch checked={showPathways} onCheckedChange={setShowPathways} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#d5e4fa] bg-[#f7fbff] px-3 py-2">
                <span>Drugs</span>
                <Switch checked={showDrugs} onCheckedChange={setShowDrugs} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#d5e4fa] bg-[#f7fbff] px-3 py-2">
                <span>Interactions</span>
                <Switch checked={showInteractions} onCheckedChange={setShowInteractions} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#d5e4fa] bg-[#f7fbff] px-3 py-2">
                <span>Literature / Trials</span>
                <Switch checked={showLiterature} onCheckedChange={setShowLiterature} />
              </div>

              <div className="space-y-1 text-[11px] text-[#5f82aa]">
                <label htmlFor="max-targets-select" className="block font-medium text-[#355d8d]">
                  Target budget (speed vs depth)
                </label>
                <select
                  id="max-targets-select"
                  className="h-8 w-full rounded-md border border-[#c4d8f8] bg-[#f8fbff] px-2 text-xs text-[#1f446f]"
                  value={String(maxTargets)}
                  onChange={(event) => setMaxTargets(Number(event.target.value))}
                >
                  <option value="6">Fast (6 targets)</option>
                  <option value="10">Balanced (10 targets)</option>
                  <option value="15">Deep (15 targets)</option>
                  <option value="20">Maximum (20 targets)</option>
                </select>
              </div>

              <div className="text-[11px] text-[#6387b0]">
                Toggle changes update visibility immediately. Click Rebuild to fetch with this profile.
              </div>

              <Separator className="bg-[#d5e4fa]" />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 bg-[#1a56db] text-white hover:bg-[#1545b4]"
                  onClick={rebuildCurrent}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Rebuild
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1 border-[#cfe1fb] bg-[#eef4ff] text-[#285381] hover:bg-[#dfeaff]"
                  onClick={() => {
                    downloadJson(
                      {
                        diseaseQuery,
                        nodes: stream.nodes,
                        edges: stream.edges,
                        ranking: stream.ranking,
                      },
                      `targetgraph-${diseaseQuery.replace(/\s+/g, "-").toLowerCase()}.json`,
                    );
                    toast.success("Graph JSON exported");
                  }}
                >
                  <Download className="h-3.5 w-3.5" /> Export
                </Button>
              </div>

              {(highlightedNodeIds.size > 0 || highlightedEdgeIds.size > 0) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-[#325783] hover:bg-[#eef4ff]"
                  onClick={() => {
                    setHighlightedNodeIds(new Set());
                    setHighlightedEdgeIds(new Set());
                  }}
                >
                  Clear focus highlighting
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-[#cfe1fb] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#163f6b]">Case Workspace</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-xs text-[#5e81aa]">
                You do not need to start over each time. Run new diseases from the top bar or pick a recent case.
              </div>
              <div className="flex flex-wrap gap-2">
                {recentCases.length === 0 ? (
                  <span className="text-xs text-[#688ab0]">No recent cases yet.</span>
                ) : (
                  recentCases.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="rounded-full border border-[#c9dcf8] bg-[#eef5ff] px-3 py-1 text-xs text-[#264f7d] hover:bg-[#deebff]"
                      onClick={() =>
                        router.push(
                          `/graph?disease=${encodeURIComponent(item)}` +
                            `&pathways=${showPathways ? 1 : 0}` +
                            `&drugs=${showDrugs ? 1 : 0}` +
                            `&interactions=${showInteractions ? 1 : 0}` +
                            `&literature=${showLiterature ? 1 : 0}` +
                            `&maxTargets=${maxTargets}`,
                        )
                      }
                    >
                      {item}
                    </button>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <HypothesisPanel
            diseaseId={diseaseNode?.primaryId ?? null}
            nodes={stream.nodes}
            edges={stream.edges}
            includeInteractions={showInteractions}
            onHighlight={(nodeIds, edgeIds) => {
              setHighlightedNodeIds(nodeIds);
              setHighlightedEdgeIds(edgeIds);
            }}
          />
        </div>

        <div className="order-1 space-y-3 xl:order-2">
          <Card className="border-[#cfe1fb] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#163f6b]">Executive Readout</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-xs text-[#40668f] md:grid-cols-3">
              <div className="rounded-lg border border-[#d4e3f8] bg-[#f6faff] p-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-[#5c82aa]">Top target</div>
                <div className="mt-1 text-sm font-semibold text-[#214b79]">
                  {decisionBrief?.topTarget ?? "Pending ranking"}
                </div>
                <div className="mt-1 leading-5 text-[#5e82aa]">
                  {decisionBrief?.topReason ?? "Ranking summary appears when P6 completes."}
                </div>
              </div>
              <div className="rounded-lg border border-[#d4e3f8] bg-[#f6faff] p-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-[#5c82aa]">Mechanism anchors</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(decisionBrief?.pathways ?? []).length > 0 ? (
                    decisionBrief?.pathways.map((pathway) => (
                      <Badge key={pathway} className="bg-[#deebff] text-[#275080]">
                        {pathway}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-[#6b8eb4]">Pathway hooks pending</span>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-[#d4e3f8] bg-[#f6faff] p-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-[#5c82aa]">Data caveats</div>
                <div className="mt-1 leading-5 text-[#5e82aa]">
                  {(decisionBrief?.gaps ?? []).length > 0
                    ? decisionBrief?.gaps.join(" • ")
                    : "Data-gap summary pending ranking output."}
                </div>
              </div>
            </CardContent>
          </Card>

          <GraphCanvas
            nodes={filtered.nodes}
            edges={filtered.edges}
            selectedNodeId={selectedNodeId}
            onSelectNode={(node) => {
              setSelectedNodeId(node?.id ?? null);
              setHighlightedNodeIds(new Set());
              setHighlightedEdgeIds(new Set());
            }}
            highlightedNodeIds={highlightedNodeIds}
            highlightedEdgeIds={highlightedEdgeIds}
          />

          <Collapsible open={sankeyOpen} onOpenChange={setSankeyOpen}>
            <Card className="border-[#cfe1fb] bg-white/95">
              <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
                <CardTitle className="text-sm text-[#163f6b]">Mechanism Trail</CardTitle>
                <CollapsibleTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="border-[#cfe1fb] bg-[#eef4ff] text-[#2d5d92] hover:bg-[#deebff]"
                  >
                    {sankeyOpen ? "Collapse" : "Expand"}
                  </Button>
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent>
                  <MechanismSankey rows={stream.sankeyRows} onBandClick={onSankeyBandClick} />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </div>

        <div className="order-3 space-y-3 xl:sticky xl:top-[178px] xl:self-start">
          <Card className="border-[#cfe1fb] bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#163f6b]">Customer Value Brief</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#456a93]">
              <div className="rounded-lg border border-[#d4e3f8] bg-[#f6faff] p-2 leading-5">
                Customer outcome: one explainable place to move from disease query to mechanism-backed,
                rank-ordered targets and tractable compounds.
              </div>
              {decisionBrief ? (
                <div className="space-y-2 rounded-lg border border-[#d4e3f8] bg-[#f6faff] p-2">
                  <div className="flex items-center gap-1 font-semibold text-[#244b79]">
                    <Sparkles className="h-3.5 w-3.5" /> Current run summary
                  </div>
                  <div>Top actionable target: <span className="font-semibold">{decisionBrief.topTarget}</span></div>
                  <div className="text-[#5f82aa]">{decisionBrief.topReason}</div>
                  <div className="flex flex-wrap gap-1">
                    {decisionBrief.pathways.map((pathway) => (
                      <Badge key={pathway} className="bg-[#deebff] text-[#275080]">
                        {pathway}
                      </Badge>
                    ))}
                  </div>
                  <div>
                    Data gaps:
                    <ul className="mt-1 list-disc pl-4 text-[#5f82aa]">
                      {decisionBrief.gaps.map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-[#d4e3f8] bg-[#f6faff] p-2 text-[#6286af]">
                  Narrative summary appears after ranking completes.
                </div>
              )}
              <div className="rounded-lg border border-[#d4e3f8] bg-[#f6faff] p-2 text-[#557ca7]">
                Natural-language interpretation sits in ranked-target reasons, hypothesis mechanism thread,
                and this summary card.
              </div>
            </CardContent>
          </Card>

          <NodeInspector
            selectedNode={selectedNode}
            edges={stream.edges}
            enrichmentByNode={showLiterature ? stream.enrichmentByNode : {}}
          />
        </div>
      </div>

      <div className="px-6 pt-3 text-[11px] text-[#5f82aa]">
        <div>Research evidence summary — not clinical guidance.</div>
        <div className="mt-1">Rows currently used for ranking/hypothesis: {rankingRows.length}</div>
      </div>
    </div>
  );
}
