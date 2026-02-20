import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base = 'http://localhost:3000';
const outDir = '/tmp/dendrite-live-audit-v2';
await fs.mkdir(outDir, { recursive: true });

const queries = [
  'which pathways connect il6 to rheumatoid arthritis',
  'do glp1 agonists mechanistically connect obesity and alzheimer disease',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

async function waitForRunState(maxMs = 85000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const buildComplete = await page.getByText('Build complete', { exact: false }).count().catch(() => 0);
    const finalVerdict = await page.getByText('Final Verdict', { exact: true }).count().catch(() => 0);
    if (buildComplete > 0 || finalVerdict > 0) return { done: true, waitedMs: Date.now() - start };

    // If no live indicator appears for a while, keep polling; we still snapshot at timeout.
    await page.waitForTimeout(1500);
  }
  return { done: false, waitedMs: Date.now() - start };
}

async function textOrNull(locator) {
  try {
    const t = await locator.textContent();
    return t?.replace(/\s+/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

const results = [];
for (let i = 0; i < queries.length; i += 1) {
  const query = queries[i];
  const startedAt = Date.now();
  const safe = query.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 90);
  const screenshot = `${outDir}/${String(i + 1).padStart(2, '0')}-${safe}.png`;

  try {
    await page.goto(`${base}/brief?query=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForSelector('text=Interactive Mechanism Network', { timeout: 25000 });
    await page.waitForSelector('text=Execution Narration', { timeout: 25000 });

    const runState = await waitForRunState();

    const statusText = await textOrNull(page.locator('text=Execution Narration').locator('xpath=..').locator('div.font-semibold').first());
    const activePathText = await textOrNull(page.locator('text=Active path').locator('xpath=..').first());
    const leadTargetText = await textOrNull(page.locator('text=Lead target').locator('xpath=..').first());
    const nodeBadge = await textOrNull(page.locator('text=Nodes').first());
    const edgesBadge = await textOrNull(page.locator('text=Edges').first());
    const interruptEnabled = await page.getByRole('button', { name: /interrupt/i }).isEnabled().catch(() => null);

    await page.screenshot({ path: screenshot, fullPage: true });

    results.push({
      query,
      status: 'ok',
      elapsedMs: Date.now() - startedAt,
      runDone: runState.done,
      waitMs: runState.waitedMs,
      statusText,
      activePathText,
      leadTargetText,
      nodeBadge,
      edgesBadge,
      interruptEnabled,
      screenshot,
    });
  } catch (error) {
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    results.push({
      query,
      status: 'failed',
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      screenshot,
    });
  }
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  base,
  queries,
  consoleErrors,
  results,
};

const reportPath = `${outDir}/report.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
