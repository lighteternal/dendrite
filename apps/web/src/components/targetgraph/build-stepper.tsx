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
              "rounded-xl border border-[#ddd9ff] bg-[#fefeff] p-2.5",
              compact ? "min-w-0" : "min-w-[220px] md:min-w-0",
              active ? "border-[#afa9ff] bg-[#f4f2ff]" : "",
            )}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#3b347f]">{step.label}</span>
              {active ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#5b57e6]" />
              ) : complete ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <span className="text-[#7a74b6]">Idle</span>
              )}
            </div>
            <Progress value={status?.pct ?? 0} className="mt-1.5 h-1.5" />
            <div className="mt-1.5 min-h-[28px] text-[10px] leading-4 text-[#6b65a9]">
              {status?.message ?? "pending"}
            </div>
            {status?.counts && Object.keys(status.counts).length > 0 ? (
              <div className="text-[10px] text-[#7c76b8]">
                {Object.entries(status.counts)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(" • ")}
              </div>
            ) : null}
            {active && status.timeoutMs && status.elapsedMs > status.timeoutMs ? (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 h-6 w-full border-[#f3d1ab] bg-[#fff7ec] text-[10px] text-[#8f5b2d] hover:bg-[#fff1dd]"
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
    <div className="sticky top-[68px] z-30 border-b border-[#ddd9ff] bg-white/95 px-3 py-2 backdrop-blur md:px-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge className="rounded-full bg-[#f1efff] text-[#4a4390]">Build Pipeline</Badge>
            <span className="text-xs text-[#6b65aa]">
              {current
                ? `${current.phase} • ${current.message} • ${(current.elapsedMs / 1000).toFixed(1)}s`
                : "Waiting for stream"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#716caf]">
            {current &&
              Object.entries(current.sourceHealth).map(([source, health]) => (
                <div key={source} className="inline-flex items-center gap-1 rounded-full border border-[#e4e0ff] bg-[#f9f8ff] px-2 py-0.5">
                  <span className={cn("h-2 w-2 rounded-full", healthClass[health])} />
                  {source}
                </div>
              ))}
          </div>
        </div>

        <div className="md:hidden">
          <Collapsible open={mobileOpen} onOpenChange={setMobileOpen}>
            <div className="rounded-xl border border-[#ddd9ff] bg-[#fefeff] p-2.5">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-semibold text-[#3b347f]">Live build progress</span>
                <span className="text-[#6f69ae]">{overallPct}%</span>
              </div>
              <Progress value={overallPct} className="h-2" />
              <CollapsibleTrigger asChild>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2 h-7 w-full border-[#ddd9ff] bg-white text-[11px] text-[#4a4390] hover:bg-[#f3f0ff]"
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
