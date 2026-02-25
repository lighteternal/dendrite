import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.DENDRITE_BASE_URL ?? "http://localhost:3000";
const outDir = process.env.DENDRITE_UI_OUT ?? "/tmp/dendrite-ui-custom";
const timeoutMs = Number(process.env.DENDRITE_UI_TIMEOUT_MS ?? 620000);
const sessionId = process.env.DENDRITE_SESSION_ID ?? `ui-custom-${Date.now()}`;
const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const queries = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);

if (queries.length === 0) {
  console.error('usage: node scripts/ui-final-capture-custom.mjs "<query1>" "<query2>"');
  process.exit(1);
}

function slug(value) {
  return value
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
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
    const payload = await response.text().catch(() => "");
    return { ok: false, reason: `set_api_key_failed:${response.status}:${payload.slice(0, 200)}` };
  }
  return { ok: true };
}

async function waitForDone(page, maxMs) {
  const started = Date.now();
  let lastText = "";
  let sawRunningState = false;
  while (Date.now() - started < maxMs) {
    const text = await page.locator("body").innerText();
    lastText = text;
    const hasFinal =
      /Agent scientific answer/i.test(text) ||
      /No conclusive mechanism identified/i.test(text) ||
      /Build complete/i.test(text);
    const inProgress = /Answer in progress/i.test(text);
    const interruptEnabled = await page
      .getByRole("button", { name: /^Interrupt$/i })
      .isEnabled()
      .catch(() => false);
    if (interruptEnabled || inProgress || /Execution log/i.test(text)) {
      sawRunningState = true;
    }
    if ((sawRunningState && hasFinal && !interruptEnabled) || (hasFinal && !inProgress)) {
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
    window.localStorage.setItem("dendrite_session_id", forcedSessionId);
  },
  { forcedSessionId: sessionId },
);
const page = await context.newPage();

const results = [];
for (const query of queries) {
  if (!keyStatus.ok) {
    results.push({ query, skipped: true, reason: keyStatus.reason });
    continue;
  }

  const key = slug(query);
  const finalShot = `${outDir}/${key}-final.png`;
  const graphShot = `${outDir}/${key}-graph.png`;
  const answerShot = `${outDir}/${key}-answer.png`;
  const start = Date.now();
  const url = `${baseUrl}/brief?query=${encodeURIComponent(query)}`;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
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

  results.push({
    query,
    elapsedMs: Date.now() - start,
    waitMs: done.elapsedMs,
    done: done.done,
    answerPreview: answerText.slice(0, 1400),
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
