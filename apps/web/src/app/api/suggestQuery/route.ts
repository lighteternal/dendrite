import { NextRequest, NextResponse } from "next/server";
import { suggestQueryCompletions } from "@/server/openai/query-autocomplete";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const prefix = request.nextUrl.searchParams.get("prefix")?.trim() ?? "";
  if (prefix.length < 3) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const suggestions = await suggestQueryCompletions(prefix, 3);
    return NextResponse.json({ suggestions });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}

