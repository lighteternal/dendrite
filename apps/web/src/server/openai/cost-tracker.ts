import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { appConfig } from "@/server/config";

type OpenAiRunContext = {
  runId: string;
  operation?: string;
};

type ModelPricing = {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cachedInputPer1MUsd?: number;
};

type OpenAiCallRecord = {
  id: string;
  at: string;
  model: string;
  source: string;
  operation: string;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};

type OpenAiRunAccumulator = {
  runId: string;
  query?: string;
  startedAtMs: number;
  updatedAtMs: number;
  calls: OpenAiCallRecord[];
};

type OpenAiUsageInput = {
  runId?: string;
  model?: string;
  source: string;
  operation?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export type OpenAiRollup = {
  key: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  cacheHitRate: number;
};

export type OpenAiRunSummary = {
  runId: string;
  query?: string;
  startedAt: string;
  updatedAt: string;
  totalCalls: number;
  totals: {
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    cacheHitRate: number;
  };
  byModel: OpenAiRollup[];
  byOperation: OpenAiRollup[];
  bySource: OpenAiRollup[];
  topCalls: OpenAiCallRecord[];
};

const contextStore = new AsyncLocalStorage<OpenAiRunContext>();
const runMap = new Map<string, OpenAiRunAccumulator>();
const RUN_TTL_MS = 45 * 60 * 1000;
const MAX_CALLS_PER_RUN = 800;

function nowMs(): number {
  return Date.now();
}

function clampNumber(value: unknown): number {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function cleanKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 84);
}

function activeOperation(fallback: string): string {
  const op = contextStore.getStore()?.operation;
  if (op && op.trim()) return op.trim();
  return fallback;
}

function resolveRunId(explicit?: string): string | null {
  const fromContext = contextStore.getStore()?.runId;
  return explicit ?? fromContext ?? null;
}

function findModelPricing(model: string): ModelPricing | null {
  const table = appConfig.openai.pricingByModel;
  const direct = table[model];
  if (direct) return direct;

  const lowerModel = model.toLowerCase();
  for (const [entryModel, pricing] of Object.entries(table)) {
    const lowerEntry = entryModel.toLowerCase();
    if (
      lowerModel === lowerEntry ||
      lowerModel.startsWith(`${lowerEntry}-`) ||
      lowerEntry.startsWith(`${lowerModel}-`)
    ) {
      return pricing;
    }
  }

  return null;
}

