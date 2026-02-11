"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { Download, Filter, RefreshCw } from "lucide-react";
import { BuildStepper } from "@/components/targetgraph/build-stepper";
import { buildEvidenceTable } from "@/components/targetgraph/evidence";
import { HypothesisPanel } from "@/components/targetgraph/hypothesis-panel";
import { MechanismSankey } from "@/components/targetgraph/mechanism-sankey";
import { NodeInspector } from "@/components/targetgraph/node-inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useGraphStream } from "@/hooks/useGraphStream";
import { toast } from "sonner";

const GraphCanvas = dynamic(
  () => import("@/components/targetgraph/graph-canvas").then((mod) => mod.GraphCanvas),
  { ssr: false },
);

type Props = {
  diseaseQuery: string;
  defaults?: {
    pathways: boolean;
    drugs: boolean;
    interactions: boolean;
    literature: boolean;
  };
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

export function GraphWorkbench({ diseaseQuery, defaults }: Props) {
  const stream = useGraphStream();
  const { start, stop } = stream;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sankeyOpen, setSankeyOpen] = useState(true);
  const [showPathways, setShowPathways] = useState(defaults?.pathways ?? true);
  const [showDrugs, setShowDrugs] = useState(defaults?.drugs ?? true);
  const [showInteractions, setShowInteractions] = useState(defaults?.interactions ?? true);
  const [showLiterature, setShowLiterature] = useState(defaults?.literature ?? true);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    start(diseaseQuery, 20);
    return () => stop();
  }, [diseaseQuery, start, stop]);

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
  }, [stream.nodes, stream.edges, showPathways, showDrugs, showInteractions]);

  const selectedNode = useMemo(
    () => filtered.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [filtered.nodes, selectedNodeId],
  );

  const diseaseNode = useMemo(
    () => stream.nodes.find((node) => node.type === "disease") ?? null,
    [stream.nodes],
  );

  const rankingRows = useMemo(() => buildEvidenceTable(stream.nodes, stream.edges), [stream.nodes, stream.edges]);
  const nodeIdsByLabel = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const node of stream.nodes) {
      const current = map.get(node.label) ?? [];
      current.push(node.id);
      map.set(node.label, current);
    }
    return map;
  }, [stream.nodes]);

  const handleContinuePartial = (phase: string) => {
    toast.info(`Continuing ${phase} with partial data`);
  };

  const onSankeyBandClick = (source: string, target: string) => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();

    const sourceNodes = nodeIdsByLabel.get(source) ?? [];
    const targetNodes = nodeIdsByLabel.get(target) ?? [];
    const sourceNodeSet = new Set(sourceNodes);
    const targetNodeSet = new Set(targetNodes);

    sourceNodes.forEach((id) => nodeIds.add(id));
    targetNodes.forEach((id) => nodeIds.add(id));

    for (const edge of stream.edges) {
      if (sourceNodeSet.has(edge.source) && targetNodeSet.has(edge.target)) {
        edgeIds.add(edge.id);
      }
    }

    setHighlightedNodeIds(nodeIds);
    setHighlightedEdgeIds(edgeIds);
  };

  return (
    <div className="min-h-screen bg-[#060b12] pb-4 text-[#d8e9f9]">
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/10 bg-[#050b12]/95 px-3 py-3 backdrop-blur md:px-6">
        <div className="flex items-center gap-2">
          <Badge className="rounded-sm bg-[#15253c] text-cyan-100">TargetGraph</Badge>
          <span className="text-sm text-[#b4cce4]">{diseaseQuery}</span>
        </div>
        <div className="text-xs text-[#89a7c6]">Research evidence summary — not clinical guidance.</div>
      </header>
      <BuildStepper statuses={stream.statuses} onContinuePartial={handleContinuePartial} />

      <div className="grid gap-3 px-3 pt-3 xl:grid-cols-[300px_minmax(0,1fr)_360px] md:px-6">
        <div className="order-2 space-y-3 xl:order-1 xl:sticky xl:top-[164px] xl:self-start">
          <Card className="border-white/10 bg-[#0d1521]">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-[#dceeff]">Filters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-[#a7c0d8]">
              <div className="flex items-center justify-between rounded-md bg-[#152236] px-3 py-2">
                <span className="flex items-center gap-2"><Filter className="h-3 w-3" /> Pathways</span>
                <Switch checked={showPathways} onCheckedChange={setShowPathways} />
              </div>
              <div className="flex items-center justify-between rounded-md bg-[#152236] px-3 py-2">
                <span>Drugs</span>
                <Switch checked={showDrugs} onCheckedChange={setShowDrugs} />
              </div>
              <div className="flex items-center justify-between rounded-md bg-[#152236] px-3 py-2">
                <span>Interactions</span>
                <Switch checked={showInteractions} onCheckedChange={setShowInteractions} />
              </div>
              <div className="flex items-center justify-between rounded-md bg-[#152236] px-3 py-2">
                <span>Literature / Trials</span>
                <Switch checked={showLiterature} onCheckedChange={setShowLiterature} />
              </div>
              <Separator className="bg-white/10" />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => stream.start(diseaseQuery, 20)}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Rebuild
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
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
                  className="w-full"
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

          {stream.ranking ? (
            <Card className="border-white/10 bg-[#0d1521]">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-[#dceeff]">Ranked Targets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <ScrollArea className="h-[260px]">
                  <div className="space-y-2 pr-2">
                    {stream.ranking.rankedTargets.slice(0, 8).map((target) => (
                      <div key={target.id} className="rounded-md border border-white/10 bg-[#132034] p-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium text-[#e7f4ff]">
                            #{target.rank} {target.symbol}
                          </div>
                          <Badge className="bg-[#28466a] text-cyan-100">
                            {target.score.toFixed(3)}
                          </Badge>
                        </div>
                        <div className="mt-1 text-[11px] text-[#9db6ce]">
                          {target.reasons[0] ?? "No reason provided"}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="order-1 space-y-3 xl:order-2">
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
            <Card className="border-white/10 bg-[#0d1521]">
              <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
                <CardTitle className="text-sm text-[#dceeff]">Mechanism Trail (Sankey)</CardTitle>
                <CollapsibleTrigger asChild>
                  <Button size="sm" variant="secondary">
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

        <div className="order-3 xl:sticky xl:top-[164px] xl:self-start">
          <NodeInspector
            selectedNode={selectedNode}
            edges={stream.edges}
            enrichmentByNode={showLiterature ? stream.enrichmentByNode : {}}
          />
        </div>
      </div>

      <div className="px-6 pt-3 text-[11px] text-[#8faac6]">
        <div>Research evidence summary — not clinical guidance.</div>
        <div className="mt-1">Rows for hypothesis/ranking currently in memory: {rankingRows.length}</div>
      </div>
    </div>
  );
}
