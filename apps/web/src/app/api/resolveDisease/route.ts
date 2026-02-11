import { NextRequest, NextResponse } from "next/server";
import { searchDiseases } from "@/server/mcp/opentargets";
import {
  chooseBestDiseaseCandidate,
  type DiseaseCandidate,
} from "@/server/openai/disease-resolver";

export const runtime = "nodejs";

const diseaseIdPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;

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
    const candidates: DiseaseCandidate[] = (await searchDiseases(query, 12))
      .filter((item) => diseaseIdPattern.test(item.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
      }));

    if (candidates.length === 0) {
      return NextResponse.json({
        query,
        selected: null,
        candidates: [],
        rationale: "No disease entity candidates found.",
      });
    }

    const { selected, rationale } = await chooseBestDiseaseCandidate(query, candidates);

    return NextResponse.json({
      query,
      selected,
      candidates,
      rationale,
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
