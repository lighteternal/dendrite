import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.TARGETGRAPH_BASE_URL ?? "http://localhost:3000";
const outDir = process.env.TARGETGRAPH_UI_OUT ?? "/tmp/targetgraph-ui-agentic";
await fs.mkdir(outDir, { recursive: true });

const queryEnv = process.env.TARGETGRAPH_UI_QUERIES;
const queries = queryEnv
  ? queryEnv.split("||").map((item) => item.trim()).filter(Boolean)
  : [
      "what are the targets of als",
      "what hidden mechanism links lupus and obesity through il6 signaling",
    ];

const timeoutMs = Number(process.env.TARGETGRAPH_UI_TIMEOUT_MS ?? 480000);

function slug(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 90);
}

async function waitForRunComplete(page, maxMs) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const pending =
      (await page.locator("text=Final verdict pending").count().catch(() => 0)) > 0;
    const completeSignal =
      (await page.locator("text=Build complete").count().catch(() => 0)) > 0 ||
      (await page.locator("text=Agent scientific answer").count().catch(() => 0)) > 0 ||
      (await page.locator("text=No decisive thread yet").count().catch(() => 0)) > 0;
    const running = await page
      .locator('button:has-text("Interrupt active query")')
      .isEnabled()
      .catch(() => false);
    if (!running && !pending && completeSignal) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function runQuery(page, query, idx) {
  const tag = `${String(idx + 1).padStart(2, "0")}-${slug(query)}`;
  const url = `${baseUrl}/brief?query=${encodeURIComponent(query)}`;
  const midShot = `${outDir}/${tag}-mid.png`;
  const finalShot = `${outDir}/${tag}-final.png`;
  const startedAt = Date.now();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("text=Interactive Mechanism Network", { timeout: 45000 });
  await page.waitForSelector("text=Live Narration", { timeout: 45000 });
  await page.waitForTimeout(12000);

  const signalCountersVisible =
    (await page.locator("text=/\\bCalls\\b/i").count()) > 0 &&
    (await page.locator("text=/\\bResults\\b/i").count()) > 0 &&
    (await page.locator("text=/\\bActive\\b/i").count()) > 0 &&
    (await page.locator("text=/\\bDiscarded\\b/i").count()) > 0;

  const eventKindChipCount = await page
    .locator('span:has-text("tool call"), span:has-text("tool result"), span:has-text("warning"), span:has-text("phase"), span:has-text("pipeline"), span:has-text("handoff")')
    .count();

  await page.screenshot({ path: midShot, fullPage: true });

  const completed = await waitForRunComplete(page, timeoutMs);
  await page.waitForTimeout(1000);

  const finalAnswerPanel = await page.locator("text=Final scientific answer").count();
  const finalAgentAnswer = await page.locator("text=Agent scientific answer").count();
  const noDecisive = await page.locator("text=No decisive thread yet").count();
  const finalPending = await page.locator("text=Final verdict pending").count();
  const references = await page.locator("text=References").count();

  await page.screenshot({ path: finalShot, fullPage: true });

  return {
    query,
    elapsedMs: Date.now() - startedAt,
    completed,
    signalCountersVisible,
    eventKindChipCount,
    finalAnswerPanel,
    finalAgentAnswer,
    noDecisive,
    finalPending,
    references,
    screenshots: {
      mid: midShot,
      final: finalShot,
    },
  };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1720, height: 1040 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") {
    consoleErrors.push(msg.text());
  }
});

const results = [];
for (let index = 0; index < queries.length; index += 1) {
  const query = queries[index];
  try {
    results.push({ status: "ok", ...(await runQuery(page, query, index)) });
  } catch (error) {
    results.push({
      status: "failed",
      query,
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
