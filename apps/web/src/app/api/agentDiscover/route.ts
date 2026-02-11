import { NextRequest } from "next/server";
import {
  runDeepDiscoverer,
  type DiscoverJourneyEntry,
  type DiscovererFinal,
} from "@/server/agent/deep-discoverer";

export const runtime = "nodejs";

const encoder = new TextEncoder();

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const diseaseQuery = searchParams.get("diseaseQuery")?.trim();
  const question = searchParams.get("question")?.trim();
  const diseaseId = searchParams.get("diseaseId")?.trim();

  if (!diseaseQuery || !question) {
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
        emit("status", {
          phase: "A0",
          message: "Initializing agentic discovery workflow",
          elapsedMs: Date.now() - startedAt,
        });

        const final = await runDeepDiscoverer({
          diseaseQuery,
          diseaseIdHint: diseaseId ?? undefined,
          question,
          emitJourney: (entry: DiscoverJourneyEntry) => {
            emit("journey", entry);
          },
        });

        emit("final", final satisfies DiscovererFinal);
        emit("done", {
          elapsedMs: Date.now() - startedAt,
        });
        close();
      };

      run().catch((error) => {
        emit("error", {
          message: error instanceof Error ? error.message : "unknown discoverer error",
        });
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
