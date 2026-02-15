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
PUBMED_MCP_URL=http://localhost:8000/mcp

PHASE_TIMEOUT_MS=12000
STRING_CONFIDENCE_DEFAULT=0.7
STRING_MAX_ADDED_NODES=180
STRING_MAX_ADDED_EDGES=500
STRING_MAX_NEIGHBORS_PER_SEED=15
CACHE_TTL_MS=300000
OPENAI_MODEL=gpt-5.2
OPENAI_SMALL_MODEL=gpt-5.2
STREAM_RANKING_TIMEOUT_MS=10000
STREAM_P5_BUDGET_MS=10000
STREAM_P5_PER_TARGET_TIMEOUT_MS=3500
STREAM_MAX_LITERATURE_TARGETS=5
```

## Local Commands

- `npm run dev:web` - start Next.js app.
- `npm run lint:web` - lint web code.
- `npm run build:web` - production build.
- `npm run services:up` - start MCP services via Docker.
- `npm run services:down` - stop MCP services.
- `npm run test:ui-regression` - run Chromium live UX regression across challenge queries.
- `./scripts/check-services.sh` - health checks on local ports.

## Brief-First API Surface

### `GET /api/resolveDisease?query=...`

Disease-only entity resolver used by landing and brief workspace:

- Returns `selected`, `candidates`, `rationale`
- Restricts to disease entity namespaces (`EFO`, `MONDO`, `ORPHANET`, `DOID`, `HP`)
- Uses semantic ranking + lexical guardrails to avoid non-disease variants (for example biomarker/measurement entities)

### `GET /api/runCaseStream?query=...&mode=fast|balanced|deep[&diseaseId=...]`

Decision-brief streaming endpoint consumed by `/brief`:

- `query_plan` - typed anchor/entity/constraint plan built from resolver-native candidates
- `entity_candidates` - raw candidate anchors and unresolved mentions
- `resolver_candidates` - disease candidates surfaced before run starts
- `resolver_selected` - selected disease entity + rationale
- `status` - step status, counts, source health, completion
- `agent_step` - natural-language timeline entries for user explainability
- `graph_patch` - incremental node/edge updates for mechanism graph
- `path_update` - currently strongest mechanism thread for graph focus
- `brief_section` - recommendation + assembled brief sections
- `done` - run completion event
- `error` - recoverable/non-recoverable failures

Modes:

- `fast`: smallest target set for speed
- `balanced`: default depth with interaction context
- `deep`: densest run with literature/trial enrichment

### `GET /api/streamGraph?diseaseQuery=...&maxTargets=...`

Low-level pipeline endpoint still available for internal orchestration and compatibility.

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

## Deep Discoverer API

`GET /api/agentDiscover?diseaseQuery=...&question=...&diseaseId=...`

SSE events:

- `status` - workflow bootstrapping state.
- `journey` - live agent journey entries (tool start/result, source, entities).
- `subagent_start` - explicit specialist subagent starts.
- `subagent_result` - structured handoff payload from specialist subagents.
- `followup_question_spawned` - targeted multihop follow-up generated during run.
- `branch_update` - branch state update (active/candidate/discarded).
- `final` - consolidated readout (answer, biomedical case, focus thread, caveats, next actions).
- `done` - elapsed time.

Implementation uses LangGraph/LangChain agent middleware with DeepAgents-style subagent delegation:

- `pathway_mapper` (mechanism mapping)
- `translational_scout` (compound/tractability scouting)
- Optional PubMed MCP enrichment (`PUBMED_MCP_URL`) for explicit literature branching in live journey updates.

## Agentic Architecture

Current architecture is orchestrator-first with typed handoffs:

1. Query planner resolves mixed entity anchors and constraints using resolver-native candidates (no hardcoded biomedical dictionaries).
2. Orchestrator delegates parallel specialist retrieval (`pathway_mapper`, `translational_scout`) plus deterministic fallbacks.
3. Tool outputs can spawn follow-up tasks; branch state is streamed as active/candidate/discarded.
4. Intermediate results are emitted as both:
   - textual journey/handoff events
   - live graph deltas and path updates in the mechanism canvas.

Reference docs used for architecture decisions:

- DeepAgents: https://docs.deepagents.dev/
- LangGraph multi-agent: https://langchain-ai.github.io/langgraph/concepts/multi_agent/
- Anthropic agent engineering patterns: https://www.anthropic.com/engineering/building-effective-agents

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
- Decision brief stream checks across 5 diseases ✅
  - Canonical disease resolution observed (`MONDO_0004975`, `EFO_0003060`, `EFO_0000685`, `EFO_0000384`, `EFO_0000222`)
  - `P6: Build complete` status observed in all runs
- Direct MCP endpoint checks ✅
  - OpenTargets: `http://127.0.0.1:7010/mcp`
  - Reactome: `http://127.0.0.1:7020/mcp`
  - STRING: `http://127.0.0.1:7030/mcp`
  - ChEMBL: `http://127.0.0.1:7040/mcp`
  - BioMCP: `http://127.0.0.1:8000/mcp`
  - Verified by direct tool calls (`search_diseases`, `find_pathways_by_gene`, `get_interaction_network`, `search_targets`, `article_searcher`, `trial_searcher`)

Recent observed timings (balanced mode, February 11, 2026):

- API stream completion across 5 diseases: ~25s to ~29s
- Typical bottlenecks: P5 (BioMCP literature/trial enrichment), P6 (OpenAI narrative refinement with timeout fallback)
- Agent discoverer run observed: ~53s end-to-end for a full delegated workflow

Runtime validation with live MCP services depends on your local Docker runtime and API/network availability.
