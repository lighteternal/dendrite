import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.TARGETGRAPH_BASE_URL ?? "http://localhost:3000";
const outDir = process.env.TARGETGRAPH_UI_OUT ?? "/tmp/targetgraph-replay-examples";
const maxRunMs = Number(process.env.TARGETGRAPH_UI_TIMEOUT_MS ?? 480000);
const sessionId = process.env.TARGETGRAPH_SESSION_ID ?? `ui-audit-${Date.now()}`;
const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";

const runs = [
  {
    key: "replay_als_oxidative",
    kind: "replay",
    query: "What targets and pathways connect ALS to oxidative stress?",
    url: `${baseUrl}/brief?query=${encodeURIComponent("What targets and pathways connect ALS to oxidative stress?")}&replay=als-oxidative-v1`,
  },
  {
    key: "example_als_oxidative",
    kind: "live",
    query: "What targets and pathways connect ALS to oxidative stress?",
  },
  {
    key: "example_obesity_t2d_inflammation",
    kind: "live",
    query: "How might obesity lead to type 2 diabetes through inflammatory signaling?",
  },
  {
    key: "example_lupus_il6_obesity",
    kind: "live",
    query: "Which mechanistic path could connect lupus, IL-6 signaling, and obesity?",
  },
];

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
    return { ok: false, reason: `set_api_key_failed:${response.status}:${payload.slice(0, 240)}` };
  }
  return { ok: true };
}

function parseProgress(text) {
  const match = text.match(/Progress\s+(\d{1,3})%/i);
  return match ? Number(match[1]) : null;
}

function parseRunTimeSec(text) {
  const match = text.match(/Run time\s+(\d+)s/i);
  return match ? Number(match[1]) : null;
}

function parseActivePath(text) {
  const match = text.match(/ACTIVE PATH\s+([^\n]+)/i);
  return match ? match[1].trim() : null;
}

function parseAnswerBlock(text) {
  const match = text.match(/Scientific answer\s+([\s\S]*?)Execution log/i);
  if (!match) return "";
  return match[1].trim();
}

function parseReferencesCount(text) {
  const match = text.match(/References\s*\((\d+)\)/i);
  return match ? Number(match[1]) : 0;
}

