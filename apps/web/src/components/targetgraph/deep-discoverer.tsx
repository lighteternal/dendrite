"use client";

import { useMemo, useState } from "react";
import { Bot, Loader2, Sparkles, Telescope, Workflow } from "lucide-react";
import { type DiscoverEntity, useDeepDiscoverStream } from "@/hooks/useDeepDiscoverStream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

type Props = {
  diseaseQuery: string;
  diseaseId: string | null;
  onFocusEntities: (entities: DiscoverEntity[]) => void;
};

const CASE_TEMPLATES = [
  {
    label: "RA Rescue Thread",
    question:
      "For TNF-inhibitor refractory rheumatoid arthritis, identify one pathway -> target -> drug thread with the strongest translational plausibility and explain caveats.",
  },
  {
    label: "NSCLC Resistance",
    question:
      "For NSCLC, map a resistance-aware pathway thread and suggest one tractable target-drug axis that complements EGFR-driven biology.",
  },
  {
    label: "Alzheimer Mechanism",
    question:
      "For Alzheimer's disease, propose one mechanistic thread linking high-evidence targets, pathways, and compounds, then list data gaps before wet-lab follow-up.",
  },
];

const sourceTone: Record<string, string> = {
  agent: "bg-[#ede9ff] text-[#4a4390]",
  opentargets: "bg-[#e8f6ff] text-[#165e8d]",
  reactome: "bg-[#e6fbf7] text-[#0f6c62]",
  chembl: "bg-[#fff4e8] text-[#9a5717]",
  string: "bg-[#efe9ff] text-[#5a3ec2]",
  biomcp: "bg-[#e9fbf0] text-[#146b3f]",
};

export function DeepDiscoverer({ diseaseQuery, diseaseId, onFocusEntities }: Props) {
  const stream = useDeepDiscoverStream();
  const [question, setQuestion] = useState(CASE_TEMPLATES[0]?.question ?? "");

  const totalEntityRefs = useMemo(
    () => stream.entries.reduce((acc, entry) => acc + entry.entities.length, 0),
    [stream.entries],
  );

  return (
    <Card className="border-[#d7d2ff] bg-white/95">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm text-[#342f7b]">Deep Discoverer</CardTitle>
          <Badge className="bg-[#f1efff] text-[#4a4390]">
            <Workflow className="mr-1 h-3.5 w-3.5" />
            LangGraph DeepAgents-style
          </Badge>
        </div>
        <p className="text-xs text-[#6b65aa]">
          Ask a translational question. The agent fans out across MCP tools and streams its
          evidence journey live.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs text-[#5a549c]">
        <div className="flex flex-wrap gap-2">
          {CASE_TEMPLATES.map((template) => (
            <button
              key={template.label}
              type="button"
              className="rounded-full border border-[#ddd9ff] bg-[#f6f4ff] px-3 py-1 text-[11px] text-[#4a4390] hover:bg-[#eee9ff]"
              onClick={() => setQuestion(template.question)}
            >
              {template.label}
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-[#ddd9ff] bg-[#f9f8ff] p-2">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-[#4a4390]">
            <Telescope className="h-3.5 w-3.5" />
            Discovery Question
          </div>
          <textarea
            className="min-h-[90px] w-full resize-y rounded-md border border-[#d8d3ff] bg-white px-2.5 py-2 text-xs text-[#3f387f] outline-none ring-[#5b57e6] placeholder:text-[#7c76b9] focus:ring-2"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask a pathway/target/drug discoverability question."
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              className="bg-[#5b57e6] text-white hover:bg-[#4a42ce]"
              disabled={stream.isRunning || !question.trim()}
              onClick={() =>
                stream.start({
                  diseaseQuery,
                  diseaseId,
                  question,
                })
              }
            >
              {stream.isRunning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running
                </>
              ) : (
                <>
                  <Bot className="h-3.5 w-3.5" /> Run Discoverer
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="border-[#ddd9ff] bg-[#f2efff] text-[#4a4390] hover:bg-[#e8e3ff]"
              disabled={!stream.isRunning}
              onClick={stream.stop}
            >
              Stop
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-[#e0dcff] bg-[#f8f7ff] p-2 text-[11px] text-[#6b65a9]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Status: {stream.status?.message ?? (stream.isRunning ? "running" : "idle")}
            </span>
            {stream.elapsedMs !== null ? (
              <span>{(stream.elapsedMs / 1000).toFixed(1)}s</span>
            ) : null}
          </div>
          <div className="mt-1">
            Journey entries: {stream.entries.length} • Entity references: {totalEntityRefs}
          </div>
          {stream.error ? (
            <div className="mt-1 text-[#9a5717]">Warning: {stream.error}</div>
          ) : null}
        </div>

        <div className="rounded-lg border border-[#ddd9ff] bg-[#fcfbff]">
          <div className="border-b border-[#e9e6ff] px-2.5 py-2 text-[11px] font-semibold text-[#4a4390]">
            Live Journey
          </div>
          <ScrollArea className="h-[260px] px-2.5 py-2">
            <div className="space-y-2">
              {stream.entries.length === 0 ? (
                <div className="text-[11px] text-[#7d78b7]">
                  Start discoverer to stream tool-by-tool evidence traversal.
                </div>
              ) : (
                stream.entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="w-full rounded-md border border-[#e5e1ff] bg-white px-2 py-2 text-left hover:bg-[#f7f5ff]"
                    onClick={() => {
                      if (entry.entities.length > 0) {
                        onFocusEntities(entry.entities);
                      }
                    }}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-[#3f387f]">{entry.title}</span>
                      <Badge className={sourceTone[entry.source] ?? sourceTone.agent}>{entry.source}</Badge>
                    </div>
                    <div className="text-[11px] text-[#6b65a9]">{entry.detail}</div>
                    {entry.entities.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {entry.entities.slice(0, 6).map((entity) => (
                          <span
                            key={`${entry.id}-${entity.type}-${entity.label}`}
                            className="rounded-full border border-[#ddd9ff] bg-[#f4f2ff] px-2 py-0.5 text-[10px] text-[#544d97]"
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

        {stream.final ? (
          <div className="space-y-2 rounded-lg border border-[#ddd9ff] bg-[#f8f7ff] p-2.5">
            <div className="flex items-center gap-1 text-[11px] font-semibold text-[#4a4390]">
              <Sparkles className="h-3.5 w-3.5" /> Agent Readout
            </div>
            <div className="rounded-md border border-[#e4e0ff] bg-white px-2 py-2 text-[11px] text-[#473f89]">
              <div className="font-semibold text-[#3f387f]">{stream.final.biomedicalCase.title}</div>
              <div className="mt-1 text-[#6b65a9]">{stream.final.biomedicalCase.whyAgentic}</div>
            </div>
            <div className="rounded-md border border-[#e4e0ff] bg-white px-2 py-2 text-[11px] text-[#473f89]">
              {stream.final.answer}
            </div>
            <div className="rounded-md border border-[#f3d1ab] bg-[#fff7ec] px-2 py-2 text-[11px] text-[#8f5b2d]">
              Focus thread: {stream.final.focusThread.pathway} {"->"} {stream.final.focusThread.target} {"->"}{" "}
              {stream.final.focusThread.drug}
            </div>
            <div className="space-y-1">
              {stream.final.nextActions.slice(0, 3).map((item, index) => (
                <div key={`${item}-${index}`} className="text-[11px] text-[#5f59a2]">
                  {index + 1}. {item}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
