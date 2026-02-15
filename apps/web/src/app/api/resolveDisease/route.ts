import { NextRequest, NextResponse } from "next/server";
import {
  resolveQueryEntitiesBundle,
} from "@/server/agent/entity-resolution";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();

  if (!query || query.length < 2) {
    return NextResponse.json({
      query: query ?? "",
      selected: null,
      candidates: [],
      rationale: "Type at least 2 characters.",
    });
  }

  try {
    const bundled = await resolveQueryEntitiesBundle(query);
    const candidates = bundled.diseaseCandidates;

    if (candidates.length === 0) {
      return NextResponse.json({
        query,
        selected: null,
        candidates: [],
        rationale: bundled.rationale || "No disease entity candidates found.",
        openAiCalls: bundled.openAiCalls,
      });
    }

    return NextResponse.json({
      query,
      selected: bundled.selectedDisease,
      candidates,
      rationale: bundled.rationale,
      openAiCalls: bundled.openAiCalls,
    });
  } catch {
    return NextResponse.json(
      {
        query,
        selected: null,
        candidates: [],
        rationale: "Disease resolver unavailable.",
      },
      { status: 200 },
    );
  }
}
