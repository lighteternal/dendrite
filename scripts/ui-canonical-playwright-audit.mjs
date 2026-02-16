import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.TARGETGRAPH_BASE_URL ?? "http://localhost:3000";
const outDir = process.env.TARGETGRAPH_UI_OUT ?? "/tmp/targetgraph-ui-canonical";
const timeoutMs = Number(process.env.TARGETGRAPH_UI_TIMEOUT_MS ?? 180000);
const queries = [
  "What targets and pathways connect ALS to oxidative stress?",
  "How might obesity lead to type 2 diabetes through inflammatory signaling?",
  "Which mechanistic path could connect lupus, IL-6 signaling, and obesity?",
];

await fs.mkdir(outDir, { recursive: true });

function slug(value) {
  return value
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 90);
}

function parseProgress(text) {
  const match = text.match(/Progress\s+(\d{1,3})%/i);
  if (!match) return null;
  return Number(match[1]);
}

async function readSignals(page) {
  const text = await page.locator("body").innerText();
  const progress = parseProgress(text);
  const nodes = text.match(/Nodes\s+(\d+)/i)?.[1] ?? null;
  const edges = text.match(/Edges\s+(\d+)/i)?.[1] ?? null;
  const runTimeSec = text.match(/Run time\s+(\d+)s/i)?.[1] ?? null;
  const activePath = text.match(/ACTIVE PATH\s+([^\n]+)/i)?.[1] ?? null;
  const finalAnswerReady =
    /Agent scientific answer/i.test(text) ||
    /No conclusive mechanism identified/i.test(text) ||
    /No decisive thread yet/i.test(text);
  const answerInProgress = /Answer in progress/i.test(text);
  const executionLogVisible = /Execution log/i.test(text);
  return {
    progress,
    nodes: nodes ? Number(nodes) : null,
    edges: edges ? Number(edges) : null,
    runTimeSec: runTimeSec ? Number(runTimeSec) : null,
    activePath,
    finalAnswerReady,
    answerInProgress,
    executionLogVisible,
  };
}

async function waitForRunDone(page, maxMs) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const signals = await readSignals(page);
    const running = await page
      .getByRole("button", { name: /^Interrupt$/i })
      .isEnabled()
      .catch(() => false);
    if (!running && signals.finalAnswerReady) {
      return { done: true, elapsedMs: Date.now() - started, signals };
    }
    await page.waitForTimeout(1300);
  }
  return { done: false, elapsedMs: Date.now() - started, signals: await readSignals(page) };
}

async function runQuery(page, query, index) {
  const key = `${String(index + 1).padStart(2, "0")}-${slug(query)}`;
  const shots = {
    landing: `${outDir}/${key}-landing.png`,
    early: `${outDir}/${key}-early.png`,
    mid: `${outDir}/${key}-mid.png`,
    final: `${outDir}/${key}-final.png`,
  };
  const startedAt = Date.now();
  console.log(`RUN:${query}`);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector('input[placeholder*="e.g."]', { timeout: 60000 });
  await page.screenshot({ path: shots.landing, fullPage: true });
  console.log(`SHOT:${shots.landing}`);

  const input = page.locator('input[placeholder*="e.g."]');
  await input.fill(query);
  await Promise.all([
    page.waitForURL(/\/brief\?query=/, { timeout: 120000, waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: /Run analysis/i }).first().click(),
  ]);

  await page.waitForSelector("text=Interactive Mechanism Network", { timeout: 90000 });
  await page.waitForSelector("text=Execution log", { timeout: 90000 });
  await page.waitForTimeout(6000);
  const earlySignals = await readSignals(page);
  await page.screenshot({ path: shots.early, fullPage: true });
  console.log(`SHOT:${shots.early}`);

  await page.waitForTimeout(22000);
  const midSignals = await readSignals(page);
  await page.screenshot({ path: shots.mid, fullPage: true });
  console.log(`SHOT:${shots.mid}`);

  const done = await waitForRunDone(page, timeoutMs);
  await page.waitForTimeout(800);
  const finalSignals = await readSignals(page);
  await page.screenshot({ path: shots.final, fullPage: true });
  console.log(`SHOT:${shots.final}`);

  const finalText = await page.locator("body").innerText();
  const citationsCount =
    Number(finalText.match(/References\s*\((\d+)\)/i)?.[1] ?? "0") ||
    Number(finalText.match(/Citations\s*\((\d+)\)/i)?.[1] ?? "0") ||
    0;

  return {
    query,
    elapsedMs: Date.now() - startedAt,
    completionWaitMs: done.elapsedMs,
    runCompleted: done.done,
    earlySignals,
    midSignals,
    finalSignals,
    citationsCount,
    screenshots: shots,
  };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1760, height: 1080 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

const results = [];
for (let i = 0; i < queries.length; i += 1) {
  try {
    const item = await runQuery(page, queries[i], i);
    results.push({ status: "ok", ...item });
  } catch (error) {
    results.push({
      status: "failed",
      query: queries[i],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  timeoutMs,
  queries,
  consoleErrors,
  results,
};

const reportPath = `${outDir}/report.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
