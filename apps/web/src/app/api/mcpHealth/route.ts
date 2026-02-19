import { NextRequest } from "next/server";
import { getMcpHealthSnapshot } from "@/server/mcp/health";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const refresh =
    request.nextUrl.searchParams.get("refresh")?.trim().toLowerCase() === "1";
  const snapshot = await getMcpHealthSnapshot({ forceRefresh: refresh });
  return Response.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
