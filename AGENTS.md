# AGENTS.md

## Primary Intent
- Dendrite has required biomedical MCP dependencies at runtime for data retrieval and multi-hop discovery.
- Also use MCPs and related tooling to improve code quality and implementation decisions during development.


## Framework Best-Practice Rule
- For LangChain changes, look up current LangChain MCP adapter patterns and official guidance before implementing.
- For Cytoscape-related changes, consult Cytoscape MCP capabilities/docs before implementing integration logic.
- For browser automation and E2E tasks, prefer `playwright-cli` first; use Playwright MCP when persistent MCP browser context is specifically needed.

## Agentic Optimization Guardrail
- Never optimise discovery quality via lexical rules.
- Do not optimize discovery quality via hardcoded lexical/pattern rules tuned to specific benchmark prompts.
- Do not add case-specific keyword boosts/penalties (for example query-token hacks for individual diseases, genes, or drugs) to improve point performance.
- Improve quality through generalizable mechanisms: stronger evidence typing, better tool orchestration, semantic validation, and explicit uncertainty handling.

## Browser Automation Policy
- Prefer `playwright-cli` for coding-agent browser workflows (token-efficient, script-friendly).
- Use Playwright MCP (`playwright`) when persistent MCP-style browser context is explicitly needed.
- Keep browser runs scoped to the current task and capture screenshots/artifacts only when needed.


## Quick Start Checks
- Verify MCP registrations: `codex mcp list`
- Verify local services: `./scripts/check-services.sh`
- Start full local stack when needed: `npm run services:up`
