import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.DENDRITE_BASE_URL ?? "http://localhost:3000";
const outDir = process.env.DENDRITE_E2E_OUT ?? "/tmp/dendrite-e2e-gate";
await fs.mkdir(outDir, { recursive: true });

const queries = [
  "what is the latent connection between diabetes and weight loss",
  "which pathways connect il6 to rheumatoid arthritis",
  "explain paracetamol sideeffects",
];

function slug(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function waitForMidRunState(page) {
  await page.waitForSelector("text=Interactive Mechanism Network", { timeout: 35000 });
  await page.waitForTimeout(4500);
  const narrationCount = await page
    .locator("text=Live Narration")
    .locator("..")
    .locator("div.rounded-md, div.rounded-lg")
    .count()
    .catch(() => 0);
  if (narrationCount < 2) {
    await page.waitForTimeout(3500);
  }
}

async function waitForFinalState(page) {
  const start = Date.now();
  while (Date.now() - start < 130000) {
    const interruptEnabled = await page
      .locator("button:has-text(\"Interrupt\")")
      .isEnabled()
      .catch(() => false);
    if (!interruptEnabled) return;
    await page.waitForTimeout(1500);
  }
}

async function runSingle(page, query, idx) {
  const tag = `${String(idx + 1).padStart(2, "0")}-${slug(query)}`;
  const loadingShot = `${outDir}/${tag}-loading.png`;
  const midShot = `${outDir}/${tag}-mid.png`;
  const finalShot = `${outDir}/${tag}-final.png`;
  const url = `${baseUrl}/brief?query=${encodeURIComponent(query)}`;
  const startedAt = Date.now();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: loadingShot, fullPage: true });

  await waitForMidRunState(page);
  await page.screenshot({ path: midShot, fullPage: true });

  await waitForFinalState(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: finalShot, fullPage: true });

  const bridgeBadgeConnected = await page.locator("text=Bridge connected").count();
  const bridgeBadgeGap = await page.locator("text=Bridge gap").count();
  const verdictCount =
    (await page.locator("text=Final scientific answer").count()) +
    (await page.locator("text=Verdict").count());
  const scoreMentionCount = await page.locator("text=Score").count();
  const decisionMentionCount = await page.locator("text=Decision").count();
  const narrationTitleNodes = page
    .locator("text=Live Narration")
    .locator("..")
    .locator("div.font-semibold");
  const narrationTitles = await narrationTitleNodes.allTextContents();
  const normalizedTitles = narrationTitles
    .map((value) => value.toLowerCase().replace(/\d+/g, "#").trim())
    .filter(Boolean);
  const uniqueNarrationTitles = new Set(normalizedTitles);
  const repetitionRatio =
    normalizedTitles.length > 0 ? uniqueNarrationTitles.size / normalizedTitles.length : 0;

  const bodyText = (await page.textContent("body")) ?? "";
  const mentionsDiabetes = /diabetes/i.test(bodyText);
  const mentionsWeightLoss = /weight loss/i.test(bodyText);

  return {
    query,
    elapsedMs: Date.now() - startedAt,
    screenshots: {
      loading: loadingShot,
      mid: midShot,
      final: finalShot,
    },
    assertions: {
      bridgeOutcomeVisible: bridgeBadgeConnected + bridgeBadgeGap > 0,
      hasVerdictPanel: verdictCount > 0,
      hasScoreAndDecision: scoreMentionCount > 0 && decisionMentionCount > 0,
      narrationDiversityOk: repetitionRatio >= 0.45,
      mentionsDiabetes,
      mentionsWeightLoss,
    },
    metrics: {
      bridgeBadgeConnected,
      bridgeBadgeGap,
      verdictCount,
      scoreMentionCount,
      decisionMentionCount,
      narrationSteps: normalizedTitles.length,
      narrationUnique: uniqueNarrationTitles.size,
      narrationRepetitionRatio: Number(repetitionRatio.toFixed(3)),
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
for (let i = 0; i < queries.length; i += 1) {
  const query = queries[i];
  try {
    const result = await runSingle(page, query, i);
    results.push({
      status: "ok",
      ...result,
    });
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
  consoleErrors,
  results,
};

const reportPath = `${outDir}/report.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
