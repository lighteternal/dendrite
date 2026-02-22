# <img src="dendrite.png" alt="Dendrite logo" width="34" valign="middle" /> Dendrite

Dendrite is an agentic biomedical discovery app that turns a free-text question into a live, explorable mechanism-hypothesis graph and an evidence-grounded synthesis.

It is for research synthesis and hypothesis generation, not clinical decision-making.

## What It Does

- Resolves entities from your query (diseases, targets, pathways, compounds, exposures).
- Runs multi-hop retrieval across OpenTargets, Reactome, STRING, ChEMBL, PubMed/BioMCP, and Medical MCP.
- Streams graph updates and execution logs while the run is in progress.
- Produces a final synthesis with inline citations, caveats, and suggested next experiments.
- Keeps unresolved or partial routes visible instead of forcing a false “complete mechanism.”

## How To Interpret Results

Dendrite links entities using heterogeneous evidence types, including:

- genetic/association evidence
- pathway membership
- protein-protein interaction
- drug-target activity
- literature-derived signals

Important interpretation rules:

- Multi-hop paths are treated as mechanistic hypotheses, not causal proof.
- Score/confidence values are ranking signals, not probabilities of truth.
- Causal direction should only be inferred when the cited evidence explicitly supports it.
- If coverage is partial, the run should state that explicitly in both graph context and synthesis caveats.

## Repository Layout

- `apps/web` - Next.js UI and API routes.
- `services/mcp-opentargets` - OpenTargets MCP.
- `services/mcp-reactome` - Reactome MCP.
- `services/mcp-string` - STRING MCP.
- `services/mcp-chembl` - ChEMBL MCP.
- `services/mcp-pubmed` - PubMed MCP.
- `services/mcp-medical` - Medical MCP (`jamesanz/medical-mcp`).
- `services/biomcp` - BioMCP.
- `scripts/bootstrap-services.sh` - Clones/builds local service dependencies.
- `docker-compose.yml` - Local MCP stack orchestration.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker + Docker Compose

## Quick Start (Local)

1. Configure environment:

```bash
cp .env.example .env
```

2. Bootstrap local services:

```bash
./scripts/bootstrap-services.sh
```

3. Start service stack:

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

## API Keys and Example Mode

- **Live runs** use an OpenAI API key from the landing page input (BYOK).
- **Run example** uses replay fixtures and does not consume new LLM tokens.

## Core Environment Variables

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
- `fallback_only` (useful when external MCP transport is unavailable)

## Deploying to Vercel

Recommended baseline:

1. Import the repo and set **Root Directory** to `apps/web` in Vercel project settings.
2. Use framework preset **Next.js** with:
   - Install Command: `npm ci`
   - Build Command: `npm run build`
   - Dev Command: `npm run dev`
   - Output Directory: `.next`
3. Keep BYOK enabled in the UI for end users.
4. If you want server-side fallback key support, also set `OPENAI_API_KEY`.
5. Set explicit MCP URLs only if you host externally reachable MCP services.

Notes:

- On Vercel, local loopback MCP transport is auto-disabled and HTTP/API fallbacks are used.
- Long-running API routes already export extended `maxDuration`; effective ceilings still depend on your Vercel plan/runtime.

## Operations and Health

- Landing page tool chips use `GET /api/mcpHealth`.
- Health semantics:
  - green: responding
  - amber: reachable but degraded/slow
  - red: unreachable

## Validation

```bash
npm --prefix apps/web run lint
npm --prefix apps/web run build
./scripts/check-services.sh
```

---

Preclinical evidence synthesis only; not for clinical recommendation.

## License

The core Dendrite application (agent logic, UI, and repository-owned code) is licensed under the Apache License 2.0.
MCP services under services/ are subject to their respective upstream licenses. See the individual service directories and upstream repositories for details.
