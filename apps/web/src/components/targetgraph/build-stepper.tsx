"use client";

import { Loader2 } from "lucide-react";
import { PIPELINE_STEPS } from "@/components/targetgraph/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const allStatuses = Object.values(statuses);
  const current = allStatuses.sort((a, b) => b.pct - a.pct)[0];

  return (
    <div className="sticky top-14 z-30 border-b border-white/10 bg-[#070b11]/95 px-3 py-2 backdrop-blur md:px-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge className="rounded-sm bg-[#1f2a3a] text-[#d4ebff]">Build Pipeline</Badge>
            <span className="text-xs text-[#9db6ce]">
              {current
                ? `${current.phase} • ${current.message} • ${(current.elapsedMs / 1000).toFixed(1)}s`
                : "Waiting for stream"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {current &&
              Object.entries(current.sourceHealth).map(([source, health]) => (
                <div key={source} className="flex items-center gap-1 text-[10px] text-[#9db6ce]">
                  <span className={cn("h-2 w-2 rounded-full", healthClass[health])} />
                  {source}
                </div>
              ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
          {PIPELINE_STEPS.map((step) => {
            const status = statuses[step.id];
            const active = status?.phase === step.id;
            const complete = (status?.pct ?? 0) >= 100 || (current?.pct ?? 0) > (status?.pct ?? 0);

            return (
              <div
                key={step.id}
                className={cn(
                  "rounded-md border border-white/10 bg-[#0a121e] p-2",
                  active ? "border-cyan-400/60" : "",
                )}
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[#dceeff]">{step.label}</span>
                  {active ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />
                  ) : (
                    <span className="text-[#85a2bf]">{complete ? "Done" : "Idle"}</span>
                  )}
                </div>
                <Progress value={status?.pct ?? 0} className="mt-1 h-1.5" />
                <div className="mt-1 text-[10px] text-[#92acc6]">
                  {status?.message ?? "pending"}
                </div>
                {status?.counts && Object.keys(status.counts).length > 0 ? (
                  <div className="mt-1 text-[10px] text-[#6f8ba6]">
                    {Object.entries(status.counts)
                      .map(([k, v]) => `${k}:${v}`)
                      .join(" • ")}
                  </div>
                ) : null}
                {active && status.timeoutMs && status.elapsedMs > status.timeoutMs ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2 h-6 w-full text-[10px]"
                    onClick={() => onContinuePartial(step.id)}
                  >
                    Continue with partial data
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