function estimateCostUsd(input: {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number | null {
  const pricing = findModelPricing(input.model);
  if (!pricing) return null;
  const uncachedInput = Math.max(0, input.inputTokens - input.cachedInputTokens);
  const cachedInputRate =
    pricing.cachedInputPer1MUsd != null
      ? pricing.cachedInputPer1MUsd
      : pricing.inputPer1MUsd;
  const cost =
    uncachedInput * (pricing.inputPer1MUsd / 1_000_000) +
    input.cachedInputTokens * (cachedInputRate / 1_000_000) +
    input.outputTokens * (pricing.outputPer1MUsd / 1_000_000);
  return Number(cost.toFixed(8));
}

function pruneStaleRuns(): void {
  const cutoff = nowMs() - RUN_TTL_MS;
  for (const [runId, run] of runMap.entries()) {
    if (run.updatedAtMs < cutoff) {
      runMap.delete(runId);
    }
  }
}

function upsertRun(runId: string, query?: string): OpenAiRunAccumulator {
  const existing = runMap.get(runId);
  if (existing) {
    if (query && !existing.query) {
      existing.query = query;
    }
    existing.updatedAtMs = nowMs();
    return existing;
  }
  const created: OpenAiRunAccumulator = {
    runId,
    query,
    startedAtMs: nowMs(),
    updatedAtMs: nowMs(),
    calls: [],
  };
  runMap.set(runId, created);
  return created;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function sumCosts(values: Array<number | null>): number | null {
  let any = false;
  let total = 0;
  for (const value of values) {
    if (typeof value !== "number") continue;
    any = true;
    total += value;
  }
  return any ? Number(total.toFixed(8)) : null;
}

function aggregate(
  calls: OpenAiCallRecord[],
  keyBy: (call: OpenAiCallRecord) => string,
): OpenAiRollup[] {
  const groups = new Map<string, OpenAiCallRecord[]>();
  for (const call of calls) {
    const key = keyBy(call);
    const current = groups.get(key) ?? [];
    current.push(call);
    groups.set(key, current);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const inputTokens = group.reduce((acc, item) => acc + item.inputTokens, 0);
      const cachedInputTokens = group.reduce((acc, item) => acc + item.cachedInputTokens, 0);
      const uncachedInputTokens = group.reduce((acc, item) => acc + item.uncachedInputTokens, 0);
      const outputTokens = group.reduce((acc, item) => acc + item.outputTokens, 0);
      const reasoningTokens = group.reduce((acc, item) => acc + item.reasoningTokens, 0);
      const totalTokens = group.reduce((acc, item) => acc + item.totalTokens, 0);
      const cacheHitRate =
        inputTokens > 0
          ? Number((cachedInputTokens / inputTokens).toFixed(4))
          : 0;
      return {
        key,
        calls: group.length,
        inputTokens,
        cachedInputTokens,
        uncachedInputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        estimatedCostUsd: sumCosts(group.map((item) => item.estimatedCostUsd)),
        cacheHitRate,
      };
    })
    .sort((a, b) => {
      const costA = a.estimatedCostUsd ?? 0;
      const costB = b.estimatedCostUsd ?? 0;
      if (costB !== costA) return costB - costA;
      return b.totalTokens - a.totalTokens;
    });
}

function summarizeRun(run: OpenAiRunAccumulator): OpenAiRunSummary {
  const calls = [...run.calls];
  const inputTokens = calls.reduce((acc, item) => acc + item.inputTokens, 0);
  const cachedInputTokens = calls.reduce((acc, item) => acc + item.cachedInputTokens, 0);
  const uncachedInputTokens = calls.reduce((acc, item) => acc + item.uncachedInputTokens, 0);
  const outputTokens = calls.reduce((acc, item) => acc + item.outputTokens, 0);
  const reasoningTokens = calls.reduce((acc, item) => acc + item.reasoningTokens, 0);
  const totalTokens = calls.reduce((acc, item) => acc + item.totalTokens, 0);
  const estimatedCostUsd = sumCosts(calls.map((item) => item.estimatedCostUsd));
  const cacheHitRate =
    inputTokens > 0
      ? Number((cachedInputTokens / inputTokens).toFixed(4))
      : 0;

  const topCalls = [...calls]
    .sort((a, b) => {
      const costA = a.estimatedCostUsd ?? 0;
      const costB = b.estimatedCostUsd ?? 0;
      if (costB !== costA) return costB - costA;
      return b.totalTokens - a.totalTokens;
    })
    .slice(0, 10);

  return {
    runId: run.runId,
    query: run.query,
    startedAt: toIso(run.startedAtMs),
    updatedAt: toIso(run.updatedAtMs),
    totalCalls: calls.length,
    totals: {
      inputTokens,
      cachedInputTokens,
      uncachedInputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      estimatedCostUsd,
      cacheHitRate,
    },
    byModel: aggregate(calls, (item) => item.model),
    byOperation: aggregate(calls, (item) => item.operation),
    bySource: aggregate(calls, (item) => item.source),
    topCalls,
  };
}

export function beginOpenAiRun(runId: string, query?: string): void {
  pruneStaleRuns();
  upsertRun(runId, query);
}

export function clearOpenAiRun(runId: string): void {
  runMap.delete(runId);
}

export function getOpenAiRunSummary(runId: string): OpenAiRunSummary | null {
  const run = runMap.get(runId);
  if (!run) return null;
  run.updatedAtMs = nowMs();
  return summarizeRun(run);
}

export function withOpenAiRunContext<T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStore.run({ runId }, fn);
}

export function getActiveOpenAiRunId(): string | null {
  return contextStore.getStore()?.runId ?? null;
}

export function withOpenAiOperationContext<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = contextStore.getStore();
  if (!current) return fn();
  return contextStore.run({ ...current, operation }, fn);
}

export function getOpenAiPromptCacheConfig(operation: string, model?: string): {
  prompt_cache_key?: string;
  prompt_cache_retention?: "in-memory" | "24h";
} {
  if (!appConfig.openai.promptCachingEnabled) return {};

  const prefix = cleanKey(appConfig.openai.promptCacheKeyPrefix || "targetgraph");
  const op = cleanKey(operation || "generic");
  const modelPart = model ? cleanKey(model) : "model";
  const key = `${prefix}:${op}:${modelPart}`.slice(0, 180);
  return {
    prompt_cache_key: key,
    prompt_cache_retention: appConfig.openai.promptCacheRetention ?? undefined,
  };
}

export function getLangChainPromptCacheConfig(
  operation: string,
  model?: string,
): {
  promptCacheKey?: string;
  promptCacheRetention?: "in-memory" | "24h";
} {
  const base = getOpenAiPromptCacheConfig(operation, model);
  return {
    promptCacheKey: base.prompt_cache_key,
    promptCacheRetention: base.prompt_cache_retention,
  };
}

