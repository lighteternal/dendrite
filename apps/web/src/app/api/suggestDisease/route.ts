import { NextRequest, NextResponse } from "next/server";
import { searchDiseases } from "@/server/mcp/opentargets";
import {
  extractDiseaseIntent,
  rankDiseaseCandidatesFast,
  type DiseaseCandidate,
} from "@/server/openai/disease-resolver";

export const runtime = "nodejs";

const diseaseIdPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();
  if (!query || query.length < 2) {
    return NextResponse.json({ results: [] });
  }

  try {
    const intent = extractDiseaseIntent(query);
    const searchQuery = intent.length >= 2 ? intent : query;
    const results = await searchDiseases(searchQuery, 12);
    const candidates: DiseaseCandidate[] = results
      .filter((disease) => diseaseIdPattern.test(disease.id))
      .map((disease) => ({
        id: disease.id,
        name: disease.name,
        description: disease.description,
      }));

    const ranked = await rankDiseaseCandidatesFast(searchQuery, candidates, 8);
    return NextResponse.json({
      results: ranked,
    });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
