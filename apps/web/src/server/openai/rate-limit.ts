const DEFAULT_RATE_LIMIT_BACKOFF_MS = 25_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 5_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 90_000;

type HeaderBag = Record<string, unknown> | { get: (key: string) => unknown };

function parseRetryAfterValue(value: unknown, assumeSeconds = false): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return assumeSeconds ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return assumeSeconds ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      const delta = parsed - Date.now();
      return delta > 0 ? delta : null;
    }
  }

  return null;
}

function readHeaderValue(
  headers: HeaderBag | undefined,
  key: string,
): unknown | undefined {
  if (!headers) return undefined;
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(key);
  }
  return (headers as Record<string, unknown>)[key];
}

function resolveRetryAfter(error: unknown): number | null {
  const info = (typeof error === "object" && error
    ? (error as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const response =
    typeof info.response === "object" && info.response
      ? (info.response as Record<string, unknown>)
      : undefined;
  const headers =
    typeof info.headers === "object" && info.headers
      ? (info.headers as Record<string, unknown>)
      : undefined;

  const headerSources = [
    response,
    headers,
  ];

  const headerCandidates: Array<{ key: string; assumeSeconds: boolean }> = [
    { key: "retry-after", assumeSeconds: true },
    { key: "Retry-After", assumeSeconds: true },
    { key: "retry_after", assumeSeconds: true },
    { key: "retry_after_ms", assumeSeconds: false },
    { key: "retry-after-ms", assumeSeconds: false },
    { key: "x-retry-after", assumeSeconds: true },
    { key: "x-retry-after-ms", assumeSeconds: false },
  ];

  for (const headers of headerSources) {
    if (!headers) continue;
    for (const candidate of headerCandidates) {
      const headerValue = readHeaderValue(headers, candidate.key);
      if (headerValue != null) {
        return parseRetryAfterValue(headerValue, candidate.assumeSeconds);
      }
    }
  }

  const fallback =
    info.retryAfterMs ?? info.retry_after_ms ?? info["retry-after-ms"] ?? info["retry_after_ms"];
  if (fallback != null) {
    return parseRetryAfterValue(fallback, false);
  }

  return null;
}

function normalizeMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === "string") return error.toLowerCase();
  if (typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message.toLowerCase();
  }
  return "";
}

function readNumberLike(object: Record<string, unknown> | undefined, key: string): unknown {
  if (!object) return undefined;
  return object[key];
}

export function isOpenAiRateLimitError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const info = error as Record<string, unknown>;
    const response =
      typeof info.response === "object" && info.response
        ? (info.response as Record<string, unknown>)
        : undefined;
    const status = readNumberLike(info, "status") ?? readNumberLike(response, "status");
    if (status === 429) return true;
    const code = readNumberLike(info, "code") ?? readNumberLike(response, "code");
    if (code === 429 || /^429$/.test(String(code))) return true;
  }
  const message = normalizeMessage(error);
  return /429|rate limit|too many requests|quota/i.test(message);
}

export function getOpenAiRateLimitBackoffMs(error: unknown): number {
  const retryAfter = resolveRetryAfter(error);
  const delay =
    retryAfter != null
      ? Math.max(MIN_RATE_LIMIT_BACKOFF_MS, Math.min(retryAfter, MAX_RATE_LIMIT_BACKOFF_MS))
      : DEFAULT_RATE_LIMIT_BACKOFF_MS;
  return delay;
}

let openAiRateLimitedUntilMs = 0;

export function isOpenAiRateLimited(): boolean {
  return Date.now() < openAiRateLimitedUntilMs;
}

export function handleOpenAiRateLimit(error: unknown): void {
  if (!isOpenAiRateLimitError(error)) return;
  const backoff = getOpenAiRateLimitBackoffMs(error);
  openAiRateLimitedUntilMs = Math.max(openAiRateLimitedUntilMs, Date.now() + backoff);
}
