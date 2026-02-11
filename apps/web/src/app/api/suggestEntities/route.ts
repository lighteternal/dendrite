import { NextRequest, NextResponse } from "next/server";
import { resolveSemanticConcepts } from "@/server/entity/semantic-entity-mapper";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();
  if (!query || query.length < 2) {
    return NextResponse.json({ concepts: [] });
  }

  try {
    const concepts = await resolveSemanticConcepts(query);
    return NextResponse.json({
      concepts,
    });
  } catch {
    return NextResponse.json({ concepts: [] });
  }
}
