# Alfred vs Specialist Agents

## Purpose
Define a strict boundary between Alfred (master orchestrator) and specialist agents so behavior stays agentic without hardcoded domain assumptions.

## Role Split
- `Alfred` (master agent):
  - Domain-agnostic orchestrator and chief-of-staff layer.
  - Interprets user intent, routes to a specialist workflow, tracks run state, and enforces policy/budget guardrails.
  - Owns persistent identity/persona and cross-session continuity.
  - Future scope includes non-lead workflows (writing, planning, ops, publishing, etc.).
- `LeadGenAgent` (specialist):
  - Focused only on lead-generation objectives.
  - Runs objective clarification first, then executes search/browse/extract/quality gating.
  - Uses user-provided constraints (industry, company type, geography, B2B/B2C/supplier orientation, contact requirements) instead of fixed vertical defaults.

## LeadGenAgent Contract
1. Clarify objective:
   - Produce an `objectiveBrief` before retrieval (summary + known constraints + missing constraints).
2. Plan and act:
   - Choose retrieval actions from observed outcomes, not fixed query templates.
3. Observe and adapt:
   - Replan based on failures/yield and budget mode.
4. Return:
   - Partial results are acceptable when guardrails are hit; failures must be explicit.

## Determinism Policy
- Deterministic components are guardrails only:
  - time budget
  - tool-call budget
  - LLM budget
  - hard safety policies
- Business assumptions must remain agentic:
  - no hardcoded SI/MSP or any default vertical
  - no hardcoded company archetype unless explicitly requested by user

## Current Implementation Notes
- Alfred currently routes to `LeadGenAgent` for lead requests.
- Prompt stack is runtime-composed (`master persona` + `lead domain` + `role prompt`), and refreshed each major step.
- `LeadGenAgent` now emits objective-clarification data in query expansion telemetry and uses generic fallback query generation when model planning fails.
