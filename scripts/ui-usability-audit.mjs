import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://localhost:3000';
const navTimeoutMs = Number(process.env.PW_NAV_TIMEOUT_MS || 120000);
const outDir = '/tmp/targetgraph-ui-usability';
await fs.mkdir(outDir, { recursive: true });

const queries = [
  'is als hereditary',
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

function now() {
  return Date.now();
}

async function waitForTextMatch(regex, timeoutMs = 25000) {
  const started = now();
  while (now() - started < timeoutMs) {
    const text = await page.locator('body').innerText();
    if (regex.test(text)) {
      return { matched: true, elapsedMs: now() - started, sample: regex.exec(text)?.[0] ?? null };
    }
    await page.waitForTimeout(600);
  }
  return { matched: false, elapsedMs: now() - started, sample: null };
}

async function runQuery(query, index) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
  await page.waitForSelector('input[placeholder*="e.g."]', { timeout: navTimeoutMs });

  const landingText = await page.locator('main').innerText();
  const landingHasMode = /Multi-hop biomedical search/i.test(landingText);
  const landingHasSubmitHint = /press\s+Generate brief/i.test(landingText);

  const input = page.locator('input[placeholder*="e.g."]');
  await input.fill(query);

  const submitStart = now();
  const submitButton = page.getByRole('button', { name: /Generate brief/i }).first();
  try {
    await Promise.all([
      page.waitForURL(/\/brief\?query=/, { timeout: navTimeoutMs, waitUntil: 'domcontentloaded' }),
      submitButton.click(),
    ]);
  } catch {
    await input.press('Enter');
    await page.waitForURL(/\/brief\?query=/, { timeout: navTimeoutMs, waitUntil: 'domcontentloaded' });
  }
  const navElapsedMs = now() - submitStart;

  await page.waitForSelector('text=Interactive Mechanism Network', { timeout: navTimeoutMs });
  await page.waitForSelector('text=Live Search Narration', { timeout: navTimeoutMs });

  const generateBtn = page.getByRole('button', { name: /Generate brief/i }).first();
  const interruptBtn = page.getByRole('button', { name: /^Interrupt$/i }).first();

  const runSignal = await waitForTextMatch(/Resolving|targets enriched|pathways linked|compounds linked|Build complete|DeepAgents active path/i, 30000);

  const runningState = {
    generateDisabled: await generateBtn.isDisabled().catch(() => null),
    interruptEnabled: await interruptBtn.isEnabled().catch(() => null),
  };

  // Validate one-active-query lock via same-session API call.
  const lockProbe = await page.evaluate(async () => {
    const sid = window.localStorage.getItem('targetgraph_session_id');
    if (!sid) return { skipped: true };
    const runId = `probe-${Date.now()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`/api/runCaseStream?query=${encodeURIComponent('probe second run')}&mode=multihop&runId=${encodeURIComponent(runId)}&sessionId=${encodeURIComponent(sid)}`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const txt = await res.text();
      return { skipped: false, status: res.status, body: txt.slice(0, 140) };
    } catch (e) {
      clearTimeout(timer);
      return { skipped: false, error: String(e) };
    }
  });

  // Let UI settle and collect visible evidence quality.
  await page.waitForTimeout(35000);

  const bodyText = await page.locator('body').innerText();
  const nodesText = bodyText.match(/Nodes\s+\d+/)?.[0] ?? null;
  const edgesText = bodyText.match(/Edges\s+\d+/)?.[0] ?? bodyText.match(/\d+\s+interaction edges/)?.[0] ?? null;
  const leadTargetMatch = bodyText.match(/Lead target\s*([A-Za-z0-9\-_.]+)/i);
  const leadTarget = leadTargetMatch ? leadTargetMatch[1] : null;
  const hasFinalVerdict = /Final Verdict/i.test(bodyText);
  const hasAgentNarration = /Agentic narration/i.test(bodyText);
  const hasLiveNarration = /Live Search Narration/i.test(bodyText);
  const hasGraph = /Interactive Mechanism Network/i.test(bodyText);

  const confusingTokens = {
    hasP0P1Tokens: /\bP0\b|\bP1\b|\bP2\b/i.test(bodyText),
    hasBoilerplateDecisionText: /Pending decision|Calibrating/i.test(bodyText),
    hasLegacyModeWords: /Program Review|Triage|Due Diligence/i.test(bodyText),
  };

  const graphTitle = page.getByText('Interactive Mechanism Network', { exact: true }).first();
  const narrationTitle = page.getByText('Live Search Narration', { exact: true }).first();
  const graphBox = await graphTitle.boundingBox();
  const narrationBox = await narrationTitle.boundingBox();
  const viewport = page.viewportSize();
  const aboveFold = Boolean(
    graphBox && narrationBox && viewport &&
    graphBox.y < viewport.height && narrationBox.y < viewport.height,
  );

  const safe = query.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 90);
  const screenshot = `${outDir}/${String(index + 1).padStart(2, '0')}-${safe}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });

  // Heuristic scoring: 1-5 each
  const scores = {
    start_clarity: landingHasMode && landingHasSubmitHint ? 4 : 2,
    run_feedback: runSignal.matched && (runningState.interruptEnabled === true) ? 4 : 2,
    control_safety: lockProbe?.status === 409 ? 5 : 3,
    information_architecture: aboveFold && hasGraph && hasLiveNarration && hasAgentNarration ? 4 : 2,
    outcome_clarity: hasFinalVerdict || (leadTarget && !/Resolving/i.test(String(leadTarget))) ? 3 : 2,
  };
  const meanScore = Number((Object.values(scores).reduce((a, b) => a + b, 0) / 5).toFixed(2));

  return {
    query,
    navElapsedMs,
    runSignal,
    runningState,
    lockProbe,
    nodesText,
    edgesText,
    leadTarget,
    hasFinalVerdict,
    hasAgentNarration,
    hasLiveNarration,
    hasGraph,
    confusingTokens,
    aboveFold,
    scores,
    meanScore,
    screenshot,
  };
}

const results = [];
for (let i = 0; i < queries.length; i += 1) {
  try {
    const result = await runQuery(queries[i], i);
    results.push({ status: 'ok', ...result });
  } catch (error) {
    results.push({
      status: 'failed',
      query: queries[i],
      error: error instanceof Error ? error.message : String(error),
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
