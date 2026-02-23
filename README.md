# <img src="dendrite.png" alt="Dendrite logo" width="34" valign="middle" /> Dendrite

Dendrite is an open-source, agentic biomedical discovery workbench.
It converts a natural-language research question into:

- a live, evidence-attributed graph (diseases, targets, pathways, compounds, exposures)
- a mechanism-focused synthesis with citations, caveats, and next-step suggestions

This project is for research synthesis and hypothesis generation only. It is not for clinical decision-making.

## What Dendrite Does

- Resolves query entities and relations from free text.
- Runs multi-hop retrieval across OpenTargets, Reactome, STRING, ChEMBL, PubMed/BioMCP, and Medical MCP.
- Streams run progress, warnings, and graph updates in real time.
- Preserves uncertainty: partial/contested connections remain visible instead of being overstated.
- Supports replayable canned runs for demos without requiring a live OpenAI key.

## System Overview

- `apps/web`: Next.js app (UI + API orchestration routes).
- `services/*`: MCP services used as biomedical data providers.
- `docker-compose.yml`: local orchestration for MCP services and the web app.
- `scripts/bootstrap-services.sh`: clones/builds missing service repos.
- `scripts/check-services.sh`: quick endpoint/health checks.

## Requirements

- Node.js `>=20`
- npm `>=10`
- Docker + Docker Compose
- OpenAI API key for live agentic runs (optional for replay mode)

## Quick Start

### 1) Configure environment

```bash
cp .env.example .env
```

### 2) Bootstrap service repos (first-time setup)

```bash
./scripts/bootstrap-services.sh
```

### 3) Start the full stack in Docker

```bash
docker compose up --build -d web
```

`web` depends on MCP services, so this brings up the full stack.

### 4) Open the app

- `http://localhost:3000`

## Local Web Development (optional)

If you want hot reload in `apps/web`:

1. Start only MCP backends in Docker.
2. Run the Next.js app locally.

```bash
docker compose up --build -d mcp-opentargets mcp-reactome mcp-string mcp-chembl mcp-pubmed mcp-medical biomcp
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

## Configuration

Core variables (see `.env.example` for the full list):

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
```

`MCP_TRANSPORT_MODE` values:

- `auto` (default)
- `prefer_mcp`
- `fallback_only`

## Deployment (Vercel)

Use `apps/web` as the Vercel project root:

1. Import repository in Vercel.
2. Set Root Directory to `apps/web`.
3. Keep default Next.js commands (`npm ci`, `npm run build`).
4. Set environment variables needed for your deployment.

Notes:

- Local MCP URLs (`localhost`) do not work on Vercel; configure externally reachable endpoints or use fallback transport.

## Validation

```bash
npm --prefix apps/web run lint
npm --prefix apps/web run build
./scripts/check-services.sh
```

## Contributing

1. Create a branch from `main`.
2. Keep changes focused and include tests/checks where relevant.
3. Open a pull request with a clear summary, risk notes, and validation steps.

## License

The Dendrite application code in this repository is licensed under Apache 2.0 (`LICENSE`).

Some directories under `services/` are upstream projects with their own licenses. Check each service directory for license details.
