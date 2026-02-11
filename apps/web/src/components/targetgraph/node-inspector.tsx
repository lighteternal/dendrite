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
      <Card className="h-full border-white/10 bg-[#0d1521]">
        <CardHeader>
          <CardTitle className="text-sm text-[#dceeff]">Node Inspector</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-[#8da8c4]">
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
    <Card className="h-full border-white/10 bg-[#0d1521]">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm text-[#dceeff]">{selectedNode.label}</CardTitle>
          <Badge variant="outline" className="border-cyan-400/30 text-cyan-200">
            {selectedNode.type}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md bg-[#121f31] p-2 text-xs text-[#9db6ce]">
          <div>ID: {selectedNode.primaryId}</div>
          <div>Score: {(selectedNode.score ?? 0).toFixed(3)}</div>
          <div>Degree: {incidentEdges.length}</div>
        </div>

        <Tabs defaultValue="evidence" className="w-full">
          <TabsList className="grid w-full grid-cols-3 bg-[#131e2f]">
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
            <TabsTrigger value="articles">Articles</TabsTrigger>
            <TabsTrigger value="trials">Trials</TabsTrigger>
          </TabsList>

          <TabsContent value="evidence" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-white/10 bg-[#111c2b] p-2">
              <div className="space-y-2 text-xs text-[#bdd2e8]">
                {Object.entries(selectedNode.meta).length === 0 ? (
                  <div className="text-[#7791ad]">No metadata on this node yet.</div>
                ) : (
                  Object.entries(selectedNode.meta).map(([key, value]) => (
                    <div key={key} className="rounded bg-[#16253a] p-2">
                      <div className="text-[#88a6c3]">{key}</div>
                      <div className="font-mono text-[11px] text-[#e5f2ff] break-words">
                        {typeof value === "string" ? value : JSON.stringify(value)}
                      </div>
                    </div>
                  ))
                )}
                <Separator className="bg-white/10" />
                <div className="text-[#88a6c3]">Incident edges</div>
                {incidentEdges.map((edge) => (
                  <div key={edge.id} className="rounded bg-[#16253a] p-2">
                    <div>{edge.type}</div>
                    <div className="text-[#9ab7d2]">{edge.source} → {edge.target}</div>
                    <div className="text-[#7f9ab4]">weight {(edge.weight ?? 0).toFixed(3)}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="articles" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-white/10 bg-[#111c2b] p-2">
              <div className="space-y-2 text-xs text-[#bdd2e8]">
                {(enrichment.articles ?? []).length === 0 ? (
                  <div className="text-[#7791ad]">No article snippets yet.</div>
                ) : (
                  (enrichment.articles as Array<Record<string, unknown>>).map((article, idx) => (
                    <a
                      key={`${article.id ?? idx}`}
                      href={String(article.url ?? "#")}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded bg-[#16253a] p-2 hover:bg-[#1b2f48]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#e5f2ff]">
                          {String(article.title ?? "Untitled")}
                        </span>
                        <ExternalLink className="h-3 w-3 text-[#8aa6c3]" />
                      </div>
                      <div className="text-[#7f9ab4]">{String(article.source ?? "Unknown")}</div>
                    </a>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="trials" className="mt-2">
            <ScrollArea className="h-[320px] rounded-md border border-white/10 bg-[#111c2b] p-2">
              <div className="space-y-2 text-xs text-[#bdd2e8]">
                {(enrichment.trials ?? []).length === 0 ? (
                  <div className="text-[#7791ad]">No trial snippets yet.</div>
                ) : (
                  (enrichment.trials as Array<Record<string, unknown>>).map((trial, idx) => (
                    <a
                      key={`${trial.id ?? idx}`}
                      href={String(trial.url ?? "#")}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded bg-[#16253a] p-2 hover:bg-[#1b2f48]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#e5f2ff]">
                          {String(trial.title ?? "Untitled")}
                        </span>
                        <ExternalLink className="h-3 w-3 text-[#8aa6c3]" />
                      </div>
                      <div className="text-[#7f9ab4]">
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
