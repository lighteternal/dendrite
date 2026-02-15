import { randomUUID } from "node:crypto";

type LogLevel = "info" | "warn" | "error";

export type RequestLogContext = {
  requestId: string;
  route: string;
  startedAt: number;
};

function nowIso() {
  return new Date().toISOString();
}

function compactString(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return compactString(error.message);
  if (typeof error === "string") return compactString(error);
  return "unknown error";
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>) {
  const payload = {
    ts: nowIso(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function startRequestLog(
  route: string,
  fields: Record<string, unknown> = {},
): RequestLogContext {
  const context: RequestLogContext = {
    requestId: randomUUID().slice(0, 8),
    route,
    startedAt: Date.now(),
  };

  emit("info", "request.start", {
    requestId: context.requestId,
    route,
    ...fields,
  });
  return context;
}

export function stepRequestLog(
  context: RequestLogContext,
  event: string,
  fields: Record<string, unknown> = {},
) {
  emit("info", event, {
    requestId: context.requestId,
    route: context.route,
    elapsedMs: Date.now() - context.startedAt,
    ...fields,
  });
}

export function warnRequestLog(
  context: RequestLogContext,
  event: string,
  fields: Record<string, unknown> = {},
) {
  emit("warn", event, {
    requestId: context.requestId,
    route: context.route,
    elapsedMs: Date.now() - context.startedAt,
    ...fields,
  });
}

export function errorRequestLog(
  context: RequestLogContext,
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
) {
  emit("error", event, {
    requestId: context.requestId,
    route: context.route,
    elapsedMs: Date.now() - context.startedAt,
    message: toErrorMessage(error),
    ...fields,
  });
}

export function endRequestLog(
  context: RequestLogContext,
  fields: Record<string, unknown> = {},
) {
  emit("info", "request.end", {
    requestId: context.requestId,
    route: context.route,
    elapsedMs: Date.now() - context.startedAt,
    ...fields,
  });
}