export function recordOpenAiUsage(input: OpenAiUsageInput): void {
  const runId = resolveRunId(input.runId);
  if (!runId) return;

  const run = upsertRun(runId);
  const model = (input.model ?? "unknown-model").trim() || "unknown-model";
  const source = input.source.trim() || "unknown-source";
  const operation = activeOperation(input.operation ?? source);
  const inputTokens = clampNumber(input.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, clampNumber(input.cachedInputTokens));
  const outputTokens = clampNumber(input.outputTokens);
  const totalTokensRaw = clampNumber(input.totalTokens);
  const totalTokens =
    totalTokensRaw > 0 ? totalTokensRaw : inputTokens + outputTokens;
  const reasoningTokens = clampNumber(input.reasoningTokens);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const estimatedCostUsd = estimateCostUsd({
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  });

  const record: OpenAiCallRecord = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    model,
    source,
    operation,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    estimatedCostUsd,
  };

  run.calls.push(record);
  if (run.calls.length > MAX_CALLS_PER_RUN) {
    run.calls.splice(0, run.calls.length - MAX_CALLS_PER_RUN);
  }
  run.updatedAtMs = nowMs();
}

export function recordResponsesApiUsage(input: {
  response: unknown;
  request?: { model?: unknown };
  source?: string;
  operation?: string;
  runId?: string;
}): void {
  const payload = input.response as {
    model?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown };
      output_tokens_details?: { reasoning_tokens?: unknown };
    };
  };
  const usage = payload.usage;
  if (!usage) return;
  recordOpenAiUsage({
    runId: input.runId,
    model: String(payload.model ?? input.request?.model ?? "unknown-model"),
    source: input.source ?? "responses.create",
    operation: input.operation,
    inputTokens: optionalNumber(usage.input_tokens),
    cachedInputTokens: optionalNumber(usage.input_tokens_details?.cached_tokens),
    outputTokens: optionalNumber(usage.output_tokens),
    totalTokens: optionalNumber(usage.total_tokens),
    reasoningTokens: optionalNumber(usage.output_tokens_details?.reasoning_tokens),
  });
}

export function recordChatCompletionsUsage(input: {
  response: unknown;
  request?: { model?: unknown };
  source?: string;
  operation?: string;
  runId?: string;
}): void {
  const payload = input.response as {
    model?: unknown;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      prompt_tokens_details?: { cached_tokens?: unknown };
      completion_tokens_details?: { reasoning_tokens?: unknown };
    };
  };
  const usage = payload.usage;
  if (!usage) return;
  recordOpenAiUsage({
    runId: input.runId,
    model: String(payload.model ?? input.request?.model ?? "unknown-model"),
    source: input.source ?? "chat.completions.create",
    operation: input.operation,
    inputTokens: optionalNumber(usage.prompt_tokens),
    cachedInputTokens: optionalNumber(usage.prompt_tokens_details?.cached_tokens),
    outputTokens: optionalNumber(usage.completion_tokens),
    totalTokens: optionalNumber(usage.total_tokens),
    reasoningTokens: optionalNumber(usage.completion_tokens_details?.reasoning_tokens),
  });
}

