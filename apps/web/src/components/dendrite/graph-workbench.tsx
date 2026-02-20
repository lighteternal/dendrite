"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Brain,
  Download,
  Filter,
  ListTree,
  Network,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Telescope,
} from "lucide-react";
import { BuildStepper } from "@/components/dendrite/build-stepper";
import { DeepDiscoverer } from "@/components/dendrite/deep-discoverer";
import { buildEvidenceTable } from "@/components/dendrite/evidence";
import { HypothesisPanel } from "@/components/dendrite/hypothesis-panel";
import { MechanismSankey } from "@/components/dendrite/mechanism-sankey";
import { NodeInspector } from "@/components/dendrite/node-inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { GraphEdge } from "@/lib/contracts";
import type { DiscoverEntity } from "@/hooks/useDeepDiscoverStream";
import { useGraphStream } from "@/hooks/useGraphStream";
import { toast } from "sonner";

const GraphCanvas = dynamic(
  () => import("@/components/dendrite/graph-canvas").then((mod) => mod.GraphCanvas),
  { ssr: false },
);

type BuildProfile = {
  pathways: boolean;
  drugs: boolean;
  interactions: boolean;
  literature: boolean;
};

type WorkspaceView = "network" | "evidence" | "hypothesis" | "discoverer";
type ConnectionLens = "balanced" | "evidence" | "drugability" | "mechanism";

