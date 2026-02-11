import { NextRequest, NextResponse } from "next/server";
import {
  hypothesisRequestSchema,
  hypothesisResponseSchema,
} from "@/lib/contracts";
import { clamp } from "@/lib/graph";
import {
  generateMechanismThread,
  mechanismThreadFallback,
} from "@/server/openai/ranking";
import { appConfig } from "@/server/config";

export const runtime = "nodejs";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function normalizeWeights(noveltyToActionability: number, riskTolerance: number) {
  const actionabilityBias = noveltyToActionability / 100;
  const noveltyBias = 1 - actionabilityBias;
  const riskBias = riskTolerance / 100;

  const weights = {
    openTargetsEvidence: clamp(0.35 - noveltyBias * 0.1),
    drugActionability: clamp(0.2 + actionabilityBias * 0.3),
    networkCentrality: clamp(0.2 + noveltyBias * 0.2),
    literatureSupport: clamp(0.25 - riskBias * 0.15 + (1 - noveltyBias) * 0.1),
  };

  const sum =
    weights.openTargetsEvidence +
    weights.drugActionability +
    weights.networkCentrality +
    weights.literatureSupport;

  return {
    openTargetsEvidence: weights.openTargetsEvidence / sum,
    drugActionability: weights.drugActionability / sum,
    networkCentrality: weights.networkCentrality / sum,
    literatureSupport: weights.literatureSupport / sum,
  };
}

export async function POST(request: NextRequest) {
  const json = await request.json();
  const parsed = hypothesisRequestSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const weights = normalizeWeights(
    input.sliderWeights.noveltyToActionability,
    input.sliderWeights.riskTolerance,
  );

  const pathwayRows = input.graphEvidenceTable.filter((row) =>
    row.pathwayIds.includes(input.pathwayId),
  );

  const scoredTargets = pathwayRows
    .map((row) => {
      const score =
        weights.openTargetsEvidence * row.openTargetsEvidence +
        weights.drugActionability * row.drugActionability +
        weights.networkCentrality * row.networkCentrality +
        weights.literatureSupport * row.literatureSupport;

      return {
        id: row.targetId,
        symbol: row.symbol,
        score,
        scoreBreakdown: {
          openTargetsEvidence: row.openTargetsEvidence,
          drugActionability: row.drugActionability,
          networkCentrality: row.networkCentrality,
          literatureSupport: row.literatureSupport,
        },
      };
    })
    .sort((a, b) => b.score - a.score);

  const missingInputs: string[] = [];
  if (pathwayRows.length === 0) missingInputs.push("No targets linked to selected pathway");
  if (pathwayRows.every((row) => row.literatureSupport <= 0)) {
    missingInputs.push("No literature/trial support provided for selected pathway targets");
  }
  if (pathwayRows.every((row) => row.drugCount <= 0)) {
    missingInputs.push("No drug associations provided for selected pathway targets");
  }
  if (pathwayRows.every((row) => row.interactionCount <= 0)) {
    missingInputs.push("No interaction neighborhood provided for selected pathway targets");
  }

  const payload = {
    diseaseId: input.diseaseId,
    pathwayId: input.pathwayId,
    outputCount: input.outputCount,
    missingInputs,
    scoredTargets,
  };

  const response = await withTimeout(
    generateMechanismThread(payload),
    appConfig.openai.hypothesisTimeoutMs,
  ).catch(() => mechanismThreadFallback(payload));

  return NextResponse.json(hypothesisResponseSchema.parse(response));
}