function extractCitationIndices(text) {
  const matches = [...text.matchAll(/\[(\d{1,3})\]/g)];
  return [...new Set(matches.map((m) => Number(m[1])))]
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function normalizeEntityName(part) {
  return part
    .replace(/[\u2026…]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPathEntities(activePath) {
  if (!activePath) return [];
  return activePath
    .split("->")
    .map((part) => normalizeEntityName(part))
    .filter((part) => part.length > 1 && !/^not provided$/i.test(part));
}

function alignmentScore(entities, answerText) {
  const hay = answerText.toLowerCase();
  const checks = entities.map((entity) => {
    const cleaned = entity.toLowerCase();
    const present = cleaned.length > 2 && hay.includes(cleaned);
    return { entity, present };
  });
  const matched = checks.filter((item) => item.present).length;
  const total = checks.length;
  return {
    total,
    matched,
    ratio: total > 0 ? Number((matched / total).toFixed(3)) : 1,
    missing: checks.filter((item) => !item.present).map((item) => item.entity),
  };
}

async function waitForGraphReady(page) {
  await page.waitForSelector("text=Interactive Mechanism Network", { timeout: 120000 });
  await page.waitForSelector("text=Scientific answer", { timeout: 120000 });
  await page.waitForSelector("text=Execution log", { timeout: 120000 });
}

async function waitForDone(page, maxMs) {
  const started = Date.now();
  let lastText = "";
  let lastProgress = -1;
  let lastProgressAt = Date.now();
  while (Date.now() - started < maxMs) {
    const bodyText = await page.locator("body").innerText();
    lastText = bodyText;
    const progress = parseProgress(bodyText);
    if (typeof progress === "number" && progress !== lastProgress) {
      lastProgress = progress;
      lastProgressAt = Date.now();
    }

    const doneSignal =
      /Build complete/i.test(bodyText) ||
      /No conclusive mechanism identified/i.test(bodyText) ||
      /Agent scientific answer/i.test(bodyText);

    if (doneSignal && (progress === null || progress >= 100)) {
      return { done: true, elapsedMs: Date.now() - started, bodyText };
    }

    // Guard against UI progress bars that stall at high percentages while synthesis wraps up.
    if (doneSignal && lastProgress >= 96 && Date.now() - lastProgressAt > 90_000) {
      return {
        done: true,
        elapsedMs: Date.now() - started,
        bodyText,
        forcedClose: "high_progress_stall",
      };
    }

    await page.waitForTimeout(1600);
  }
  return { done: false, elapsedMs: Date.now() - started, bodyText: lastText };
}

async function captureRun(page, run) {
  const runSlug = slug(run.key);
  const shots = {
    early: `${outDir}/${runSlug}-early.png`,
    mid: `${outDir}/${runSlug}-mid.png`,
    final: `${outDir}/${runSlug}-final.png`,
    graph: `${outDir}/${runSlug}-graph.png`,
    answer: `${outDir}/${runSlug}-answer.png`,
  };

  const url =
    run.url ?? `${baseUrl}/brief?query=${encodeURIComponent(run.query)}${run.kind === "replay" ? "&replay=als-oxidative-v1" : ""}`;

  const startedAt = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForGraphReady(page);

  await page.waitForTimeout(9000);
  await page.screenshot({ path: shots.early, fullPage: true });

  await page.waitForTimeout(28000);
  await page.screenshot({ path: shots.mid, fullPage: true });

  const done = await waitForDone(page, maxRunMs);
  await page.waitForTimeout(1200);

  await page.screenshot({ path: shots.final, fullPage: true });

  const graphHeading = page.getByText("Interactive Mechanism Network").first();
  const graphPanel = graphHeading.locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  if (await graphPanel.count()) {
    await graphPanel.screenshot({ path: shots.graph });
  }

  const answerHeading = page.getByText("Scientific answer").first();
  const answerPanel = answerHeading.locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  if (await answerPanel.count()) {
    await answerPanel.screenshot({ path: shots.answer });
  }

  const bodyText = done.bodyText || (await page.locator("body").innerText());
  const answerText = parseAnswerBlock(bodyText);
  const activePath = parseActivePath(bodyText);
  const activePathEntities = splitPathEntities(activePath);
  const pathVsAnswer = alignmentScore(activePathEntities, answerText);

  const citationLinkCount = await page.locator('a[href^="#ref-"]').count();
  let firstCitationHref = null;
  let citationClickHash = null;
  if (citationLinkCount > 0) {
    const first = page.locator('a[href^="#ref-"]').first();
    firstCitationHref = await first.getAttribute("href");
    if (firstCitationHref) {
      await first.click({ timeout: 8000 }).catch(() => {});
      citationClickHash = await page.evaluate(() => window.location.hash);
    }
  }

  const refDomCount = await page.locator('[id^="ref-"]').count();
  const answerCitationIndices = extractCitationIndices(answerText);
  const citationTargetSet = new Set(
    (
      await page
        .locator('[id^="ref-"]')
        .evaluateAll((nodes) => nodes.map((n) => Number((n.id || "").replace(/^ref-/, ""))))
    ).filter((n) => Number.isFinite(n)),
  );
  const missingAnswerCitations = answerCitationIndices.filter((idx) => !citationTargetSet.has(idx));

  return {
    key: run.key,
    kind: run.kind,
    query: run.query,
    elapsedMs: Date.now() - startedAt,
    waitMs: done.elapsedMs,
    done: done.done,
    progressPct: parseProgress(bodyText),
    runTimeSecUI: parseRunTimeSec(bodyText),
    activePath,
    activePathEntities,
    pathVsAnswer,
    referencesCount: parseReferencesCount(bodyText),
    citationLinkCount,
    firstCitationHref,
    citationClickHash,
    citationTargets: [...citationTargetSet].sort((a, b) => a - b),
    answerCitationIndices,
    missingAnswerCitations,
    answerPreview: answerText.slice(0, 1800),
    screenshots: shots,
  };
}

await fs.mkdir(outDir, { recursive: true });

const apiKeyStatus = await setSessionApiKey();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 2200, height: 1400 } });
await context.addInitScript(
  ({ forcedSessionId }) => {
    window.localStorage.setItem("targetgraph_session_id", forcedSessionId);
  },
  { forcedSessionId: sessionId },
);

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") {
    consoleErrors.push(msg.text());
  }
});

const results = [];
for (const run of runs) {
  try {
    // Replay can run without key. Live queries require key set.
    if (run.kind === "live" && !apiKeyStatus.ok) {
      results.push({ key: run.key, kind: run.kind, query: run.query, skipped: true, reason: apiKeyStatus.reason });
      continue;
    }
    const result = await captureRun(page, run);
    results.push(result);
  } catch (error) {
    results.push({
      key: run.key,
      kind: run.kind,
      query: run.query,
      failed: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  outDir,
  sessionId,
  apiKeyStatus,
  maxRunMs,
  consoleErrors,
  runs,
  results,
};

const reportPath = `${outDir}/report.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
