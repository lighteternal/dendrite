# TargetGraph

TargetGraph is a streamed systems graph application that answers:

> "When I type a disease, what are the highest-evidence targets, what pathways connect them, what drugs/compounds already touch them, and what interaction neighborhood suggests mechanistic plausibility—shown as a live, explorable systems graph?"

UI includes a non-clinical disclaimer: **"Research evidence summary — not clinical guidance."**

## Repository Layout

- `apps/web` - Next.js App Router + TypeScript frontend/backend.
- `services/mcp-opentargets` - OpenTargets MCP server (Augmented-Nature clone).
- `services/mcp-reactome` - Reactome MCP server (Augmented-Nature clone).
- `services/mcp-string` - STRING-db MCP server (Augmented-Nature clone).
- `services/mcp-chembl` - ChEMBL MCP server (Augmented-Nature clone).
- `services/biomcp` - BioMCP (GenomOncology clone).
- `docker-compose.yml` - Local service orchestration for all MCP services.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker + Docker Compose
- Python 3.10+ (only if running BioMCP outside Docker)

## Quick Start

1. Copy env template and add your key:
   - `cp .env.example .env`
   - Set `OPENAI_API_KEY=...`
2. Start MCP services:
   - `docker compose up --build`
3. In another terminal, run web app:
   - `npm --prefix apps/web install`
   - `npm --prefix apps/web run dev`
4. Open `http://localhost:3000`

## Environment Variables

```bash
OPENAI_API_KEY=...

OPENTARGETS_MCP_URL=http://localhost:7010/mcp
REACTOME_MCP_URL=http://localhost:7020/mcp
STRING_MCP_URL=http://localhost:7030/mcp
CHEMBL_MCP_URL=http://localhost:7040/mcp
BIOMCP_URL=http://localhost:8000/mcp

PHASE_TIMEOUT_MS=12000
STRING_CONFIDENCE_DEFAULT=0.7
STRING_MAX_ADDED_NODES=180
STRING_MAX_ADDED_EDGES=500
STRING_MAX_NEIGHBORS_PER_SEED=15
CACHE_TTL_MS=300000
OPENAI_MODEL=gpt-5.2
```

## Local Commands

- `npm run dev:web` - start Next.js app.
- `npm run lint:web` - lint web code.
- `npm run build:web` - production build.
- `npm run services:up` - start MCP services via Docker.
- `npm run services:down` - stop MCP services.
- `./scripts/check-services.sh` - health checks on local ports.

## Streamed Build Pipeline

`GET /api/streamGraph?diseaseQuery=...&maxTargets=20`

SSE events:

- `status` - phase updates, elapsed time, counts, source health.
- `partial_graph` - incremental graph node/edge waves.
- `sankey` - mechanism trail rows.
- `ranking` - strict JSON ranked targets.
- `enrichment_ready` - article/trial snippets linked to node IDs.
- `done` - final stats.
- `error` - recoverable/non-recoverable issues.

Pipeline phases:

1. Resolve disease
2. Fetch target evidence (OpenTargets MCP)
3. Add pathways (Reactome MCP)
4. Add drugs/activities (OpenTargets + ChEMBL MCP)
5. Add interactions (STRING MCP)
6. Add literature/trials (BioMCP)
7. Rank + narrative (OpenAI)

## Hypothesis Mode API

`POST /api/hypothesis`

Input includes selected pathway, slider weights, and evidence table.
Output includes:

- `recommendedTargets` (1 or 3)
- `mechanismThread` JSON (`claim`, `evidenceBullets`, `counterfactuals`, `caveats`, `nextExperiments`)
- `missingInputs`

## Decision and Scoring

Hypothesis score uses weighted linear model:

`HypothesisScore = w1*OpenTargetsEvidence + w2*DrugActionability + w3*NetworkCentrality + w4*LiteratureSupport`

Weights are derived from two sliders:

- Novelty ↔ Actionability
- Low safety risk ↔ High novelty tolerance

## Fail-Soft Behavior

If any source degrades, the app continues streaming partial data.
Source health is tracked in the stepper (`green/yellow/red`), and hypothesis mode still returns outputs with missing-input caveats.

## MCP Repositories and Docs

Required MCP servers:

- OpenTargets MCP Server: https://github.com/Augmented-Nature/OpenTargets-MCP-Server
- Reactome MCP Server: https://github.com/Augmented-Nature/Reactome-MCP-Server
- STRING-db MCP Server: https://github.com/Augmented-Nature/STRING-db-MCP-Server
- ChEMBL MCP Server: https://github.com/Augmented-Nature/ChEMBL-MCP-Server
- BioMCP: https://github.com/genomoncology/biomcp
- BioMCP docs: https://biomcp.org
- Augmented-Nature org index: https://github.com/Augmented-Nature

Primary APIs (credibility + fallbacks):

- Open Targets GraphQL: https://api.platform.opentargets.org/api/v4/graphql
- Reactome Content Service: https://reactome.org/ContentService/
- Reactome Content Service docs: https://reactome.org/dev/content-service
- STRING MCP endpoint (config target): https://mcp.string-db.org/
- STRING API docs: https://string-db.org/help/api/
- ChEMBL REST docs: https://chembl.github.io/chembl-restful-web-service-api/

## Credibility Note (Footer Requirement)

- Open Targets GraphQL endpoint: https://api.platform.opentargets.org/api/v4/graphql
- Reactome Content Service is the current supported API; legacy RESTful API is deprecated.

## Validation Status

Validated locally in this repository:

- `npm --prefix apps/web run lint` ✅
- `npm --prefix apps/web run build` ✅
- Chromium automation (Playwright) across 5 diseases ✅
  - Alzheimer disease
  - Non-small cell lung cancer
  - Rheumatoid arthritis
  - Crohn disease
  - Acute myeloid leukemia
  - Full pipeline completion observed on each run with no browser runtime errors

Recent observed timings (full profile enabled, `maxTargets=8`):

- API stream completion: ~3.6s to ~4.1s
- Browser-observed end-to-end completion: ~2.4s to ~2.6s (warm cache)

Runtime validation with live MCP services depends on your local Docker runtime and API/network availability.
