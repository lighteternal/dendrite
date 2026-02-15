import { appConfig } from "@/server/config";

type DiscovererModelDecision = {
  model: string;
  tier: "nano" | "mini" | "full";
  reason: string;
};

const BRIDGE_QUERY_PATTERN =
  /\b(connect|connection|between|relationship|overlap|versus|vs|compare|cross[\s-]?disease|mechanistically)\b/i;

const HIGH_DEPTH_PATTERN =
  /\b(multihop|multi[-\s]?hop|pathway|mechanism|mechanistic|due diligence|exhaustive)\b/i;

function tokenize(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function chooseAutocompleteModel(): string {
  return appConfig.openai.nanoModel;
}

export function chooseDiseaseAutocompleteRankingModel(): string {
  return appConfig.openai.nanoModel;
}

export function chooseRankingModel(rowCount: number): string {
  if (rowCount <= 8) return appConfig.openai.nanoModel;
  if (rowCount <= 30) return appConfig.openai.smallModel;
  return appConfig.openai.model;
}

export function chooseMechanismThreadModel(input: {
  scoredTargetsCount: number;
  outputCount: 1 | 3;
}): string {
  if (input.outputCount === 1 && input.scoredTargetsCount <= 10) {
    return appConfig.openai.smallModel;
  }
  return appConfig.openai.model;
}

export function chooseDiscovererModel(input: {
  diseaseQuery: string;
  question: string;
}): DiscovererModelDecision {
  const combined = `${input.question} ${input.diseaseQuery}`.trim();
  const tokens = tokenize(combined);
  const lower = combined.toLowerCase();
  const hasBridgeSignal = BRIDGE_QUERY_PATTERN.test(lower);
  const hasDepthSignal = HIGH_DEPTH_PATTERN.test(lower);
  const hasManyTokens = tokens.length >= 14;
  const hasManyAnchors = /\b(and|or)\b/.test(lower) && tokens.length >= 10;

  const complex = hasBridgeSignal || hasDepthSignal || hasManyTokens || hasManyAnchors;
  if (complex) {
    return {
      model: appConfig.openai.model,
      tier: "full",
      reason: "complex multi-anchor or high-depth query",
    };
  }

  if (tokens.length <= 6) {
    return {
      model: appConfig.openai.smallModel,
      tier: "mini",
      reason: "short single-intent query",
    };
  }

  return {
    model: appConfig.openai.smallModel,
    tier: "mini",
    reason: "default cost-aware routing for non-complex query",
  };
}
