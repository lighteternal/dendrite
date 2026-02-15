import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base = 'http://localhost:3000';
const outDir = '/tmp/targetgraph-live-audit';
await fs.mkdir(outDir, { recursive: true });

const queries = [
  'what pathways connect NLRP3 to gout inflammation',
  'can semaglutide mechanisms connect obesity and alzheimer disease',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

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
    await page.waitForTimeout(22000);

    const statusText = await page.locator('div.rounded-lg.border.border-\\[\\#dbe4f2\\].bg-\\[\\#f7faff\\].px-2\\.5.py-2 div.font-semibold').first().textContent().catch(() => null);
    const activePathText = await page.locator('text=Active path').locator('xpath=..').textContent().catch(() => null);
    const recommendationText = await page.locator('text=Lead target').locator('xpath=..').textContent().catch(() => null);

    const liveBadgeVisible = await page.locator('text=Live stream active').count();
    const nodeBadge = await page.locator('text=Nodes').first().textContent().catch(() => null);
    const edgeBadge = await page.locator('text=Edges').first().textContent().catch(() => null);

    await page.screenshot({ path: screenshot, fullPage: true });

    results.push({
      query,
      status: 'ok',
      elapsedMs: Date.now() - startedAt,
      statusText,
      activePathText,
      recommendationText,
      liveBadgeVisible,
      nodeBadge,
      edgeBadge,
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
