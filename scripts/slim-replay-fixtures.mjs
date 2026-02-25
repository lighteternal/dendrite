import fs from "node:fs/promises";
import path from "node:path";

const inputDir = process.env.REPLAY_INPUT_DIR ?? "apps/web/src/server/replay/fixtures";
const outputDir = process.env.REPLAY_OUTPUT_DIR ?? "apps/web/public/replays";
const includePrefix = process.env.REPLAY_PREFIX ?? "example-";
const maxGraphPatches = Number(process.env.REPLAY_MAX_GRAPH_PATCHES ?? 18);
const maxNarration = Number(process.env.REPLAY_MAX_NARRATION ?? 40);
const maxBranch = Number(process.env.REPLAY_MAX_BRANCH ?? 40);
const maxToolCall = Number(process.env.REPLAY_MAX_TOOL_CALL ?? 24);
const maxToolResult = Number(process.env.REPLAY_MAX_TOOL_RESULT ?? 24);
const maxAgentStep = Number(process.env.REPLAY_MAX_AGENT_STEP ?? 40);
const maxDetailChars = Number(process.env.REPLAY_MAX_DETAIL_CHARS ?? 320);
const maxTitleChars = Number(process.env.REPLAY_MAX_TITLE_CHARS ?? 140);
const maxAnswerChars = Number(process.env.REPLAY_MAX_ANSWER_CHARS ?? 500);

function sampleIndices(indices, target) {
  if (indices.length <= target) return new Set(indices);
  const set = new Set();
  const lastIdx = indices.length - 1;
  for (let i = 0; i < target; i += 1) {
    const pos = Math.round((i / (target - 1)) * lastIdx);
    set.add(indices[pos]);
  }
  return set;
}

function clampText(value, maxChars) {
  if (typeof value !== "string") return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

function slimEvents(events) {
  const limits = {
    graph_patch: maxGraphPatches,
    narration_delta: maxNarration,
    branch_update: maxBranch,
    tool_call: maxToolCall,
    tool_result: maxToolResult,
    agent_step: maxAgentStep,
  };

  const indexByType = {};
  for (let i = 0; i < events.length; i += 1) {
    const type = events[i]?.event;
    if (!type) continue;
    if (!indexByType[type]) indexByType[type] = [];
    indexByType[type].push(i);
  }

  const keepByType = {};
  for (const [type, idxs] of Object.entries(indexByType)) {
    if (limits[type]) {
      keepByType[type] = sampleIndices(idxs, limits[type]);
    }
  }

  const slim = [];
  for (let i = 0; i < events.length; i += 1) {
    let event = events[i];
    if (!event || typeof event.event !== "string") continue;

    if (event.event === "graph_delta") continue;

    const keepSet = keepByType[event.event];
    if (keepSet && !keepSet.has(i)) continue;

    if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
      const data = { ...event.data };
      if (typeof data.detail === "string") data.detail = clampText(data.detail, maxDetailChars);
      if (typeof data.title === "string") data.title = clampText(data.title, maxTitleChars);
      if (typeof data.answer === "string" && event.event !== "final_answer") {
        data.answer = clampText(data.answer, maxAnswerChars);
      }
      event = { ...event, data };
    }

    slim.push(event);
  }

  return slim;
}

const entries = await fs.readdir(inputDir);
const targets = entries.filter((name) => name.startsWith(includePrefix) && name.endsWith(".events.json"));
if (targets.length === 0) {
  console.error(`No replay fixtures found in ${inputDir}`);
  process.exit(1);
}

await fs.mkdir(outputDir, { recursive: true });

for (const name of targets) {
  const inputPath = path.join(inputDir, name);
  const outputPath = path.join(outputDir, name);
  const raw = await fs.readFile(inputPath, "utf8");
  const events = JSON.parse(raw);
  if (!Array.isArray(events)) {
    console.error(`Skipping ${name}: not an array`);
    continue;
  }
  const slim = slimEvents(events);
  await fs.writeFile(outputPath, JSON.stringify(slim));
  const rawSize = raw.length / 1e6;
  const slimSize = (await fs.readFile(outputPath, "utf8")).length / 1e6;
  console.log(`${name}: ${rawSize.toFixed(2)}MB -> ${slimSize.toFixed(2)}MB (${events.length} -> ${slim.length} events)`);
}
