import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://localhost:3000';
const navTimeoutMs = Number(process.env.PW_NAV_TIMEOUT_MS || 120000);
const outDir = '/tmp/targetgraph-ui-usability';
await fs.mkdir(outDir, { recursive: true });

const query = process.argv.slice(2).join(' ').trim() || 'which pathways connect il6 to rheumatoid arthritis';
const safe = query.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 90);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });

await page.goto(`${base}/brief?query=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
await page.waitForSelector('text=Interactive Mechanism Network', { timeout: navTimeoutMs });

const started = Date.now();
let completed = false;
while (Date.now() - started < 130000) {
  const text = await page.locator('body').innerText();
  if (/Build complete|Final synthesis complete|Current phase: Final synthesis complete/i.test(text)) {
    completed = true;
    break;
  }
  await page.waitForTimeout(1500);
}

await page.waitForTimeout(2000);
const bodyText = await page.locator('body').innerText();
const report = {
  query,
  completed,
  elapsedMs: Date.now() - started,
  verdictPending: /Final verdict pending/i.test(bodyText),
  noDecisiveThread: /No decisive thread yet/i.test(bodyText),
  leadTarget: bodyText.match(/Lead target\s*([A-Za-z0-9\-_.]+)/i)?.[1] ?? null,
  nodes: bodyText.match(/Nodes\s+\d+/)?.[0] ?? null,
  edges: bodyText.match(/Edges\s+\d+/)?.[0] ?? bodyText.match(/\d+\s+interaction edges/)?.[0] ?? null,
};

const screenshot = `${outDir}/single-done-${safe}.png`;
await page.screenshot({ path: screenshot, fullPage: true });
report.screenshot = screenshot;

await browser.close();

const reportPath = `${outDir}/single-done-${safe}.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
