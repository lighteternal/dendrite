import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base = process.env.TARGETGRAPH_BASE_URL ?? 'http://localhost:3000';
const outDir = process.env.TARGETGRAPH_UI_OUT ?? '/tmp/targetgraph-ui-regression';
await fs.mkdir(outDir, { recursive: true });

const queries = [
  'is als hereditary',
  'targets for ALS',
  'what is the best target for copd',
  'what are the treatments for lupus',
  'what is the connection between copd and lupus',
  'what is the connection betwene copd and lupus',
  'explain paracetamol sideeffects',
  'targets for glp1',
  'connection between alz and copd',
  'which pathways connect il6 to rheumatoid arthritis',
  'compare targets in crohn disease vs ulcerative colitis',
  'alopecia targets that are druggable and do not affect the blood brain barrier',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(msg.text());
  }
});

const results = [];
for (let i = 0; i < queries.length; i += 1) {
  const query = queries[i];
  const url = `${base}/brief?query=${encodeURIComponent(query)}`;
  const startedAt = Date.now();
  const screenshotFile = `${outDir}/${String(i + 1).padStart(2, '0')}-${query
    .replace(/[^a-z0-9]+/gi, '-')
    .slice(0, 70)}.png`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('text=Interactive Mechanism Network', { timeout: 20000 });
    await page.waitForSelector('text=Live Search', { timeout: 15000 });
    await page.waitForSelector('text=Live Narration', { timeout: 15000 });
    await page.waitForTimeout(12000);

    const warningCount = await page.locator('text=Warning:').count();
    const pendingCount = await page.locator('text=Final verdict pending').count();
    const liveSearchCount = await page.locator('text=Live Search').count();
    const insightsPanelCount = await page.locator('text=Evidence insights').count();
    const graphCount = await page.locator('text=Interactive Mechanism Network').count();
    const queryPlanCount = await page.locator('text=Query plan:').count();
    const multiHopChipCount = await page.locator('text=/Search mode:\\s*Multi-?hop search/i').count();
    const bridgeConnectedCount = await page.locator('text=Bridge connected').count();
    const bridgeGapCount = await page.locator('text=Bridge gap').count();
    const finalAnswerCount = await page.locator('text=Final scientific answer').count();
    const referencesCount = await page.locator('text=References').count();
    const interruptionButtonEnabled = await page
      .locator('button:has-text("Interrupt")')
      .isEnabled()
      .catch(() => false);
    const hasLiveNarration = (await page.locator('text=Live Narration').count()) > 0;

    await page.screenshot({ path: screenshotFile, fullPage: true });

    results.push({
      idx: i + 1,
      query,
      status: 'ok',
      elapsedMs: Date.now() - startedAt,
      warningCount,
      pendingCount,
      liveSearchCount,
      insightsPanelCount,
      graphCount,
      queryPlanCount,
      multiHopChipCount,
      bridgeConnectedCount,
      bridgeGapCount,
      finalAnswerCount,
      referencesCount,
      interruptionButtonEnabled,
      hasLiveNarration,
      screenshotFile,
    });
  } catch (error) {
    await page.screenshot({ path: screenshotFile, fullPage: true }).catch(() => undefined);
    results.push({
      idx: i + 1,
      query,
      status: 'failed',
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      screenshotFile,
    });
  }
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  base,
  consoleErrors,
  results,
};

const reportPath = `${outDir}/report.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
