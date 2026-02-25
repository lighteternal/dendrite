import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const outDir = process.env.DENDRITE_MCP_OUT ?? "/tmp/dendrite-mcp-probe";
await fs.mkdir(outDir, { recursive: true });

const services = [
  {
    key: "opentargets",
    url: process.env.OPENTARGETS_MCP_URL ?? "http://localhost:7010/mcp",
    samples: [
      { name: "search_diseases", args: { query: "obesity", size: 5 } },
      { name: "search_diseases", args: { query: "blood brain barrier", size: 5 } },
      { name: "search_targets", args: { query: "EGFR", size: 5 } },
      { name: "search_drugs", args: { query: "cannabis", size: 5 } },
    ],
  },
  {
    key: "reactome",
    url: process.env.REACTOME_MCP_URL ?? "http://localhost:7020/mcp",
    samples: [
      { name: "find_pathways_by_gene", args: { gene: "IL6", species: "Homo sapiens" } },
      { name: "find_pathways_by_gene", args: { gene: "EGFR", species: "Homo sapiens" } },
    ],
  },
  {
    key: "string",
    url: process.env.STRING_MCP_URL ?? "http://localhost:7030/mcp",
    samples: [
      {
        name: "get_interaction_network",
        args: { protein_ids: ["IL6", "TNF"], species: "9606", add_nodes: 6, required_score: 400 },
      },
    ],
  },
  {
    key: "chembl",
    url: process.env.CHEMBL_MCP_URL ?? "http://localhost:7040/mcp",
    samples: [
      { name: "search_drugs", args: { query: "metformin", limit: 5 } },
      { name: "search_drugs", args: { query: "caffeine", limit: 5 } },
      { name: "search_targets", args: { query: "EGFR", organism: "Homo sapiens", limit: 5 } },
    ],
  },
  {
    key: "pubmed",
    url: process.env.PUBMED_MCP_URL ?? "http://localhost:7050/mcp",
    samples: [
      { name: "search_articles", args: { query: "EGFR blood brain barrier", max_results: 5, sort: "relevance" } },
      { name: "article_searcher", args: { diseases: ["obesity"], genes: ["IL6"], page_size: 5 } },
    ],
  },
  {
    key: "medical",
    url: process.env.MEDICAL_MCP_URL ?? "http://localhost:7060/mcp",
    samples: [
      { name: "search-drugs", args: { query: "metformin", limit: 5 } },
      { name: "search-medical-literature", args: { query: "blood brain barrier EGFR", max_results: 5 } },
      { name: "get-health-statistics", args: { indicator: "Life expectancy", country: "USA", limit: 3 } },
    ],
  },
  {
    key: "biomcp",
    url: process.env.BIOMCP_URL ?? "http://localhost:8000/mcp",
    samples: [
      {
        name: "article_searcher",
        args: { diseases: ["obesity"], genes: ["IL6"], page_size: 5, include_preprints: false },
      },
      { name: "trial_searcher", args: { conditions: ["obesity"], interventions: ["metformin"], page_size: 5 } },
      {
        name: "think",
        args: { thought: "Probe EGFR/BBB mechanistic links.", thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false },
      },
    ],
  },
];

function extractText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item) => item && item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

async function withClient(url, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client(
    { name: "dendrite-mcp-probe", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

const summary = [];

for (const service of services) {
  const payload = {
    key: service.key,
    url: service.url,
    tools: [],
    samples: [],
    errors: [],
  };

  try {
    await withClient(service.url, async (client) => {
      try {
        const toolList = await client.listTools();
        payload.tools = toolList?.tools ?? [];
      } catch (error) {
        payload.errors.push(`listTools failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      for (const sample of service.samples) {
        try {
          const result = await client.callTool(
            { name: sample.name, arguments: sample.args },
            CallToolResultSchema,
          );
          payload.samples.push({
            name: sample.name,
            args: sample.args,
            output: extractText(result),
          });
        } catch (error) {
          payload.samples.push({
            name: sample.name,
            args: sample.args,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  } catch (error) {
    payload.errors.push(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  summary.push({
    key: payload.key,
    url: payload.url,
    toolCount: payload.tools.length,
    sampleCount: payload.samples.length,
    errorCount: payload.errors.length,
  });

  const outPath = path.join(outDir, `${service.key}.json`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`${service.key}: wrote ${outPath}`);
}

const summaryPath = path.join(outDir, "summary.json");
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
console.log(summaryPath);
