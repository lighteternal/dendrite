import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://localhost:3000';
const navTimeoutMs = Number(process.env.PW_NAV_TIMEOUT_MS || 120000);
const outDir = '/tmp/targetgraph-ui-usability';
await fs.mkdir(outDir, { recursive: true });

const query = 'do glp1 agonists mechanistically connect obesity and alzheimer disease';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });
const page = await context.newPage();

await page.goto(`${base}/brief?query=${encodeURIComponent(query)}`, {
  waitUntil: 'domcontentloaded',
  timeout: navTimeoutMs,
});

const disabledBefore = null;
const submittedVia = 'direct-link';

await page.waitForSelector('text=Interactive Mechanism Network', { timeout: navTimeoutMs });
await page.waitForSelector('text=Live Search Narration', { timeout: navTimeoutMs });
await page.waitForTimeout(30000);

const bodyText = await page.locator('body').innerText();
const nodes = bodyText.match(/Nodes\s+\d+/)?.[0] ?? null;
const edges = bodyText.match(/Edges\s+\d+/)?.[0] ?? bodyText.match(/\d+\s+interaction edges/)?.[0] ?? null;
const lead = bodyText.match(/Lead target\s*([A-Za-z0-9\-_.]+)/i)?.[1] ?? null;
const screenshot = `${outDir}/03-do-glp1-agonists-mechanistically-connect-obesity-and-alzheimer-disease-recheck.png`;
await page.screenshot({ path: screenshot, fullPage: true });

await browser.close();

const report = {
  query,
  disabledBefore,
  submittedVia,
  url: page.url(),
  nodes,
  edges,
  lead,
  screenshot,
};

const reportPath = `${outDir}/query3-recheck.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