type Props = {
  diseaseQuery: string;
  defaults?: BuildProfile;
  initialMaxTargets?: number;
  initialDiseaseId?: string;
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

const recentStorageKey = "dendrite_recent_cases";

const lensLabel: Record<ConnectionLens, string> = {
  balanced: "Balanced",
  evidence: "Evidence-first",
  drugability: "Drug-actionability",
  mechanism: "Pathway-mechanism",
};

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function edgePriority(edge: GraphEdge, lens: ConnectionLens): number {
  const weight = typeof edge.weight === "number" ? edge.weight : 0.4;

  switch (lens) {
    case "evidence": {
      const evidenceBoost =
        edge.type === "disease_target"
          ? 1.2
          : edge.type === "disease_disease"
            ? 1
            : edge.type === "target_pathway"
              ? 1
              : 0.8;
      return weight * 4.2 + evidenceBoost;
    }
    case "drugability": {
      const typeBoost =
        edge.type === "target_drug"
          ? 3.4
          : edge.type === "disease_target"
            ? 1.8
            : edge.type === "disease_disease"
              ? 1.2
            : edge.type === "target_pathway"
              ? 1.2
              : 0.7;
      return typeBoost + weight * 2.4;
    }
    case "mechanism": {
      const typeBoost =
        edge.type === "target_pathway"
          ? 3
          : edge.type === "disease_target"
            ? 2.2
            : edge.type === "disease_disease"
              ? 1.8
            : edge.type === "target_target"
              ? 1.6
              : 1;
      return typeBoost + weight * 2;
    }
    case "balanced":
    default: {
      const typeBoost =
        edge.type === "disease_target"
          ? 2.3
          : edge.type === "disease_disease"
            ? 1.8
          : edge.type === "target_pathway"
            ? 2
            : edge.type === "target_drug"
              ? 1.9
              : edge.type === "target_target"
                ? 1.4
                : 1.1;
      return typeBoost + weight * 2.1;
    }
  }
}

export function GraphWorkbench({
  diseaseQuery,
  defaults,
  initialMaxTargets = 6,
  initialDiseaseId,
}: Props) {
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

  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("network");
  const [nextDiseaseQuery, setNextDiseaseQuery] = useState(diseaseQuery);
  const [maxTargets, setMaxTargets] = useState(initialMaxTargets);
  const [diseaseIdHint, setDiseaseIdHint] = useState<string | null>(initialDiseaseId ?? null);
  const [sankeyOpen, setSankeyOpen] = useState(true);
  const [showPathways, setShowPathways] = useState(initialProfile.pathways);
  const [showDrugs, setShowDrugs] = useState(initialProfile.drugs);
  const [showInteractions, setShowInteractions] = useState(initialProfile.interactions);
  const [showLiterature, setShowLiterature] = useState(initialProfile.literature);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<Set<string>>(new Set());
  const [recentCases, setRecentCases] = useState<string[]>([]);
  const [connectionLens, setConnectionLens] = useState<ConnectionLens>("balanced");
  const [edgeBudget, setEdgeBudget] = useState(150);

  useEffect(() => {
    setDiseaseIdHint(initialDiseaseId ?? null);
    setMaxTargets(initialMaxTargets);
  }, [initialDiseaseId, initialMaxTargets]);

  useEffect(() => {
    start(diseaseQuery, initialMaxTargets, initialProfile, initialDiseaseId ?? null);
    return () => stop();
  }, [diseaseQuery, initialDiseaseId, initialMaxTargets, initialProfile, start, stop]);

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

    const baseNodes = stream.nodes.filter((node) => !hiddenTypes.has(node.type));
    const baseNodeIdSet = new Set(baseNodes.map((node) => node.id));
    const baseEdges = stream.edges.filter(
      (edge) => baseNodeIdSet.has(edge.source) && baseNodeIdSet.has(edge.target),
    );
    const scored = [...baseEdges]
      .map((edge) => ({ edge, score: edgePriority(edge, connectionLens) }))
      .sort((a, b) => b.score - a.score || a.edge.id.localeCompare(b.edge.id));

    const grouped: Record<GraphEdge["type"], Array<{ edge: GraphEdge; score: number }>> = {
      disease_target: [],
      disease_disease: [],
      target_pathway: [],
      target_drug: [],
      target_target: [],
      pathway_drug: [],
    };
    for (const item of scored) {
      grouped[item.edge.type].push(item);
    }

    const selected = new Map<string, GraphEdge>();
    const pick = (type: GraphEdge["type"], count: number) => {
      if (count <= 0) return;
      let picked = 0;
      for (const item of grouped[type]) {
        if (selected.size >= edgeBudget) break;
        if (selected.has(item.edge.id)) continue;
        selected.set(item.edge.id, item.edge);
        picked += 1;
        if (picked >= count) break;
      }
    };

    const diseaseFloor = Math.min(
      grouped.disease_target.length,
      Math.max(8, Math.floor(edgeBudget * 0.18)),
    );
    pick("disease_target", diseaseFloor);

    const remainingBudget = Math.max(0, edgeBudget - selected.size);
    const pathwayQuota = showPathways ? Math.max(14, Math.floor(remainingBudget * 0.36)) : 0;
    const drugQuota = showDrugs ? Math.max(14, Math.floor(remainingBudget * 0.42)) : 0;
    const interactionQuota = showInteractions ? Math.max(8, Math.floor(remainingBudget * 0.18)) : 0;

    pick("target_pathway", pathwayQuota);
    pick("pathway_drug", Math.floor(pathwayQuota * 0.5));
    pick("target_drug", drugQuota);
    pick("target_target", interactionQuota);

    for (const item of scored) {
      if (selected.size >= edgeBudget) break;
      if (selected.has(item.edge.id)) continue;
      selected.set(item.edge.id, item.edge);
    }

    const keptEdges = [...selected.values()];

    const visibleNodeIds = new Set<string>();
    for (const edge of keptEdges) {
      visibleNodeIds.add(edge.source);
      visibleNodeIds.add(edge.target);
    }

    for (const node of baseNodes) {
      if (node.type === "disease") {
        visibleNodeIds.add(node.id);
      }
    }

    if (selectedNodeId) {
      visibleNodeIds.add(selectedNodeId);
    }

    const nodes = baseNodes.filter((node) => visibleNodeIds.has(node.id));
    const nodeIdSet = new Set(nodes.map((node) => node.id));
    const edges = keptEdges.filter((edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target));

    return {
      nodes,
      edges,
      totalEdges: baseEdges.length,
      hiddenEdges: Math.max(0, baseEdges.length - edges.length),
      totalNodes: baseNodes.length,
      hiddenNodes: Math.max(0, baseNodes.length - nodes.length),
    };
  }, [connectionLens, edgeBudget, selectedNodeId, showDrugs, showInteractions, showPathways, stream.edges, stream.nodes]);

  const selectedNode = useMemo(
    () => stream.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [stream.nodes, selectedNodeId],
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

  const executiveNarrative = useMemo(() => {
    if (!stream.ranking) {
      return [
        "Target ranking is still running. Early graph structure is already explorable while narrative synthesis completes.",
      ];
    }

    const top = stream.ranking.rankedTargets[0];
    const topReason = top?.reasons?.[0] ?? "not provided";
    const caveat = top?.caveats?.[0] ?? stream.ranking.systemSummary.dataGaps[0] ?? "not provided";
    const anchors = stream.ranking.systemSummary.keyPathways.slice(0, 3);

    return [
      `Current strongest lever: ${top?.symbol ?? "not provided"} (${top ? top.score.toFixed(3) : "not provided"}).`,
      `Why now: ${topReason}`,
      `Mechanism anchors in this run: ${anchors.length > 0 ? anchors.join(", ") : "not provided"}.`,
      `Primary caveat: ${caveat}`,
    ];
  }, [stream.ranking]);

  const pipelineElapsedMs = useMemo(() => {
    const done = stream.statuses.P6;
    if (done && done.pct >= 100) return done.elapsedMs;
    const phases = Object.values(stream.statuses);
    if (phases.length === 0) return null;
    return phases.reduce((best, item) => (item.elapsedMs > best ? item.elapsedMs : best), 0);
  }, [stream.statuses]);

  const nodeLookup = useMemo(() => {
    const map = new Map<string, string[]>();
    const add = (key: string, nodeId: string) => {
      const normalized = normalizeLookupValue(key);
      if (!normalized) return;
      map.set(normalized, [...(map.get(normalized) ?? []), nodeId]);
    };

    for (const node of stream.nodes) {
      add(node.label, node.id);
      add(node.primaryId, node.id);
      add(`${node.type}:${node.primaryId}`, node.id);

      const displayName =
        typeof node.meta.displayName === "string" ? node.meta.displayName : undefined;
      const targetSymbol =
        typeof node.meta.targetSymbol === "string" ? node.meta.targetSymbol : undefined;
      if (displayName) add(displayName, node.id);
      if (targetSymbol) add(targetSymbol, node.id);
    }
    return map;
  }, [stream.nodes]);

  const onSankeyBandClick = (source: string, target: string) => {
    const sourceNodes = nodeLookup.get(normalizeLookupValue(source)) ?? [];
    const targetNodes = nodeLookup.get(normalizeLookupValue(target)) ?? [];
    const sourceSet = new Set(sourceNodes);
    const targetSet = new Set(targetNodes);
    const nodeIds = new Set<string>([...sourceNodes, ...targetNodes]);
    const edgeIds = new Set<string>();

    for (const edge of stream.edges) {
      if (sourceSet.has(edge.source) && targetSet.has(edge.target)) {
        edgeIds.add(edge.id);
      }
    }

    setWorkspaceView("network");
    setHighlightedNodeIds(nodeIds);
    setHighlightedEdgeIds(edgeIds);
  };

  const focusDiscovererEntities = (entities: DiscoverEntity[]) => {
    if (entities.length === 0) return;

    const nodeIds = new Set<string>();
    for (const entity of entities) {
      if (entity.primaryId) {
        const idsByPrimary = nodeLookup.get(
          normalizeLookupValue(`${entity.type}:${entity.primaryId}`),
        );
        idsByPrimary?.forEach((id) => nodeIds.add(id));
      }

      const idsByLabel = nodeLookup.get(normalizeLookupValue(entity.label));
      idsByLabel?.forEach((id) => nodeIds.add(id));
    }

    if (nodeIds.size === 0) return;

    const edgeIds = new Set<string>();
    for (const edge of stream.edges) {
      if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
        edgeIds.add(edge.id);
      }
    }

    setWorkspaceView("network");
    setHighlightedNodeIds(nodeIds);
    setHighlightedEdgeIds(edgeIds);
  };

  const runNewSearch = () => {
    const query = nextDiseaseQuery.trim();
    if (!query) return;

    const params = new URLSearchParams({
      disease: query,
      pathways: showPathways ? "1" : "0",
      drugs: showDrugs ? "1" : "0",
      interactions: showInteractions ? "1" : "0",
      literature: showLiterature ? "1" : "0",
      maxTargets: String(maxTargets),
    });

    router.push(`/graph?${params.toString()}`);
  };

  const rebuildCurrent = () => {
    start(diseaseQuery, maxTargets, currentBuildProfile, diseaseIdHint);
    toast.success("Rebuilding with current profile");
  };

  const handleContinuePartial = (phase: string) => {
    toast.info(`Continuing ${phase} with partial data`);
  };

  const clearFocus = () => {
    setHighlightedNodeIds(new Set());
    setHighlightedEdgeIds(new Set());
  };

  const caseControlsCard = (
    <Card className="border-[#d7d2ff] bg-white/95">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm text-[#342f7b]">Case Controls</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs text-[#554f98]">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7772b6]">
          Build Profile
        </div>
        <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-3 py-2">
          <span className="flex items-center gap-2"><Filter className="h-3 w-3" /> Pathways</span>
          <Switch checked={showPathways} onCheckedChange={setShowPathways} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-3 py-2">
          <span>Drugs</span>
          <Switch checked={showDrugs} onCheckedChange={setShowDrugs} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-3 py-2">
          <span>Interactions</span>
          <Switch checked={showInteractions} onCheckedChange={setShowInteractions} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-3 py-2">
          <span>Literature / Trials</span>
          <Switch checked={showLiterature} onCheckedChange={setShowLiterature} />
        </div>

        <div className="space-y-1 text-[11px] text-[#6f6aad]">
          <label htmlFor="max-targets-select" className="block font-medium text-[#4d468f]">
            Target budget (speed vs depth)
          </label>
          <select
            id="max-targets-select"
            className="h-8 w-full rounded-md border border-[#d2ceff] bg-[#f8f7ff] px-2 text-xs text-[#342f7b]"
            value={String(maxTargets)}
            onChange={(event) => setMaxTargets(Number(event.target.value))}
          >
            <option value="6">Fast (6 targets)</option>
            <option value="10">Balanced (10 targets)</option>
            <option value="15">Deep (15 targets)</option>
            <option value="20">Maximum (20 targets)</option>
          </select>
        </div>

        <div className="space-y-1 text-[11px] text-[#6f6aad]">
          <label htmlFor="connection-lens" className="block font-medium text-[#4d468f]">
            Predominant-connection lens
          </label>
          <select
            id="connection-lens"
            className="h-8 w-full rounded-md border border-[#d2ceff] bg-[#f8f7ff] px-2 text-xs text-[#342f7b]"
            value={connectionLens}
            onChange={(event) => setConnectionLens(event.target.value as ConnectionLens)}
          >
            <option value="balanced">Balanced</option>
            <option value="evidence">Evidence-first</option>
            <option value="drugability">Drug-actionability</option>
            <option value="mechanism">Pathway-mechanism</option>
          </select>
        </div>

        <div className="space-y-1 text-[11px] text-[#6f6aad]">
          <div className="flex items-center justify-between">
            <span className="font-medium text-[#4d468f]">Network density</span>
            <span>{edgeBudget} edges</span>
          </div>
          <input
            type="range"
            min={60}
            max={560}
            step={10}
            value={edgeBudget}
            onChange={(event) => setEdgeBudget(Number(event.target.value))}
            className="w-full accent-[#5b57e6]"
          />
          <div className="rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-2 py-1 text-[10px] leading-4">
            Showing strongest {filtered.edges.length}/{filtered.totalEdges} edges using {lensLabel[connectionLens]}.
            {filtered.hiddenEdges > 0 ? ` +${filtered.hiddenEdges} more hidden (increase density to include).` : ""}
          </div>
        </div>

        <Separator className="bg-[#e0dcff]" />
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1 bg-[#5b57e6] text-white hover:bg-[#4a42ce]"
            onClick={rebuildCurrent}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Rebuild
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="flex-1 border-[#d8d3ff] bg-[#f0edff] text-[#4a4390] hover:bg-[#e5e0ff]"
            onClick={() => {
              downloadJson(
                {
                  diseaseQuery,
                  nodes: stream.nodes,
                  edges: stream.edges,
                  ranking: stream.ranking,
                },
                `dendrite-${diseaseQuery.replace(/\s+/g, "-").toLowerCase()}.json`,
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
            className="w-full text-[#4c458f] hover:bg-[#f0edff]"
            onClick={clearFocus}
          >
            Clear focus highlighting
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );

  const caseWorkspaceCard = (
    <Card className="border-[#d7d2ff] bg-white/95">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-[#342f7b]">Case Workspace</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-xs text-[#6560a5]">
          Run Network, Evidence, Hypothesis, or Discoverer workflows without restarting the case.
        </div>
        <div className="flex flex-wrap gap-2">
          {recentCases.length === 0 ? (
            <span className="text-xs text-[#7f79b8]">No recent cases yet.</span>
          ) : (
            recentCases.map((item) => (
              <button
                key={item}
                type="button"
                className="rounded-full border border-[#d6d1ff] bg-[#f1efff] px-3 py-1 text-xs text-[#433d86] hover:bg-[#e5e0ff]"
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
  );

  const executiveCard = (
    <Card className="border-[#d7d2ff] bg-white/95">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-[#342f7b]">Executive Readout</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-[#575299]">
        <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
          <div className="text-[11px] uppercase tracking-[0.12em] text-[#7f79b8]">Top target</div>
          <div className="mt-1 text-sm font-semibold text-[#342f7b]">
            {decisionBrief?.topTarget ?? "Pending ranking"}
          </div>
          <div className="mt-1 leading-5 text-[#6f6aad]">
            {decisionBrief?.topReason ?? "Ranking summary appears when P6 completes."}
          </div>
        </div>
        <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
          <div className="text-[11px] uppercase tracking-[0.12em] text-[#7f79b8]">Mechanism anchors</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(decisionBrief?.pathways ?? []).length > 0 ? (
              decisionBrief?.pathways.map((pathway) => (
                <Badge key={pathway} className="bg-[#ece8ff] text-[#4a4390]">
                  {pathway}
                </Badge>
              ))
            ) : (
              <span className="text-[#7d78b8]">Pathway hooks pending</span>
            )}
          </div>
        </div>
        <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] p-2">
          <div className="text-[11px] uppercase tracking-[0.12em] text-[#a7692a]">Data caveats</div>
          <div className="mt-1 leading-5 text-[#895b30]">
            {(decisionBrief?.gaps ?? []).length > 0
              ? decisionBrief?.gaps.join(" • ")
              : "Data-gap summary pending ranking output."}
          </div>
        </div>
        </div>
        <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] p-2">
          <div className="text-[11px] uppercase tracking-[0.12em] text-[#a7692a]">Natural language brief</div>
          <div className="mt-1 space-y-1 leading-5 text-[#83552c]">
            {executiveNarrative.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const valueCard = (
    <Card className="border-[#d7d2ff] bg-white/95">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-[#342f7b]">Customer Value Brief</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-[#575299]">
        <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2 leading-5">
          One workspace from disease query to explainable targets, pathways, compounds, and mechanistic context.
        </div>
        {decisionBrief ? (
          <div className="space-y-2 rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
            <div className="flex items-center gap-1 font-semibold text-[#4a4390]">
              <Sparkles className="h-3.5 w-3.5" /> Current run summary
            </div>
            <div>
              Top actionable target: <span className="font-semibold">{decisionBrief.topTarget}</span>
            </div>
            <div className="text-[#6f6aad]">{decisionBrief.topReason}</div>
            <div className="text-[#895b30]">Caveats: {(decisionBrief.gaps ?? []).join(" • ") || "none provided"}</div>
          </div>
        ) : (
          <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2 text-[#6f6aad]">
            Narrative summary appears after ranking completes.
          </div>
        )}
      </CardContent>
    </Card>
  );

  const mechanismCard = (
    <Collapsible open={sankeyOpen} onOpenChange={setSankeyOpen}>
      <Card className="border-[#d7d2ff] bg-white/95">
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
          <CardTitle className="text-sm text-[#342f7b]">Mechanism Trail</CardTitle>
          <CollapsibleTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              className="border-[#d8d3ff] bg-[#f0edff] text-[#4a4390] hover:bg-[#e5e0ff]"
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
  );

  return (
    <div className="min-h-screen bg-transparent pb-5 text-[#2f2a70]">
      <header className="sticky top-0 z-40 border-b border-[#ddd9ff] bg-white/96 px-3 py-3 backdrop-blur md:px-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2">
            <Badge className="rounded-full bg-[#5b57e6] px-3 py-1 text-white">Dendrite</Badge>
            <Button
              size="sm"
              variant="secondary"
              className="border-[#ddd9ff] bg-[#f3f1ff] text-[#4a4390] hover:bg-[#e7e3ff]"
              onClick={() => router.push("/")}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Main search
            </Button>
            <Badge className="rounded-full bg-[#f3f1ff] text-[#4a4390]">{diseaseQuery}</Badge>
          </div>

          <div className="flex w-full flex-col gap-2 xl:w-[680px] xl:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#746fb2]" />
              <input
                className="h-10 w-full rounded-lg border border-[#d6d1ff] bg-[#faf9ff] pl-9 pr-3 text-sm text-[#332f78] outline-none ring-[#5b57e6] placeholder:text-[#827dbb] focus:ring-2"
                value={nextDiseaseQuery}
                onChange={(event) => {
                  setNextDiseaseQuery(event.target.value);
                  setDiseaseIdHint(null);
                }}
                placeholder="Start another disease search"
                onKeyDown={(event) => {
                  if (event.key === "Enter") runNewSearch();
                }}
              />
            </div>
            <Button className="h-10 bg-[#5b57e6] text-white hover:bg-[#4a42ce]" onClick={runNewSearch}>
              <Play className="h-3.5 w-3.5" /> Run search
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#6863aa]">
          <span className="rounded-full border border-[#dfdbff] bg-[#f7f5ff] px-3 py-1">
            Research evidence summary — not clinical guidance.
          </span>
          <span className="rounded-full border border-[#dfdbff] bg-[#f7f5ff] px-3 py-1">
            In-memory session, no persistence
          </span>
          <span className="rounded-full border border-[#dfdbff] bg-[#f7f5ff] px-3 py-1">
            Streaming phases: disease → targets → pathways → drugs → interactions → narrative
          </span>
          <span className="rounded-full border border-[#dfdbff] bg-[#f7f5ff] px-3 py-1">
            {stream.isStreaming
              ? "Status: building live network"
              : stream.isInterrupted
                ? "Status: stream interrupted (partial results shown)"
              : stream.isDone
                ? `Status: complete${pipelineElapsedMs ? ` in ${(pipelineElapsedMs / 1000).toFixed(1)}s` : ""}`
                : "Status: idle"}
          </span>
        </div>
      </header>

      <BuildStepper statuses={stream.statuses} onContinuePartial={handleContinuePartial} />

      <Tabs
        value={workspaceView}
        onValueChange={(value) => setWorkspaceView(value as WorkspaceView)}
        className="px-3 pt-3 md:px-6"
      >
        <TabsList className="grid w-full max-w-[980px] grid-cols-4 border border-[#ddd9ff] bg-white/95">
          <TabsTrigger value="network" className="gap-1"><Network className="h-3.5 w-3.5" /> Network</TabsTrigger>
          <TabsTrigger value="evidence" className="gap-1"><ListTree className="h-3.5 w-3.5" /> Evidence</TabsTrigger>
          <TabsTrigger value="hypothesis" className="gap-1"><Brain className="h-3.5 w-3.5" /> Hypothesis</TabsTrigger>
          <TabsTrigger value="discoverer" className="gap-1"><Telescope className="h-3.5 w-3.5" /> Discoverer</TabsTrigger>
        </TabsList>

        <TabsContent value="network" className="mt-3">
          <div className="grid gap-3 xl:grid-cols-[310px_minmax(0,1fr)_370px]">
            <div className="order-2 space-y-3 xl:order-1 xl:sticky xl:top-[182px] xl:self-start">
              {caseControlsCard}
              {caseWorkspaceCard}
            </div>

            <div className="order-1 space-y-3 xl:order-2">
              {executiveCard}

              <Card className="border-[#d7d2ff] bg-white/95">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-[#342f7b]">Network Canvas</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] px-2.5 py-2 text-[11px] text-[#8b5b2f]">
                    Showing predominant {lensLabel[connectionLens]} connections. {filtered.hiddenEdges > 0
                      ? `${filtered.hiddenEdges} edges and ${filtered.hiddenNodes} nodes are hidden to keep readability.`
                      : "All available edges are currently visible."}
                  </div>
                  <GraphCanvas
                    nodes={filtered.nodes}
                    edges={filtered.edges}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(node) => {
                      setSelectedNodeId(node?.id ?? null);
                      clearFocus();
                    }}
                    highlightedNodeIds={highlightedNodeIds}
                    highlightedEdgeIds={highlightedEdgeIds}
                    hiddenSummary={{
                      hiddenNodes: filtered.hiddenNodes,
                      hiddenEdges: filtered.hiddenEdges,
                      lens: lensLabel[connectionLens],
                    }}
                  />
                </CardContent>
              </Card>

              {mechanismCard}
            </div>

            <div className="order-3 space-y-3 xl:sticky xl:top-[182px] xl:self-start">
              {valueCard}
              <NodeInspector
                selectedNode={selectedNode}
                edges={stream.edges}
                enrichmentByNode={showLiterature ? stream.enrichmentByNode : {}}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="evidence" className="mt-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_370px]">
            <div className="space-y-3">
              {executiveCard}
              {mechanismCard}

              <Card className="border-[#d7d2ff] bg-white/95">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-[#342f7b]">Top Ranked Target Rationale</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-[#5a5599]">
                  {stream.ranking?.rankedTargets?.slice(0, 5).map((target) => (
                    <div key={target.id} className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2">
                      <div className="font-semibold text-[#3e387f]">{target.rank}. {target.symbol} ({target.score.toFixed(3)})</div>
                      <div className="mt-1 text-[#6d68ad]">{target.reasons[0] ?? "not provided"}</div>
                      {target.caveats[0] ? (
                        <div className="mt-1 text-[#91643a]">Caveat: {target.caveats[0]}</div>
                      ) : null}
                    </div>
                  ))}
                  {!stream.ranking ? (
                    <div className="rounded-lg border border-[#e0dcff] bg-[#f7f5ff] p-2 text-[#7571b4]">
                      Ranking details appear after the narrative stage completes.
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-3 xl:sticky xl:top-[182px] xl:self-start">
              {valueCard}
              <NodeInspector
                selectedNode={selectedNode}
                edges={stream.edges}
                enrichmentByNode={showLiterature ? stream.enrichmentByNode : {}}
              />
              {caseWorkspaceCard}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="hypothesis" className="mt-3">
          <div className="grid gap-3 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-3 xl:sticky xl:top-[182px] xl:self-start">
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
              {caseControlsCard}
            </div>

            <div className="space-y-3">
              {executiveCard}
              <GraphCanvas
                nodes={filtered.nodes}
                edges={filtered.edges}
                selectedNodeId={selectedNodeId}
                onSelectNode={(node) => {
                  setSelectedNodeId(node?.id ?? null);
                }}
                highlightedNodeIds={highlightedNodeIds}
                highlightedEdgeIds={highlightedEdgeIds}
                hiddenSummary={{
                  hiddenNodes: filtered.hiddenNodes,
                  hiddenEdges: filtered.hiddenEdges,
                  lens: lensLabel[connectionLens],
                }}
              />
              {mechanismCard}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="discoverer" className="mt-3">
          <div className="grid gap-3 xl:grid-cols-[420px_minmax(0,1fr)]">
            <div className="space-y-3 xl:sticky xl:top-[182px] xl:self-start">
              <DeepDiscoverer
                diseaseQuery={diseaseQuery}
                diseaseId={diseaseNode?.primaryId ?? null}
                onFocusEntities={focusDiscovererEntities}
              />
              {caseControlsCard}
            </div>

            <div className="space-y-3">
              {executiveCard}
              <Card className="border-[#d7d2ff] bg-white/95">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-[#342f7b]">Discovery Graph Focus</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="rounded-lg border border-[#f3d1ab] bg-[#fff7ec] px-2.5 py-2 text-[11px] text-[#8b5b2f]">
                    Click any journey event to focus the graph on entities surfaced by the agent.
                  </div>
                  <GraphCanvas
                    nodes={filtered.nodes}
                    edges={filtered.edges}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(node) => {
                      setSelectedNodeId(node?.id ?? null);
                    }}
                    highlightedNodeIds={highlightedNodeIds}
                    highlightedEdgeIds={highlightedEdgeIds}
                    hiddenSummary={{
                      hiddenNodes: filtered.hiddenNodes,
                      hiddenEdges: filtered.hiddenEdges,
                      lens: lensLabel[connectionLens],
                    }}
                  />
                </CardContent>
              </Card>
              {mechanismCard}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <div className="px-6 pt-3 text-[11px] text-[#6f6aad]">
        <div>Research evidence summary — not clinical guidance.</div>
        <div className="mt-1">Rows currently used for ranking/hypothesis: {rankingRows.length}</div>
      </div>
    </div>
  );
}
