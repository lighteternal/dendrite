# TargetGraph PRD: Multihop Biomedical Discovery

## 1. Product Goal
Deliver a single-mode biomedical search product that:
- resolves mixed biomedical entities from free-text queries,
- explores multihop evidence paths live,
- explains whether a mechanistic bridge exists (or does not),
- produces a concise, query-aligned answer instead of generic target cards.

## 2. Current Failures (Observed)
- Wrong anchor resolution for bridge queries (example: `latent` matched as `latent syphilis`).
- Drug-centric queries forced into unrelated diseases.
- UI summary/verdict language is generic and not query-aligned.
- Users cannot quickly understand if the system found a bridge vs. weak exploratory signal.

## 3. Design Principles
- No stopword-driven entity stripping for resolution decisions.
- Candidate-first entity linking:
  1. generate candidate spans,
  2. retrieve MCP candidates across disease/target/drug,
  3. arbitrate anchors using context and candidate evidence.
- Do not force a disease anchor when non-disease anchors dominate.
- Bridge queries must preserve both endpoints and report:
  - `connected` with active path, or
  - `no decisive bridge yet` with explicit gap.

## 4. Functional Requirements
- `FR1`: Query plan anchors must support disease, target, drug, pathway, phenotype combinations.
- `FR2`: Disease selection must be optional; concept-centric runs are valid.
- `FR3`: Relation queries (`connect/between/latent connection/...`) must not introduce off-query disease anchors.
- `FR4`: Top summary must answer the user query in plain scientific language.
- `FR5`: Verdict panel must be query-aligned, with confidence and caveats.
- `FR6`: Live graph and narration must stay synchronized and visible in one primary tab.

## 5. System Requirements
- `SR1`: One active run per session, explicit interrupt.
- `SR2`: Stream statuses and path updates every phase with deterministic fallback behavior.
- `SR3`: Structured telemetry for anchor selection, branch pruning, and final evidence coverage.

## 6. Acceptance Criteria
- `AC1`: `what is the latent connection between diabetes and weight loss` does not resolve to unrelated diseases.
- `AC2`: `explain paracetamol sideeffects` runs as concept-centric (drug/mechanism), not unrelated disease-first.
- `AC3`: Final UI answer mentions the user’s anchors and whether a bridge is established.
- `AC4`: Graph contains active path and washed branches with readable labels.
- `AC5`: End-to-end run completes with no silent idle state in normal conditions.

## 7. Implementation Workstreams
- `W1` Entity Resolution:
  - remove stopword-based disease trimming,
  - candidate-driven mention extraction,
  - disease-selection guardrails for non-disease queries.
- `W2` Run Orchestration:
  - constrain relation-anchored disease picks to current candidate pool,
  - prioritize typed disease anchors from query plan before fallback spans.
- `W3` UX/Answer Layer:
  - replace generic “Lead target/Pathway anchor/Decision” framing with:
    - query answer,
    - active thread,
    - evidence quality.
  - make verdict text query-aligned.
- `W4` Validation:
  - run Playwright query suite with screenshots and SSE trace capture.

## 8. Validation Queries
- `what is the latent connection between diabetes and weight loss`
- `which pathways connect il6 to rheumatoid arthritis`
- `explain paracetamol sideeffects`

## 9. References (Entity Linking Patterns)
- BioSyn (candidate generation + dense/sparse hybrid normalization):
  https://arxiv.org/abs/2005.00239
- SapBERT (self-alignment pretraining for biomedical entity linking):
  https://arxiv.org/abs/2010.11784
- SciSpaCy entity linker (candidate generation + ANN linking):
  https://github.com/allenai/scispacy
- PubTator Central (biomedical named entity annotation and normalization):
  https://www.ncbi.nlm.nih.gov/research/pubtator/
