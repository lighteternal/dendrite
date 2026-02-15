# TargetGraph Handover

This handover is a **repo snapshot + observed behavior from this conversation**. It only includes items that are visible in the current codebase or explicitly observed during the recent runs/screenshots.

## 1) Current repo shape

- Monorepo root: `targetgraph`
- Main app: `apps/web` (Next.js 16, App Router)
- MCP services (local folders):
  - `services/mcp-opentargets`
  - `services/mcp-reactome`
  - `services/mcp-string`
  - `services/mcp-chembl`
  - `services/mcp-pubmed`
  - `biomcp` via docker image/command in compose
- Product spec doc present: `docs/prd-multihop-search.md`

## 2) Runtime URLs and ports

### Frontend

- `http://localhost:3000`

### Backend APIs (served by Next app)

- `GET /api/runCaseStream` (SSE main pipeline)
- `POST /api/runCaseStream?action=interrupt|status` (session control)
- `GET /api/streamGraph` (internal graph stream endpoint)
- `GET /api/agentDiscover` (SSE deep discoverer / subagent workflow)
- `GET /api/resolveDisease`
- `GET /api/suggestDisease`
- `GET /api/suggestEntities`
- `GET /api/suggestQuery`
- `POST /api/rank`
- `POST /api/hypothesis`

### MCP services (docker-compose)

- OpenTargets MCP: `http://localhost:7010/mcp`
- Reactome MCP: `http://localhost:7020/mcp`
- STRING MCP: `http://localhost:7030/mcp`
- ChEMBL MCP: `http://localhost:7040/mcp`
- PubMed MCP: `http://localhost:7050/mcp`
- BioMCP: `http://localhost:8000/mcp`

(Defaults are defined in `apps/web/src/server/config.ts`.)

## 3) What the backend currently does

## 3.1 Main execution path (`/api/runCaseStream`)

`apps/web/src/app/api/runCaseStream/route.ts` is still the primary orchestrator for the page.

High-level behavior:

1. Enforces one active run per session key (in-memory lock map).
2. Resolves entities via `resolveQueryEntitiesBundle(...)`.
3. Picks a primary disease or synthetic query anchor (heuristic arbitration).
4. Emits early graph patches/path updates (including cross-disease candidate bridges).
5. Opens internal stream to `/api/streamGraph` and relays patches/status.
6. Computes/updates final brief using ranking/evidence table logic (`generateBriefSections`).
7. Emits final status + done event.

Important implementation detail:

- This route still contains substantial deterministic/heuristic logic for bridge evaluation, scoring, and brief text assembly.
- It is not purely agent-driven end-to-end.

## 3.2 Agent discoverer (`/api/agentDiscover`)

`apps/web/src/app/api/agentDiscover/route.ts` streams a separate agentic workflow from `runDeepDiscoverer(...)`.

`apps/web/src/server/agent/deep-discoverer.ts` currently has:

- Coordinator + subagent pattern with LangChain `createAgent`:
  - `pathway_mapper`
  - `translational_scout`
  - `bridge_hunter`
  - `literature_scout`
- Tool-access through MCP wrappers (OpenTargets, Reactome, STRING, ChEMBL, PubMed, BioMCP).
- Max PubMed subquery budget (`MAX_PUBMED_SUBQUERIES = 5`).
- Graph patch emission from discovered entities/edges.
- Follow-up routing from discovered questions.
- Deterministic fallback when LLM fails/rate-limits/no key.

Final synthesis in deep-discoverer:

- Tries structured synthesis (`synthesisSchema`) using LLM.
- Has freeform rescue synthesis function.
- Falls back to deterministic summary if synthesis fails.

## 3.3 Query planning + entity resolution

- `apps/web/src/server/agent/query-plan.ts`
- `apps/web/src/server/agent/entity-resolution.ts`
- `apps/web/src/server/openai/disease-resolver.ts`

Current behavior includes:

- Candidate-first resolution using MCP candidates.
- Typed anchors (disease/target/drug/etc.).
- Guardrails against measurement-like disease entities.
- Heuristic mention extraction and relation parsing.
- In-memory TTL caches for plan/bundle.

## 3.4 Model routing and rate-limit handling

- `apps/web/src/server/openai/model-router.ts`
- `apps/web/src/server/openai/rate-limit.ts`

