# Alfred Writing Flow (JSON Control Plane + Plaintext Draft Plane)

This document captures the agreed runtime pattern for research -> writing tasks.

## Goals

- Keep user prompts loose ("research X and write an article").
- Keep control flow reliable and debuggable.
- Keep writing generation flexible and model-led (not schema-rigid prose).
- Prefer cheap revision before expensive re-research when gaps are small.

## End-to-end flow

1. User prompt arrives (plaintext).
2. Alfred planner decides the next action (JSON action envelope).
3. Retrieval tools run with typed JSON contracts (`search`, `web_fetch`).
4. Retrieved evidence is stored in run scratchpad/state (structured object).
5. Alfred calls writing model to generate article text (plaintext output).
6. Alfred persists draft to target file (`file_write` JSON contract).
7. Alfred runs completion checks:
   - deterministic checks first (word count, path exists, citation markers present),
   - optional model evaluator second (quality/faithfulness rubric as JSON result).
8. If checks fail:
   - if evidence is sufficient and gap is small, prefer revision pass,
   - if evidence is weak/missing, do targeted retrieval then rewrite/revise.
9. Alfred returns final answer with artifact path.

## JSON vs plaintext boundaries

Use JSON for control plane:

- planner actions (`respond` / `call_tool` / `delegate_agent`),
- tool input/output envelopes,
- run-state metrics and telemetry,
- completion/evaluation signals.

Use plaintext for draft plane:

- article content generation,
- article revision/editing pass output.

Rationale: this preserves reliable orchestration while avoiding brittle schema-constrained prose generation.

## Revision-first policy

When a draft exists but constraints are unmet (for example 753 words vs 800 minimum):

- do not default to full `search` + `web_fetch` + full rewrite,
- run a revision pass against existing draft and current evidence first,
- re-retrieve only when evidence deficiency is explicit.

## Clarification gate for ambiguous loose prompts

For highly ambiguous asks, Alfred should ask one focused clarification question before tool execution.

Example:

- User: "Research the Middle East war and write me an article."
- Alfred: "Do you want emphasis on geopolitical, humanitarian, or technology/AI dimensions, or should I balance all three?"

Rules:

- Max 1 clarification round before proceeding.
- If user says "you decide", Alfred proceeds with sensible defaults and states assumptions.

## Telemetry expectations for writing runs

Tool-level events should make writing non-black-box:

- writer attempt started/completed/failed,
- fallback/compact-retry indicator,
- persistence attempt/result,
- completion-gap summary (what is missing and why).

This is required to debug long runs without manually reconstructing behavior from raw JSON.
