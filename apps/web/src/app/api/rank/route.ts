import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rankingResponseSchema } from "@/lib/contracts";
import { rankTargets } from "@/server/openai/ranking";

export const runtime = "nodejs";

const requestSchema = z.object({
  evidenceRows: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      pathwayIds: z.array(z.string()),
      openTargetsEvidence: z.number(),
      drugActionability: z.number(),
      networkCentrality: z.number(),
      literatureSupport: z.number(),
      drugCount: z.number(),
      interactionCount: z.number(),
      articleCount: z.number(),
      trialCount: z.number(),
    }),
  ),
});

export async function POST(request: NextRequest) {
  const json = await request.json();
  const parsed = requestSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ranking = await rankTargets(parsed.data.evidenceRows);
  const output = rankingResponseSchema.parse(ranking);
  return NextResponse.json(output);
}
