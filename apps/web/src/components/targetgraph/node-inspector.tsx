"use client";

import { ExternalLink } from "lucide-react";
import type { GraphEdge, GraphNode } from "@/lib/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type EnrichmentMap = Record<string, { articles: unknown[]; trials: unknown[] }>;

type Props = {
  selectedNode: GraphNode | null;
  edges: GraphEdge[];
  enrichmentByNode: EnrichmentMap;
};

export function NodeInspector({ selectedNode, edges, enrichmentByNode }: Props) {
  if (!selectedNode) {
    return (
      <Card className="h-full border-[#cfe1fb] bg-white/95">
        <CardHeader>
          <CardTitle className="text-sm text-[#163e69]">Node Inspector</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-[#567aa3]">
          Select any node to inspect evidence, links, and local neighborhood.
        </CardContent>
      </Card>
    );
  }

  const incidentEdges = edges.filter(
    (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
  );

  const enrichment = enrichmentByNode[selectedNode.id] ?? { articles: [], trials: [] };

  return (
    <Card className="h-full border-[#cfe1fb] bg-white/95">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm text-[#163e69]">{selectedNode.label}</CardTitle>
          <Badge variant="outline" className="border-[#aac8f2] bg-[#eef5ff] text-[#285684]">
            {selectedNode.type}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-[#d6e4f7] bg-[#f6faff] p-2 text-xs text-[#44688f]">
          <div>ID: {selectedNode.primaryId}</div>
          <div>Score: {(selectedNode.score ?? 0).toFixed(3)}</div>
          <div>Degree: {incidentEdges.length}</div>
        </div>

        <Tabs defaultValue="evidence" className="w-full">
          <TabsList className="grid w-full grid-cols-3 border border-[#d2e3fa] bg-[#f6faff]">
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
            <TabsTrigger value="articles">Articles</TabsTrigger>
            <TabsTrigger value="trials">Trials</TabsTrigger>
          </TabsList>

          <TabsContent value="evidence" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-[#d2e3fa] bg-[#f9fbff] p-2">
              <div className="space-y-2 text-xs text-[#365a84]">
                {Object.entries(selectedNode.meta).length === 0 ? (
                  <div className="text-[#6788ae]">No metadata on this node yet.</div>
                ) : (
                  Object.entries(selectedNode.meta).map(([key, value]) => (
                    <div key={key} className="rounded border border-[#d8e7fb] bg-white p-2">
                      <div className="text-[#5f82a8]">{key}</div>
                      <div className="font-mono text-[11px] text-[#1c4069] break-words">
                        {typeof value === "string" ? value : JSON.stringify(value)}
                      </div>
                    </div>
                  ))
                )}
                <Separator className="bg-[#d7e7fb]" />
                <div className="text-[#5f82a8]">Incident edges</div>
                {incidentEdges.map((edge) => (
                  <div key={edge.id} className="rounded border border-[#d8e7fb] bg-white p-2">
                    <div>{edge.type}</div>
                    <div className="text-[#6f90b4]">{edge.source} → {edge.target}</div>
                    <div className="text-[#8ba7c5]">weight {(edge.weight ?? 0).toFixed(3)}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="articles" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-[#d2e3fa] bg-[#f9fbff] p-2">
              <div className="space-y-2 text-xs text-[#365a84]">
                {(enrichment.articles ?? []).length === 0 ? (
                  <div className="text-[#6788ae]">No article snippets yet.</div>
                ) : (
                  (enrichment.articles as Array<Record<string, unknown>>).map((article, idx) => (
                    <a
                      key={`${article.id ?? idx}`}
                      href={String(article.url ?? "#")}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded border border-[#d8e7fb] bg-white p-2 hover:bg-[#edf4ff]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#1f446f]">
                          {String(article.title ?? "Untitled")}
                        </span>
                        <ExternalLink className="h-3 w-3 text-[#6a8eb6]" />
                      </div>
                      <div className="text-[#6f90b4]">{String(article.source ?? "Unknown")}</div>
                    </a>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="trials" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-[#d2e3fa] bg-[#f9fbff] p-2">
              <div className="space-y-2 text-xs text-[#365a84]">
                {(enrichment.trials ?? []).length === 0 ? (
                  <div className="text-[#6788ae]">No trial snippets yet.</div>
                ) : (
                  (enrichment.trials as Array<Record<string, unknown>>).map((trial, idx) => (
                    <a
                      key={`${trial.id ?? idx}`}
                      href={String(trial.url ?? "#")}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded border border-[#d8e7fb] bg-white p-2 hover:bg-[#edf4ff]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#1f446f]">
                          {String(trial.title ?? "Untitled")}
                        </span>
                        <ExternalLink className="h-3 w-3 text-[#6a8eb6]" />
                      </div>
                      <div className="text-[#6f90b4]">
                        {String(trial.id ?? "")} {trial.status ? `• ${String(trial.status)}` : ""}
                      </div>
                    </a>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
