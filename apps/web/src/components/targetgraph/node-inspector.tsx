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
      <Card className="h-full border-[#d7d2ff] bg-white/95">
        <CardHeader>
          <CardTitle className="text-sm text-[#342f7b]">Node Inspector</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-[#6b65aa]">
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
    <Card className="h-full border-[#d7d2ff] bg-white/95">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm text-[#342f7b]">{selectedNode.label}</CardTitle>
          <Badge variant="outline" className="border-[#ddd9ff] bg-[#f3f1ff] text-[#4a4390]">
            {selectedNode.type}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-[#e0dcff] bg-[#f8f7ff] p-2 text-xs text-[#5f59a2]">
          <div>ID: {selectedNode.primaryId}</div>
          <div>Score: {(selectedNode.score ?? 0).toFixed(3)}</div>
          <div>Degree: {incidentEdges.length}</div>
        </div>

        <Tabs defaultValue="evidence" className="w-full">
          <TabsList className="grid w-full grid-cols-3 border border-[#ddd9ff] bg-[#f8f7ff]">
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
            <TabsTrigger value="articles">Articles</TabsTrigger>
            <TabsTrigger value="trials">Trials</TabsTrigger>
          </TabsList>

          <TabsContent value="evidence" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-[#ddd9ff] bg-[#fcfbff] p-2">
              <div className="space-y-2 text-xs text-[#595399]">
                {Object.entries(selectedNode.meta).length === 0 ? (
                  <div className="text-[#7b75b7]">No metadata on this node yet.</div>
                ) : (
                  Object.entries(selectedNode.meta).map(([key, value]) => (
                    <div key={key} className="rounded border border-[#e4e0ff] bg-white p-2">
                      <div className="text-[#7d78b8]">{key}</div>
                      <div className="font-mono text-[11px] text-[#3f397f] break-words">
                        {typeof value === "string" ? value : JSON.stringify(value)}
                      </div>
                    </div>
                  ))
                )}
                <Separator className="bg-[#e4e0ff]" />
                <div className="text-[#7d78b8]">Incident edges</div>
                {incidentEdges.map((edge) => (
                  <div key={edge.id} className="rounded border border-[#e4e0ff] bg-white p-2">
                    <div>{edge.type}</div>
                    <div className="text-[#6b65a8]">{edge.source} → {edge.target}</div>
                    <div className="text-[#8d87c2]">weight {(edge.weight ?? 0).toFixed(3)}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="articles" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-[#ddd9ff] bg-[#fcfbff] p-2">
              <div className="space-y-2 text-xs text-[#595399]">
                {(enrichment.articles ?? []).length === 0 ? (
                  <div className="text-[#7b75b7]">No article snippets yet.</div>
                ) : (
                  (enrichment.articles as Array<Record<string, unknown>>).map((article, idx) => (
                    <a
                      key={`${article.id ?? idx}`}
                      href={String(article.url ?? "#")}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded border border-[#e4e0ff] bg-white p-2 hover:bg-[#f5f2ff]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#3f397f]">
                          {String(article.title ?? "Untitled")}
                        </span>
                        <ExternalLink className="h-3 w-3 text-[#8d87c2]" />
                      </div>
                      <div className="text-[#6b65a8]">{String(article.source ?? "Unknown")}</div>
                    </a>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="trials" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-[#ddd9ff] bg-[#fcfbff] p-2">
              <div className="space-y-2 text-xs text-[#595399]">
                {(enrichment.trials ?? []).length === 0 ? (
                  <div className="text-[#7b75b7]">No trial snippets yet.</div>
                ) : (
                  (enrichment.trials as Array<Record<string, unknown>>).map((trial, idx) => (
                    <a
                      key={`${trial.id ?? idx}`}
                      href={String(trial.url ?? "#")}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded border border-[#e4e0ff] bg-white p-2 hover:bg-[#f5f2ff]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#3f397f]">
                          {String(trial.title ?? "Untitled")}
                        </span>
                        <ExternalLink className="h-3 w-3 text-[#8d87c2]" />
                      </div>
                      <div className="text-[#6b65a8]">
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
