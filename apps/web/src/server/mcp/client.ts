import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export class McpClient {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async callToolRaw(toolName: string, args: Record<string, unknown>): Promise<string> {
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint));
    const client = new Client(
      {
        name: "targetgraph-web",
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
    } finally {
      await client.close();
      await transport.close();
    }
  }

  async callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const raw = await this.callToolRaw(toolName, args);
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