Current defaults:

- full: `gpt-5.2`
- small: `gpt-5-mini`
- nano: `gpt-5-nano`

Routing:

- autocomplete/ranking paths tend to use nano/small
- complex discoverer queries route to full

Rate-limit handling:

- detects 429/retry-after
- applies cooldown window in-memory
- degrades to fallback behavior when rate-limited

## 4) What the frontend currently does

Main workspace:

- `apps/web/src/components/targetgraph/decision-brief-workspace.tsx`

Behavior:

- Starts `useCaseRunStream()` immediately on page load.
- Also runs deep discoverer stream (`DeepDiscoverer`) and merges its entries into a single live narration feed.
- Graph panel (`PathFirstGraph` + `GraphCanvas`) is the primary visual.
- Final answer card shows either:
  - agent final answer (if present and non-empty), or
  - fallback/provisional template text from workspace logic.

Graph stack:

- `apps/web/src/components/targetgraph/path-first-graph.tsx`
- `apps/web/src/components/targetgraph/graph-canvas.tsx`

Current graph features:

- active path highlighting
- washed path rendering
- bridge status badges (`connected` / `gap` / `pending`)
- hover panels for node/edge metadata
- right-click neighborhood focus
- shift-click shortest path between two nodes
- fullscreen + export image

## 5) Best practices currently evidenced in code

These are actually present in code now:

1. Streaming long jobs via SSE for incremental UI updates.
2. One-active-run-per-session guard + explicit interrupt endpoint.
3. Fail-soft degradation (partial result streaming when sources/LLM degrade).
4. OpenAI 429 detection with retry-after based cooldown.
5. Cost-tier model routing (`full`/`mini`/`nano`) by task complexity.
6. Tool timeouts and agent timeouts to avoid infinite hangs.
7. Cached query-plan/entity-bundle paths for repeated queries.
8. Playwright regression scripts in `scripts/` for live UX checks.

## 6) What is still problematic (observed in this conversation)

These are not hypothetical; they were repeatedly observed in screenshots/logs:

1. Final verdict text can still read like templated mechanistic boilerplate instead of a true free-form scientific answer.
2. Graph often fails to show convincing intermediate bridge nodes for user-asked anchor-to-anchor paths.
3. Some runs still show unresolved/gap-heavy outputs even when known biology should allow better multihop explanation.
4. The final answer is not consistently grounded in explicit claim-level citations (references exist but linkage to statements is weak).
5. Live narration quality is better than before but still can feel repetitive/operational rather than scientific narrative.
6. Bridge displays may show direct-looking anchor links while expected intermediate hops remain unclear.
7. There are still remnants of older deterministic brief-generation logic competing with agentic synthesis.

## 7) Known architecture mismatch currently in repo

Current UX is hybrid:

- `runCaseStream` deterministic pipeline drives core stream/brief.
- `agentDiscover` runs in parallel and feeds narration/extra patches.

Result:

- Even with subagent architecture added, final user-visible answer path is not fully agent-owned.
- This is why verdict language can still look formulaic even when agent traces are present.

## 8) Potentially stale or inconsistent docs/config notes

From code vs docs comparison:

1. README still documents old mode language in places, while `runCaseStream` now uses single mode (`multihop`) in code.
2. README and runtime defaults can diverge (example: OpenAI small model defaults now in `config.ts` are mini/nano aware).
3. Legacy API descriptions in README may not exactly match current route behavior after refactors.

## 9) Commands currently available

From root `package.json`:

- `npm run dev:web`
- `npm run build:web`
- `npm run lint:web`
- `npm run services:up`
- `npm run services:down`
- `npm run test:ui-regression`
- `npm run test:e2e-gate`

## 10) Practical handoff summary

If continuing from this point, the key technical task is:

- Consolidate to a single truly agent-driven answer path (planner -> subagents -> evidence graph -> final scientific synthesis), and demote/remove deterministic brief templating that currently overrides or bypasses agent synthesis quality.

The codebase already contains:

- multi-agent scaffolding,
- tool integrations,
- live graph infrastructure,
- SSE session control,

but still needs tighter integration so the final explanation and graph bridge quality reflect the agent’s actual multihop reasoning rather than legacy deterministic templates.
