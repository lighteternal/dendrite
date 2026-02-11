"use client";

import { useMemo, useState } from "react";
import type { GraphEdge, GraphNode, HypothesisResponse } from "@/lib/contracts";
import { makeEdgeId, makeNodeId } from "@/lib/graph";
import { buildEvidenceTable } from "@/components/targetgraph/evidence";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

type Props = {
  diseaseId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  includeInteractions: boolean;
  onHighlight: (nodeIds: Set<string>, edgeIds: Set<string>) => void;
};

export function HypothesisPanel({
  diseaseId,
  nodes,
  edges,
  includeInteractions,
  onHighlight,
}: Props) {
  const [enabled, setEnabled] = useState(false);
  const [pathwayId, setPathwayId] = useState<string>("");
  const [noveltyActionability, setNoveltyActionability] = useState<number>(60);
  const [riskTolerance, setRiskTolerance] = useState<number>(50);
  const [outputCount, setOutputCount] = useState<"1" | "3">("1");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HypothesisResponse | null>(null);

  const pathways = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "pathway")
        .map((node) => ({ id: node.primaryId, label: node.label, nodeId: node.id })),
    [nodes],
  );

  const runHypothesis = async () => {
    if (!enabled || !diseaseId || !pathwayId) return;
    setLoading(true);

    try {
      const evidence = buildEvidenceTable(nodes, edges);
      const response = await fetch("/api/hypothesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          diseaseId,
          pathwayId,
          outputCount: Number(outputCount),
          sliderWeights: {
            noveltyToActionability: noveltyActionability,
            riskTolerance,
          },
          graphEvidenceTable: evidence,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const json = (await response.json()) as HypothesisResponse;
      setResult(json);

      const nodeIds = new Set<string>();
      const edgeIds = new Set<string>();

      const diseaseNode = nodes.find((node) => node.type === "disease");
      if (diseaseNode) nodeIds.add(diseaseNode.id);

      const pathwayNodeId = makeNodeId("pathway", pathwayId);
      nodeIds.add(pathwayNodeId);

      for (const target of json.recommendedTargets) {
        const targetNodeId = makeNodeId("target", target.id);
        nodeIds.add(targetNodeId);

        if (diseaseNode) {
          edgeIds.add(makeEdgeId(diseaseNode.id, targetNodeId, "disease_target"));
        }

        edgeIds.add(makeEdgeId(targetNodeId, pathwayNodeId, "target_pathway"));

        const targetDrugEdges = edges.filter(
          (edge) => edge.type === "target_drug" && edge.source === targetNodeId,
        );

        for (const edge of targetDrugEdges) {
          edgeIds.add(edge.id);
          nodeIds.add(edge.target);
        }

        if (includeInteractions) {
          const interactionEdges = edges.filter(
            (edge) =>
              edge.type === "target_target" &&
              (edge.source === targetNodeId || edge.target === targetNodeId),
          );

          for (const edge of interactionEdges) {
            edgeIds.add(edge.id);
            nodeIds.add(edge.source);
            nodeIds.add(edge.target);
          }
        }
      }

      onHighlight(nodeIds, edgeIds);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-[#d7d2ff] bg-white/95">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm text-[#342f7b]">Hypothesis Mode</CardTitle>
        <p className="text-xs text-[#6963a9]">
          Select a pathway and scoring profile to produce a mechanism thread with auditable evidence.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs text-[#58529a]">
        <div className="flex items-center justify-between rounded-md border border-[#e0dcff] bg-[#f7f5ff] px-3 py-2">
          <span>Enable director-mode scoring</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-2">
          <div>Pathway</div>
          <Select value={pathwayId} onValueChange={setPathwayId} disabled={!enabled}>
            <SelectTrigger className="border-[#ddd9ff] bg-[#f8f7ff] text-[#433d86]">
              <SelectValue placeholder="Select pathway" />
            </SelectTrigger>
            <SelectContent>
              {pathways.map((pathway) => (
                <SelectItem key={pathway.id} value={pathway.id}>
                  {pathway.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div>Novelty ↔ Actionability: {noveltyActionability}</div>
          <Slider
            value={[noveltyActionability]}
            onValueChange={(value) => setNoveltyActionability(value[0] ?? 50)}
            min={0}
            max={100}
            step={1}
            disabled={!enabled}
          />
        </div>

        <div className="space-y-2">
          <div>Low safety risk ↔ High novelty tolerance: {riskTolerance}</div>
          <Slider
            value={[riskTolerance]}
            onValueChange={(value) => setRiskTolerance(value[0] ?? 50)}
            min={0}
            max={100}
            step={1}
            disabled={!enabled}
          />
        </div>

        <div className="space-y-2">
          <div>Output</div>
          <Select value={outputCount} onValueChange={(value: "1" | "3") => setOutputCount(value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Recommend 1 target</SelectItem>
              <SelectItem value="3">Recommend 3 targets</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          className="w-full bg-[#5b57e6] text-white hover:bg-[#4a42ce]"
          disabled={!enabled || !pathwayId || loading}
          onClick={runHypothesis}
        >
          {loading ? "Computing hypothesis..." : "Compute hypothesis thread"}
        </Button>

        {result ? (
          <div className="rounded-xl border border-[#ddd9ff] bg-[#f8f7ff] p-3">
            <div className="mb-2 flex flex-wrap gap-1">
              {result.recommendedTargets.map((target) => (
                <Badge key={target.id} className="bg-[#ede9ff] text-[#4a4390]">
                  {target.symbol} ({target.score.toFixed(3)})
                </Badge>
              ))}
            </div>
            <div className="text-sm font-semibold leading-6 text-[#332d75]">
              {result.mechanismThread.claim}
            </div>
            <div className="mt-2 space-y-1">
              {result.mechanismThread.evidenceBullets.map((line, idx) => (
                <div key={`ev-${idx}`} className="text-[11px] leading-5 text-[#5d57a0]">
                  • {line}
                </div>
              ))}
            </div>
            <div className="mt-2 space-y-1">
              {result.mechanismThread.caveats.map((line, idx) => (
                <div key={`cv-${idx}`} className="text-[11px] leading-5 text-[#8f5b2d]">
                  Caveat: {line}
                </div>
              ))}
            </div>
            {result.missingInputs.length > 0 ? (
              <div className="mt-2 rounded-md border border-[#f3d1ab] bg-[#fff7ec] px-2 py-1 text-[11px] text-[#8f5b2d]">
                Missing inputs: {result.missingInputs.join("; ")}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
