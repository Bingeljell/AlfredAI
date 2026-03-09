# Alfred vs Specialist Agents

## Purpose
Define a strict boundary between Alfred (master orchestrator) and specialist agents so behavior stays agentic without hardcoded domain assumptions.

## Role Split
- `Alfred` (master agent):
  - Domain-agnostic orchestrator and chief-of-staff layer.
  - Interprets user intent from live conversational context, routes to a specialist workflow, tracks run state, and enforces policy/budget guardrails.
  - Owns persistent identity/persona and cross-session continuity.
  - Future scope includes non-lead workflows (writing, planning, ops, publishing, etc.).
- `LeadGenAgent` (specialist):
  - Focused only on lead-generation objectives.
  - Receives a canonical objective brief from Alfred, then executes search/browse/extract/quality gating against that brief.
  - Uses user-provided requirements (industry, company type, geography, B2B/B2C/supplier orientation, contact requirements) instead of fixed vertical defaults.

## Context And Brief Model
- Alfred should use raw recent conversation directly for normal follow-up behavior.
- When Alfred decides to execute work, it produces a **canonical task brief** for the specialist.
- The canonical brief exists to keep downstream tools and specialist loops aligned; it is not a replacement for conversational context.
- Explicit user requirements in that brief are immutable unless the user changes them.

## LeadGenAgent Contract
1. Clarify objective:
   - Produce or refine an `objectiveBrief` before retrieval (summary + known requirements + missing requirements).
2. Plan and act:
   - Choose retrieval actions from observed outcomes, not fixed query templates.
3. Observe and adapt:
   - Replan based on failures/yield and budget mode, without silently mutating user requirements.
4. Return:
   - Partial results are acceptable when guardrails are hit; failures must be explicit.

## Determinism Policy
- Deterministic components are guardrails only:
  - time budget
  - tool-call budget
  - LLM budget
  - hard safety policies
- Contract preservation is deterministic:
  - explicit user requirements must survive delegation, tools, and replans unchanged
  - downstream components may validate the brief but must not reinterpret it independently
- Business assumptions must remain agentic:
  - no hardcoded SI/MSP or any default vertical
  - no hardcoded company archetype unless explicitly requested by user

## Current Implementation Notes
- Alfred currently routes to `LeadGenAgent` for lead requests.
- Prompt stack is runtime-composed (`master persona` + `lead domain` + `role prompt`), and refreshed each major step.
- `LeadGenAgent` now emits objective-clarification data in query expansion telemetry and uses generic fallback query generation when model planning fails.
- The next architecture step is to replace ad hoc parser-led intent handling with a model-produced canonical brief that downstream systems preserve exactly.
