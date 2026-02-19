# TargetGraph

TargetGraph is a Next.js biomedical discovery app that builds a live mechanism graph and a citation-grounded answer for complex multihop questions.

It is designed for research synthesis, not clinical decision-making.

## What It Does

- Resolves query anchors (diseases, targets, pathways, interventions).
- Streams graph evidence from OpenTargets, Reactome, STRING, ChEMBL, PubMed/BioMCP, and Medical MCP.
- Runs coordinator + specialist subagents (`pathway_mapper`, `translational_scout`, `bridge_hunter`, `literature_scout`).
- Produces a final answer with explicit mechanism thread, supporting evidence, caveats, and next actions.
- Marks partial anchor coverage when the active path does not include all primary anchors.

## Repo Layout

- `apps/web` - Next.js app (UI + API routes).
- `services/mcp-opentargets` - OpenTargets MCP server.
- `services/mcp-reactome` - Reactome MCP server.
- `services/mcp-string` - STRING MCP server.
- `services/mcp-chembl` - ChEMBL MCP server.
- `services/mcp-pubmed` - PubMed MCP server.
- `services/mcp-medical` - Medical MCP server (`jamesanz/medical-mcp`).
- `services/biomcp` - BioMCP.
- `scripts/bootstrap-services.sh` - Clones missing service repos and builds Node MCP services.
- `docker-compose.yml` - Local MCP orchestration.

## Connected MCPs

- OpenTargets MCP
- Reactome MCP
- STRING MCP
- ChEMBL MCP
- BioMCP
- PubMed MCP
- Medical MCP

Landing page tool chips now show a green/red health indicator per source using live sample probes from:
- `GET /api/mcpHealth`

Note: `mcp-medical` first boot is slower because the container installs Chromium dependencies and browser binaries for scraping-capable tools.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker + Docker Compose
- Python 3.10+ (optional if running BioMCP outside Docker)

## Quick Start (Local)

1. Configure environment:
```bash
cp .env.example .env
# set OPENAI_API_KEY
```

2. Bootstrap local services (clones missing repos + builds Node MCP services):
```bash
./scripts/bootstrap-services.sh
```

3. Start MCP stack:
```bash
docker compose up --build
```

4. Start web app:
```bash
npm --prefix apps/web install
npm --prefix apps/web run dev
```

5. Open:
- `http://localhost:3000`

## Core Env Vars

```bash
OPENAI_API_KEY=
MCP_TRANSPORT_MODE=auto

OPENTARGETS_MCP_URL=http://localhost:7010/mcp
REACTOME_MCP_URL=http://localhost:7020/mcp
STRING_MCP_URL=http://localhost:7030/mcp
CHEMBL_MCP_URL=http://localhost:7040/mcp
PUBMED_MCP_URL=http://localhost:7050/mcp
MEDICAL_MCP_URL=http://localhost:7060/mcp
BIOMCP_URL=http://localhost:8000/mcp
MEDICAL_MCP_ENABLE_JOURNAL_SCRAPE=0
```

`MCP_TRANSPORT_MODE`:
- `auto` (default)
- `prefer_mcp`
- `fallback_only` (recommended baseline for Vercel if MCP endpoints are not externally reachable)

`MEDICAL_MCP_ENABLE_JOURNAL_SCRAPE`:
- `0` (default): skips Google Scholar-style journal scraping calls from the app wrapper (more stable, fewer timeouts).
- `1`: enables journal scraping calls (requires fuller Chromium runtime dependencies in the medical MCP environment).

## Validation Commands

- Build/lint:
```bash
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

- Service health:
```bash
./scripts/check-services.sh
```

- API streaming audit (landing queries):
```bash
BASE_URL=http://localhost:3000 SSE_TIMEOUT_MS=420000 node scripts/audit-query-sse.mjs "What targets and pathways connect ALS to oxidative stress?"
BASE_URL=http://localhost:3000 SSE_TIMEOUT_MS=420000 node scripts/audit-query-sse.mjs "How might obesity lead to type 2 diabetes through inflammatory signaling?"
BASE_URL=http://localhost:3000 SSE_TIMEOUT_MS=420000 node scripts/audit-query-sse.mjs "Which mechanistic path could connect lupus, IL-6 signaling, and obesity?"
```

- UI screenshot capture (example runner):
```bash
TARGETGRAPH_BASE_URL=http://localhost:3000 TARGETGRAPH_UI_OUT=/tmp/targetgraph-ui-final-examples node scripts/ui-final-capture-examples.mjs
```

## Latest Landing-Query API Results (Feb 19, 2026)

Artifacts:
- `/tmp/targetgraph-ui-usability/sse-audit2-what-targets-and-pathways-connect-als-to-oxidative-stress-.json`
- `/tmp/targetgraph-ui-usability/sse-audit2-how-might-obesity-lead-to-type-2-diabetes-through-inflammatory-signaling-.json`
- `/tmp/targetgraph-ui-usability/sse-audit2-which-mechanistic-path-could-connect-lupus-il-6-signaling-and-obesity-.json`

Observed:
- All 3 runs emitted `final_answer`, `run_completed`, and `done`.
- Medical MCP was called in all 3 runs (`medicalToolCallCount > 0`).
- ALS and obesity queries returned fully connected anchor paths.
- Lupus/IL-6/obesity returned explicit partial-anchor signal:
  - `pathConnectedAcrossAnchors: false`
  - `unresolvedAnchorPairs: ["missing primary anchor: IL6"]`

This is intentional behavior: do not claim full anchor connectivity when IL-6 is unresolved in the active edge trail.

## Vercel Notes

For public deployment, do not rely on localhost MCP ports.

`MCP_TRANSPORT_MODE=fallback_only` means:
- MCP transport calls are disabled (no direct calls to `/mcp` tool servers from the web app runtime).
- The app uses built-in HTTP/API fallback paths for all integrated sources, including Medical evidence enrichment.
- If MCP endpoints are reachable, `auto`/`prefer_mcp` can still be used to prefer transport-backed tools.

Minimum stable public v1 path:
- Deploy `apps/web` as the Vercel project root.
- Set `MCP_TRANSPORT_MODE=fallback_only` in Vercel env vars.
- `OPENAI_API_KEY` on the server is optional if users provide their own key in the landing page input.
- If you want server-side key fallback, set `OPENAI_API_KEY` as well.
- Keep MCP service URLs unset or set them only when you have externally reachable MCP infra.

Timeout support:
- Long-running routes export `maxDuration = 800`:
  - `apps/web/src/app/api/runCaseStream/route.ts`
  - `apps/web/src/app/api/streamGraph/route.ts`
  - `apps/web/src/app/api/agentDiscover/route.ts`
- This does not change internal agent time budgets; it only raises the Vercel function ceiling.
- On Vercel, effective max duration is plan-dependent (Fluid Compute required for longest runs).

## Known Issues / Next Hardening

- Landing-page `Run analysis` enablement is tied to in-page key state; automation needs hydration-aware input handling.
- End-to-end runtimes increased (deep discoverer now contributes more). Expect several minutes on complex queries.
- Additional pre-publish hardening still recommended: remove dead code paths, tighten request limits/rate limiting, sanitize logs, and finalize external MCP networking strategy for Vercel.
