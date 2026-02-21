import { NextRequest } from "next/server";
import {
  runDeepDiscoverer,
  type DiscoverJourneyEntry,
  type DiscovererFinal,
} from "@/server/agent/deep-discoverer";
import {
  endRequestLog,
  errorRequestLog,
  startRequestLog,
  stepRequestLog,
  warnRequestLog,
} from "@/server/telemetry";

export const runtime = "nodejs";
export const maxDuration = 300;

const encoder = new TextEncoder();

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const diseaseQuery = searchParams.get("diseaseQuery")?.trim();
  const question = searchParams.get("question")?.trim();
  const diseaseId = searchParams.get("diseaseId")?.trim();
  const log = startRequestLog("/api/agentDiscover", {
    diseaseQuery: diseaseQuery?.slice(0, 120),
    questionLength: question?.length ?? 0,
    hasDiseaseIdHint: Boolean(diseaseId),
  });

  if (!diseaseQuery || !question) {
    endRequestLog(log, { rejected: true, reason: "missing_disease_or_question" });
    return new Response("Missing diseaseQuery or question", { status: 400 });
  }

  const streamState = { closed: false };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const startedAt = Date.now();

      const emit = (event: string, data: unknown) => {
        if (streamState.closed) return;
        try {
          controller.enqueue(encodeEvent(event, data));
        } catch {
          streamState.closed = true;
        }
      };

      const close = () => {
        if (streamState.closed) return;
        streamState.closed = true;
        try {
          controller.close();
        } catch {
          // noop
        }
      };

      const run = async () => {
        const heartbeat = setInterval(() => {
          emit("status", {
            phase: "A1",
            message: "I am investigating the evidence graph and testing branch hypotheses",
            elapsedMs: Date.now() - startedAt,
          });
        }, 2500);

        emit("status", {
          phase: "A0",
          message: "I am initializing the multi-agent discovery workflow",
          elapsedMs: Date.now() - startedAt,
        });

        try {
          const final = await runDeepDiscoverer({
            diseaseQuery,
            diseaseIdHint: diseaseId ?? undefined,
            question,
            emitJourney: (entry: DiscoverJourneyEntry) => {
              emit("journey", entry);
              if (entry.kind === "tool_start") {
                emit("subagent_start", {
                  title: entry.title,
                  detail: entry.detail,
                  source: entry.source,
                  entities: entry.entities,
                });
              } else if (entry.kind === "handoff") {
                emit("subagent_result", {
                  title: entry.title,
                  detail: entry.detail,
                  source: entry.source,
                  pathState: entry.pathState,
                  entities: entry.entities,
                });
              } else if (entry.kind === "followup") {
                emit("followup_question_spawned", {
                  title: entry.title,
                  detail: entry.detail,
                  source: entry.source,
                  pathState: entry.pathState,
                });
              } else if (entry.kind === "branch") {
                emit("branch_update", {
                  title: entry.title,
                  detail: entry.detail,
                  source: entry.source,
                  pathState: entry.pathState,
                  entities: entry.entities,
                });
              }
              if (entry.kind === "warning") {
                warnRequestLog(log, "agent_discover.journey_warning", {
                  title: entry.title,
                  source: entry.source,
                  pathState: entry.pathState,
                });
              }
            },
          });

          emit("final", final satisfies DiscovererFinal);
          stepRequestLog(log, "agent_discover.final", {
            focusTarget: final.focusThread.target,
            focusPathway: final.focusThread.pathway,
            focusDrug: final.focusThread.drug,
            caveatCount: final.caveats.length,
          });
          emit("done", {
            elapsedMs: Date.now() - startedAt,
          });
          endRequestLog(log, { completed: true, elapsedMs: Date.now() - startedAt });
          close();
        } finally {
          clearInterval(heartbeat);
        }
      };

      run().catch((error) => {
        emit("error", {
          message: error instanceof Error ? error.message : "unknown discoverer error",
        });
        errorRequestLog(log, "agent_discover.fatal", error);
        endRequestLog(log, { completed: false });
        close();
      });
    },
    cancel() {
      streamState.closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
