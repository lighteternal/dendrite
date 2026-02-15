import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://localhost:3000';
const navTimeoutMs = Number(process.env.PW_NAV_TIMEOUT_MS || 120000);
const outDir = '/tmp/targetgraph-ui-usability';
await fs.mkdir(outDir, { recursive: true });

const query = process.argv.slice(2).join(' ').trim() || 'which pathways connect il6 to rheumatoid arthritis';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });

await page.goto(`${base}/brief?query=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
await page.waitForSelector('text=Interactive Mechanism Network', { timeout: navTimeoutMs });
await page.waitForSelector('text=Live Search Narration', { timeout: 20000 });
await page.waitForTimeout(30000);

const bodyText = await page.locator('body').innerText();
const res = {
  query,
  nodes: bodyText.match(/Nodes\s+\d+/)?.[0] ?? null,
  edges: bodyText.match(/Edges\s+\d+/)?.[0] ?? bodyText.match(/\d+\s+interaction edges/)?.[0] ?? null,
  hasPendingVerdictText: /Final verdict pending/i.test(bodyText),
  hasBoilerplateDecisionText: /Pending decision|Calibrating/i.test(bodyText),
  hasLiveNarration: /Live Search Narration/i.test(bodyText),
};

const safe = query.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 90);
const screenshot = `${outDir}/single-${safe}.png`;
await page.screenshot({ path: screenshot, fullPage: true });
await browser.close();

res.screenshot = screenshot;
const reportPath = `${outDir}/single-${safe}.json`;
await fs.writeFile(reportPath, JSON.stringify(res, null, 2));
console.log(reportPath);