function recordFromLangChainOutput(
  output: LLMResult,
  source: string,
  operation?: string,
  runId?: string,
): void {
  let recorded = false;

  for (const generationRow of output.generations ?? []) {
    for (const generation of generationRow ?? []) {
      const maybeMessage = generation as {
        message?: {
          response_metadata?: {
            model_name?: unknown;
            model?: unknown;
            tokenUsage?: {
              promptTokens?: unknown;
              prompt_tokens?: unknown;
              completionTokens?: unknown;
              completion_tokens?: unknown;
              totalTokens?: unknown;
              total_tokens?: unknown;
              promptTokensDetails?: { cachedTokens?: unknown; cached_tokens?: unknown };
              completionTokensDetails?: { reasoningTokens?: unknown; reasoning_tokens?: unknown };
            };
          };
          usage_metadata?: {
            input_tokens?: unknown;
            output_tokens?: unknown;
            total_tokens?: unknown;
            input_token_details?: { cache_read?: unknown; cached_tokens?: unknown };
            output_token_details?: { reasoning?: unknown; reasoning_tokens?: unknown };
          };
        };
      };
      const message = maybeMessage.message;
      const usage = message?.usage_metadata;
      const tokenUsage = message?.response_metadata?.tokenUsage;
      const modelName = String(
        message?.response_metadata?.model_name ??
          message?.response_metadata?.model ??
          "unknown-model",
      );
      if (usage) {
        recordOpenAiUsage({
          runId,
          model: modelName,
          source,
          operation,
          inputTokens: optionalNumber(usage.input_tokens),
          cachedInputTokens: optionalNumber(
            usage.input_token_details?.cache_read ??
              usage.input_token_details?.cached_tokens,
          ),
          outputTokens: optionalNumber(usage.output_tokens),
          totalTokens: optionalNumber(usage.total_tokens),
          reasoningTokens: optionalNumber(
            usage.output_token_details?.reasoning ??
              usage.output_token_details?.reasoning_tokens,
          ),
        });
        recorded = true;
        continue;
      }
      if (tokenUsage) {
        recordOpenAiUsage({
          runId,
          model: modelName,
          source,
          operation,
          inputTokens: optionalNumber(
            tokenUsage.promptTokens ?? tokenUsage.prompt_tokens,
          ),
          cachedInputTokens: optionalNumber(
            tokenUsage.promptTokensDetails?.cachedTokens ??
              tokenUsage.promptTokensDetails?.cached_tokens,
          ),
          outputTokens: optionalNumber(
            tokenUsage.completionTokens ?? tokenUsage.completion_tokens,
          ),
          totalTokens: optionalNumber(
            tokenUsage.totalTokens ?? tokenUsage.total_tokens,
          ),
          reasoningTokens: optionalNumber(
            tokenUsage.completionTokensDetails?.reasoningTokens ??
              tokenUsage.completionTokensDetails?.reasoning_tokens,
          ),
        });
        recorded = true;
      }
    }
  }

  if (recorded) return;

  const llmOutput = (output.llmOutput ?? {}) as {
    model?: unknown;
    tokenUsage?: {
      promptTokens?: unknown;
      prompt_tokens?: unknown;
      completionTokens?: unknown;
      completion_tokens?: unknown;
      totalTokens?: unknown;
      total_tokens?: unknown;
      promptTokensDetails?: { cachedTokens?: unknown; cached_tokens?: unknown };
      completionTokensDetails?: { reasoningTokens?: unknown; reasoning_tokens?: unknown };
    };
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      prompt_tokens_details?: { cached_tokens?: unknown };
      completion_tokens_details?: { reasoning_tokens?: unknown };
    };
  };
  const tokenUsage = llmOutput.tokenUsage ?? llmOutput.usage;
  if (!tokenUsage) return;
  recordOpenAiUsage({
    runId,
    model: String(llmOutput.model ?? "unknown-model"),
    source,
    operation,
    inputTokens: optionalNumber(
      (tokenUsage as { promptTokens?: unknown }).promptTokens ??
        (tokenUsage as { prompt_tokens?: unknown }).prompt_tokens,
    ),
    cachedInputTokens: optionalNumber(
      (tokenUsage as {
        promptTokensDetails?: { cachedTokens?: unknown; cached_tokens?: unknown };
      }).promptTokensDetails?.cachedTokens ??
        (tokenUsage as {
          promptTokensDetails?: { cachedTokens?: unknown; cached_tokens?: unknown };
        }).promptTokensDetails?.cached_tokens ??
        (tokenUsage as { prompt_tokens_details?: { cached_tokens?: unknown } })
          .prompt_tokens_details?.cached_tokens,
    ),
    outputTokens: optionalNumber(
      (tokenUsage as { completionTokens?: unknown }).completionTokens ??
        (tokenUsage as { completion_tokens?: unknown }).completion_tokens,
    ),
    totalTokens: optionalNumber(
      (tokenUsage as { totalTokens?: unknown }).totalTokens ??
        (tokenUsage as { total_tokens?: unknown }).total_tokens,
    ),
    reasoningTokens: optionalNumber(
      (tokenUsage as {
        completionTokensDetails?: { reasoningTokens?: unknown; reasoning_tokens?: unknown };
      }).completionTokensDetails?.reasoningTokens ??
        (tokenUsage as {
          completionTokensDetails?: { reasoningTokens?: unknown; reasoning_tokens?: unknown };
        }).completionTokensDetails?.reasoning_tokens ??
        (tokenUsage as { completion_tokens_details?: { reasoning_tokens?: unknown } })
          .completion_tokens_details?.reasoning_tokens,
    ),
  });
}

export function createLangChainUsageCallback(input: {
  source: string;
  operation?: string;
  runId?: string;
}): BaseCallbackHandler {
  const runId = resolveRunId(input.runId) ?? undefined;
  return BaseCallbackHandler.fromMethods({
    async handleLLMEnd(output) {
      recordFromLangChainOutput(
        output as LLMResult,
        input.source,
        input.operation,
        runId,
      );
    },
  });
}
