import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";
import { appConfig } from "@/server/config";
import {
  getActiveOpenAiRunId,
  getOpenAiPromptCacheConfig,
  recordChatCompletionsUsage,
  recordResponsesApiUsage,
} from "@/server/openai/cost-tracker";

type ChatCompletionsCreateParams = Parameters<OpenAI["chat"]["completions"]["create"]>[0];
type ResponsesCreateParams = Parameters<OpenAI["responses"]["create"]>[0];

const openAiApiKeyStore = new AsyncLocalStorage<string | undefined>();
const trackedClientCache = new Map<string, OpenAI>();

export function withOpenAiApiKeyContext<T>(
  apiKey: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return openAiApiKeyStore.run(apiKey, fn);
}

export function getOpenAiApiKeyFromContext(): string | undefined {
  return openAiApiKeyStore.getStore() ?? appConfig.openAiApiKey;
}

function applyPromptCachingDefaults<T extends { model?: unknown }>(
  request: T,
  operation: string,
): T {
  const cache = getOpenAiPromptCacheConfig(operation, String(request.model ?? ""));
  if (!cache.prompt_cache_key) return request;

  const base = request as Record<string, unknown>;
  const next: Record<string, unknown> = { ...base };
  if (next.prompt_cache_key == null) {
    next.prompt_cache_key = cache.prompt_cache_key;
  }
  if (
    next.prompt_cache_retention == null &&
    cache.prompt_cache_retention != null
  ) {
    next.prompt_cache_retention = cache.prompt_cache_retention;
  }
  return next as T;
}

export function createTrackedOpenAIClient(
  apiKey: string | undefined = getOpenAiApiKeyFromContext(),
): OpenAI | null {
  if (!apiKey) return null;
  const cached = trackedClientCache.get(apiKey);
  if (cached) return cached;

  const client = new OpenAI({ apiKey });

  const responsesCreate = client.responses.create.bind(client.responses);
  client.responses.create = (async (
    request: ResponsesCreateParams,
    options?: Parameters<OpenAI["responses"]["create"]>[1],
  ) => {
    const runId = getActiveOpenAiRunId() ?? undefined;
    const enriched = applyPromptCachingDefaults(request, "responses.create");
    const response = await responsesCreate(enriched, options);
    recordResponsesApiUsage({
      runId,
      response,
      request: enriched,
      source: "responses.create",
    });
    return response;
  }) as OpenAI["responses"]["create"];

  const chatCompletionsCreate =
    client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = (async (
    request: ChatCompletionsCreateParams,
    options?: Parameters<OpenAI["chat"]["completions"]["create"]>[1],
  ) => {
    const runId = getActiveOpenAiRunId() ?? undefined;
    const enriched = applyPromptCachingDefaults(
      request,
      "chat.completions.create",
    );
    const response = await chatCompletionsCreate(enriched, options);
    recordChatCompletionsUsage({
      runId,
      response,
      request: enriched,
      source: "chat.completions.create",
    });
    return response;
  }) as OpenAI["chat"]["completions"]["create"];

  trackedClientCache.set(apiKey, client);
  return client;
}
