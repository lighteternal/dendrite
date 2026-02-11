"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { PIPELINE_STEPS } from "@/components/targetgraph/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type StreamStatus = {
  phase: string;
  message: string;
  pct: number;
  elapsedMs: number;
  counts: Record<string, number>;
  sourceHealth: Record<string, "green" | "yellow" | "red">;
  partial?: boolean;
  timeoutMs?: number;
};

type Props = {
  statuses: Record<string, StreamStatus>;
  onContinuePartial: (phase: string) => void;
};

const healthClass: Record<"green" | "yellow" | "red", string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
};

export function BuildStepper({ statuses, onContinuePartial }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const allStatuses = Object.values(statuses);

  const current = useMemo(() => {
    return allStatuses.reduce<StreamStatus | undefined>((best, status) => {
      if (!best) return status;
      return status.pct > best.pct ? status : best;
    }, undefined);
  }, [allStatuses]);

  const overallPct = current?.pct ?? 0;

  const renderStepCards = (compact = false) => (
    <div className={cn("flex gap-2", compact ? "flex-col" : "min-w-max md:grid md:min-w-0 md:grid-cols-7")}>
      {PIPELINE_STEPS.map((step) => {
        const status = statuses[step.id];
        const active = status?.phase === step.id;
        const complete = (status?.pct ?? 0) >= 100 || (current?.pct ?? 0) > (status?.pct ?? 0);

        return (
          <div
            key={step.id}
            className={cn(
              "rounded-xl border border-[#d2e2f8] bg-[#f8fbff] p-2.5",
              compact ? "min-w-0" : "min-w-[220px] md:min-w-0",
              active ? "border-[#7eaaf0] bg-[#eef4ff]" : "",
            )}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#1c446f]">{step.label}</span>
              {active ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2764bd]" />
              ) : complete ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <span className="text-[#6c8ab0]">Idle</span>
              )}
            </div>
            <Progress value={status?.pct ?? 0} className="mt-1.5 h-1.5" />
            <div className="mt-1.5 min-h-[28px] text-[10px] leading-4 text-[#3d638f]">
              {status?.message ?? "pending"}
            </div>
            {status?.counts && Object.keys(status.counts).length > 0 ? (
              <div className="text-[10px] text-[#6789b1]">
                {Object.entries(status.counts)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(" • ")}
              </div>
            ) : null}
            {active && status.timeoutMs && status.elapsedMs > status.timeoutMs ? (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 h-6 w-full border-[#c8daf8] bg-white text-[10px] text-[#2d5c93] hover:bg-[#eef4ff]"
                onClick={() => onContinuePartial(step.id)}
              >
                Continue with partial data
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="sticky top-[68px] z-30 border-b border-[#cfe1fb] bg-white/95 px-3 py-2 backdrop-blur md:px-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge className="rounded-full bg-[#e8f0ff] text-[#214a86]">Build Pipeline</Badge>
            <span className="text-xs text-[#3f638f]">
              {current
                ? `${current.phase} • ${current.message} • ${(current.elapsedMs / 1000).toFixed(1)}s`
                : "Waiting for stream"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#4b6f98]">
            {current &&
              Object.entries(current.sourceHealth).map(([source, health]) => (
                <div key={source} className="inline-flex items-center gap-1 rounded-full border border-[#d3e2f7] bg-[#f6faff] px-2 py-0.5">
                  <span className={cn("h-2 w-2 rounded-full", healthClass[health])} />
                  {source}
                </div>
              ))}
          </div>
        </div>

        <div className="md:hidden">
          <Collapsible open={mobileOpen} onOpenChange={setMobileOpen}>
            <div className="rounded-xl border border-[#d2e2f8] bg-[#f8fbff] p-2.5">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-semibold text-[#1c446f]">Live build progress</span>
                <span className="text-[#587ea9]">{overallPct}%</span>
              </div>
              <Progress value={overallPct} className="h-2" />
              <CollapsibleTrigger asChild>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2 h-7 w-full border-[#c8daf8] bg-white text-[11px] text-[#2d5c93] hover:bg-[#eef4ff]"
                >
                  {mobileOpen ? "Hide step details" : "Show step details"}
                  <ChevronDown className={cn("ml-1 h-3.5 w-3.5 transition", mobileOpen ? "rotate-180" : "")} />
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="pt-2">
              {renderStepCards(true)}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <div className="hidden overflow-x-auto pb-1 md:block">
          {renderStepCards()}
        </div>
      </div>
    </div>
  );
}
