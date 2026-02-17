import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.TARGETGRAPH_BASE_URL ?? "http://localhost:3000";
const outDir = process.env.TARGETGRAPH_UI_OUT ?? "/tmp/targetgraph-ui-final-examples";
const timeoutMs = Number(process.env.TARGETGRAPH_UI_TIMEOUT_MS ?? 620000);
const sessionId = process.env.TARGETGRAPH_SESSION_ID ?? `ui-final-${Date.now()}`;
const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";

const runs = [
  {
    key: "replay_als_oxidative",
    query: "What targets and pathways connect ALS to oxidative stress?",
    url: `${baseUrl}/brief?query=${encodeURIComponent("What targets and pathways connect ALS to oxidative stress?")}&replay=als-oxidative-v1`,
  },
  {
    key: "example_als_oxidative",
    query: "What targets and pathways connect ALS to oxidative stress?",
    url: `${baseUrl}/brief?query=${encodeURIComponent("What targets and pathways connect ALS to oxidative stress?")}`,
  },
  {
    key: "example_obesity_t2d_inflammation",
    query: "How might obesity lead to type 2 diabetes through inflammatory signaling?",
    url: `${baseUrl}/brief?query=${encodeURIComponent("How might obesity lead to type 2 diabetes through inflammatory signaling?")}`,
  },
  {
    key: "example_lupus_il6_obesity",
    query: "Which mechanistic path could connect lupus, IL-6 signaling, and obesity?",
    url: `${baseUrl}/brief?query=${encodeURIComponent("Which mechanistic path could connect lupus, IL-6 signaling, and obesity?")}`,
  },
];

function slug(value) {
  return value
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}

function parseActivePath(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const idx = lines.findIndex((line) => /^ACTIVE PATH$/i.test(line));
  if (idx >= 0) {
    return lines[idx + 1] ?? null;
  }
  const fallback = text.match(/ACTIVE PATH\s+([^\n]+)/i);
  return fallback ? fallback[1].trim() : null;
}

async function setSessionApiKey() {
  if (!apiKey) return { ok: false, reason: "missing_openai_api_key" };
  const response = await fetch(
    `${baseUrl}/api/runCaseStream?action=set_api_key&sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    },
  );
  if (!response.ok) {
    return { ok: false, reason: `set_api_key_failed_${response.status}` };
  }
  return { ok: true };
}

async function waitForDone(page, maxMs) {
  const started = Date.now();
  let lastText = "";
  while (Date.now() - started < maxMs) {
    const text = await page.locator("body").innerText();
    lastText = text;
    const buildDone = /Build complete/i.test(text);
    const hasFinal = /Agent scientific answer/i.test(text) || /No conclusive mechanism identified/i.test(text);
    const inProgress = /Answer in progress/i.test(text);
    if (buildDone && (hasFinal || !inProgress)) {
      return { done: true, elapsedMs: Date.now() - started, text };
    }
    await page.waitForTimeout(2000);
  }
  return { done: false, elapsedMs: Date.now() - started, text: lastText };
}

await fs.mkdir(outDir, { recursive: true });
const keyStatus = await setSessionApiKey();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 2200, height: 1400 } });
await context.addInitScript(
  ({ forcedSessionId }) => {
    window.localStorage.setItem("targetgraph_session_id", forcedSessionId);
  },
  { forcedSessionId: sessionId },
);
const page = await context.newPage();

const results = [];
for (const run of runs) {
  if (!run.key.startsWith("replay") && !keyStatus.ok) {
    results.push({ key: run.key, skipped: true, reason: keyStatus.reason });
    continue;
  }
  const k = slug(run.key);
  const finalShot = `${outDir}/${k}-final.png`;
  const graphShot = `${outDir}/${k}-graph.png`;
  const answerShot = `${outDir}/${k}-answer.png`;
  const start = Date.now();

  await page.goto(run.url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("text=Interactive Mechanism Network", { timeout: 120000 });
  await page.waitForSelector("text=Scientific answer", { timeout: 120000 });

  const done = await waitForDone(page, timeoutMs);
  await page.waitForTimeout(1200);

  const text = done.text || (await page.locator("body").innerText());
  await page.screenshot({ path: finalShot, fullPage: true });

  const graphPanel = page
    .getByText("Interactive Mechanism Network")
    .first()
    .locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  if (await graphPanel.count()) {
    await graphPanel.screenshot({ path: graphShot });
  }

  const answerPanel = page
    .getByText("Scientific answer")
    .first()
    .locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  if (await answerPanel.count()) {
    await answerPanel.screenshot({ path: answerShot });
  }

  const answerTextMatch = text.match(/Scientific answer\s+([\s\S]*?)Execution log/i);
  const answerText = answerTextMatch ? answerTextMatch[1].trim() : "";
  const activePath = parseActivePath(text);
  const refs = Number(text.match(/References\s*\((\d+)\)/i)?.[1] ?? "0");
  const citationLinks = await page.locator('a[href^="#ref-"]').count();

  results.push({
    key: run.key,
    query: run.query,
    elapsedMs: Date.now() - start,
    waitMs: done.elapsedMs,
    done: done.done,
    progressPct: Number(text.match(/Progress\s+(\d{1,3})%/i)?.[1] ?? "0") || null,
    activePath,
    references: refs,
    citationLinks,
    answerPreview: answerText.slice(0, 1200),
    screenshots: { final: finalShot, graph: graphShot, answer: answerShot },
  });
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  sessionId,
  keyStatus,
  timeoutMs,
  results,
};

const reportPath = `${outDir}/report.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
