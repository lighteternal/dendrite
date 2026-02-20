import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { appConfig } from "@/server/config";

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

export class McpClient {
  private readonly endpoint: string;
  private readonly transportDisabled: boolean;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
    const runningOnVercel = Boolean(process.env.VERCEL);
    const loopbackEndpoint = isLoopbackEndpoint(endpoint);
    this.transportDisabled =
      appConfig.mcpTransportMode === "fallback_only" ||
      (appConfig.mcpTransportMode === "auto" && runningOnVercel && loopbackEndpoint);
  }

  async callToolRaw(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 12_000,
  ): Promise<string> {
    if (this.transportDisabled) {
      throw new Error(`MCP transport disabled for endpoint: ${this.endpoint}`);
    }

    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort(
        new Error(`MCP tool timeout (${toolName}) after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      requestInit: {
        signal: abortController.signal,
      },
    });
    const client = new Client(
      {
        name: "dendrite-web",
        version: "0.1.0",
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      const result = await client.callTool(
        {
          name: toolName,
          arguments: args,
        },
        CallToolResultSchema,
      );

      const content = (result as { content?: Array<{ type: string; text?: string }> })
        .content ?? [];

      return content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
    } catch (error) {
      if (timedOut || abortController.signal.aborted) {
        throw new Error(`MCP tool timeout (${toolName}) after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }

  async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 12_000,
  ): Promise<T> {
    const raw = await this.callToolRaw(toolName, args, timeoutMs);
    return parsePossibleJson<T>(raw);
  }
}

export function parsePossibleJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {} as T;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const objectMatch = trimmed.match(/\{[\s\S]*\}$/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as T;
      } catch {
        // continue
      }
    }

    const arrayMatch = trimmed.match(/\[[\s\S]*\]$/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]) as T;
      } catch {
        // continue
      }
    }

    throw new Error(`Unable to parse MCP JSON payload: ${trimmed.slice(0, 160)}`);
  }
}
