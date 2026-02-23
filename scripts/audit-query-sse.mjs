import fs from "node:fs/promises";

const base = process.env.BASE_URL || "http://localhost:3100";
const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error("usage: node scripts/audit-query-sse.mjs \"<query>\"");
  process.exit(1);
}

const timeoutMs = Number(process.env.SSE_TIMEOUT_MS || 420000);
const outDir = "/tmp/dendrite-ui-usability";
await fs.mkdir(outDir, { recursive: true });

const safe = query.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 96);
const sessionId = `audit-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const url = `${base}/api/runCaseStream?query=${encodeURIComponent(query)}&mode=multihop&sessionId=${encodeURIComponent(sessionId)}`;
const startedAt = Date.now();

function parseSseBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  const dataParts = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataParts.push(line.slice("data:".length).trim());
    }
  }
  const dataRaw = dataParts.join("\n");
  if (!dataRaw) return null;
  let data;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    data = dataRaw;
  }
  return { event, data };
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

const response = await fetch(url, { signal: controller.signal });
if (!response.ok || !response.body) {
  clearTimeout(timer);
  throw new Error(`request failed: ${response.status}`);
}

const decoder = new TextDecoder();
let buffer = "";

const summary = {
  query,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: null,
  elapsedMs: null,
  timedOut: false,
  errored: false,
  statusPhases: [],
  selectedDisease: null,
  selectedDiseaseRationale: null,
  selectedAnchors: [],
  unresolvedMentions: [],
  leadTarget: null,
  decision: null,
  score: null,
  finalNodeCount: null,
  finalEdgeCount: null,
  graphPatchCount: 0,
  graphDeltaCount: 0,
  pathUpdateCount: 0,
  agentStepCount: 0,
  narrationCount: 0,
  branchUpdateCount: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  answerDeltaCount: 0,
  finalAnswer: null,
  runCompleted: null,
  citationCount: 0,
  llmCost: null,
  llmTopFactors: [],
  eventCounts: {},
  lifecycle: {
    runStarted: false,
    planReady: false,
    runCompleted: false,
    finalAnswer: false,
    done: false,
  },
  runErrors: [],
  warnings: [],
  errors: [],
  finalDonePayload: null,
};

const rawEvents = [];
let shouldStop = false;

try {
  outer: for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!block) continue;
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      rawEvents.push(parsed);

      const { event, data } = parsed;
      summary.eventCounts[event] = (summary.eventCounts[event] ?? 0) + 1;
      if (event === "status" && data && typeof data === "object") {
        const phase = data.phase ?? null;
        const message = data.message ?? null;
        if (phase || message) {
          summary.statusPhases.push({ phase, message, pct: data.pct ?? null });
        }
      }

      if (event === "query_plan" && data && typeof data === "object") {
        summary.selectedAnchors = Array.isArray(data.anchors)
          ? data.anchors.map((item) => ({
              mention: item.mention ?? null,
              entityType: item.entityType ?? null,
              name: item.name ?? null,
              id: item.id ?? null,
            }))
          : [];
        summary.unresolvedMentions = Array.isArray(data.unresolvedMentions)
          ? data.unresolvedMentions.slice(0, 12)
          : [];
      }

      if (event === "resolver_selected" && data && typeof data === "object") {
        summary.selectedDisease = data.selected?.name ?? null;
        summary.selectedDiseaseRationale = data.rationale ?? null;
      }

      if (event === "run_started") summary.lifecycle.runStarted = true;
      if (event === "plan_ready") summary.lifecycle.planReady = true;

      if (event === "graph_patch") summary.graphPatchCount += 1;
      if (event === "graph_delta") summary.graphDeltaCount += 1;
      if (event === "path_update") summary.pathUpdateCount += 1;
      if (event === "agent_step") summary.agentStepCount += 1;
      if (event === "narration_delta") summary.narrationCount += 1;
      if (event === "branch_update") summary.branchUpdateCount += 1;
      if (event === "tool_call") summary.toolCallCount += 1;
      if (event === "tool_result") summary.toolResultCount += 1;
      if (event === "answer_delta") summary.answerDeltaCount += 1;

      if (event === "warning") {
        summary.warnings.push(data);
      }

      if (event === "run_error") {
        summary.runErrors.push(data);
      }

      if (event === "error") {
        summary.errored = true;
        summary.errors.push(data);
      }

      if (event === "citation_bundle" && data?.citations && Array.isArray(data.citations)) {
        summary.citationCount = data.citations.length;
      }

      if (event === "llm_cost" && data && typeof data === "object") {
        summary.llmCost = {
          totalCalls: data.totalCalls ?? 0,
          totals: data.totals ?? null,
          byModel: Array.isArray(data.byModel) ? data.byModel.slice(0, 5) : [],
          byOperation: Array.isArray(data.byOperation) ? data.byOperation.slice(0, 6) : [],
        };
        const topFactors = Array.isArray(data.byOperation) ? data.byOperation : [];
        summary.llmTopFactors = topFactors
          .slice(0, 3)
          .map((item) => ({
            operation: item.key ?? "unknown",
            totalTokens: item.totalTokens ?? 0,
            estimatedCostUsd: item.estimatedCostUsd ?? null,
          }));
      }

      if (event === "final_answer" && data && typeof data === "object") {
        summary.lifecycle.finalAnswer = true;
        summary.finalAnswer = {
          answer: data.answer ?? null,
          focusThread: data.focusThread ?? null,
          keyFindings: Array.isArray(data.keyFindings) ? data.keyFindings.slice(0, 5) : [],
        };
      }

      if (event === "run_completed" && data && typeof data === "object") {
        summary.lifecycle.runCompleted = true;
        summary.runCompleted = data;
        if (data.finalAnswer && typeof data.finalAnswer === "object") {
          summary.finalAnswer = {
            answer: data.finalAnswer.answer ?? null,
            focusThread: data.finalAnswer.focusThread ?? null,
            keyFindings: Array.isArray(data.finalAnswer.keyFindings)
              ? data.finalAnswer.keyFindings.slice(0, 5)
              : [],
          };
        }
      }

      if (event === "brief_section" && data?.section === "final_brief" && data?.data) {
        const recommendation = data.data.recommendation ?? null;
        summary.leadTarget = recommendation?.target ?? null;
        summary.decision = recommendation?.decision ?? null;
        summary.score = recommendation?.score ?? null;
      }

      if (event === "done") {
        summary.lifecycle.done = true;
        summary.finalDonePayload = data;
        if (!summary.llmCost && data?.llmCost && typeof data.llmCost === "object") {
          summary.llmCost = data.llmCost;
        }
        if (data?.stats) {
          summary.finalNodeCount = data.stats.totalNodes ?? null;
          summary.finalEdgeCount = data.stats.totalEdges ?? null;
        } else if (data?.graph) {
          const nodes = Array.isArray(data.graph.nodes) ? data.graph.nodes.length : null;
          const edges = Array.isArray(data.graph.edges) ? data.graph.edges.length : null;
          summary.finalNodeCount = nodes;
          summary.finalEdgeCount = edges;
        } else if (data?.counts) {
          summary.finalNodeCount = data.counts.nodes ?? null;
          summary.finalEdgeCount = data.counts.edges ?? null;
        }
        clearTimeout(timer);
        shouldStop = true;
        break;
      }
    }
    if (shouldStop) break outer;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/done|aborted|abort/i.test(message)) {
    summary.errored = true;
    summary.errors.push({ message });
  }
  if (/timeout/i.test(message)) {
    summary.timedOut = true;
  }
} finally {
  clearTimeout(timer);
}

summary.finishedAt = new Date().toISOString();
summary.elapsedMs = Date.now() - startedAt;

const summaryPath = `${outDir}/sse-audit-${safe}.json`;
const rawPath = `${outDir}/sse-audit-${safe}.events.json`;
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
await fs.writeFile(rawPath, JSON.stringify(rawEvents, null, 2));
console.log(summaryPath);
