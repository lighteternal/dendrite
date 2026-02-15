import { NextRequest, NextResponse } from "next/server";
import {
  endRequestLog,
  startRequestLog,
} from "@/server/telemetry";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();
  const log = startRequestLog("/api/suggestEntities", {
    queryLength: query?.length ?? 0,
    query: query?.slice(0, 140),
  });
  const response = NextResponse.json(
    { query, concepts: [] },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
  endRequestLog(log, { concepts: 0, disabled: true });
  return response;
}
