import { NextRequest, NextResponse } from "next/server";
import { searchDiseases } from "@/server/mcp/opentargets";

export const runtime = "nodejs";

const diseaseIdPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();
  if (!query || query.length < 2) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await searchDiseases(query, 8);
    return NextResponse.json({
      results: results
        .filter((disease) => diseaseIdPattern.test(disease.id))
        .map((disease) => ({
          id: disease.id,
          name: disease.name,
          description: disease.description,
        })),
    });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
