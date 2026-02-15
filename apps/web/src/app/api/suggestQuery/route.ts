import { NextRequest, NextResponse } from "next/server";
import {
  endRequestLog,
  startRequestLog,
} from "@/server/telemetry";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const prefix = request.nextUrl.searchParams.get("prefix")?.trim() ?? "";
  const log = startRequestLog("/api/suggestQuery", {
    prefixLength: prefix.length,
    prefix: prefix.slice(0, 120),
  });
  const response = NextResponse.json(
    { prefix, suggestions: [] },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
  endRequestLog(log, { suggestions: 0, disabled: true });
  return response;
}
