# Alfred Tool Contract

> Supersedes `agent_separation.md`. Alfred is a single agent — there is no LeadGenAgent or routing classifier. This document defines how tools fit into that model.

## Single-Agent Model

Alfred is one agent with one system prompt, one tool allowlist, and one agent loop. The model self-routes across all task types (research, writing, lead gen, ops, self-development) via the unified system prompt in `src/runtime/specialists.ts`.

There is no classifier, no orchestrator routing layer, and no specialist sub-agents.

## Tool Contract

Every tool is a pure function. It receives validated input and a context object; it returns a result. Tools own mechanics — they do not interpret user intent or make decisions about task direction.

```typescript
export const toolDefinition: LeadAgentToolDefinition<typeof InputSchema> = {
  name: "tool_name",
  description: "One sentence: what it does and when to call it.",
  inputSchema: InputSchema,
  async execute(input, context) {
    // context.state     — shared agent state (leads, artifacts, etc.)
    // context.runStore  — append events
    // context.deadlineAtMs — check before long operations
    return { result: "..." };
  }
};
```

Tools are auto-discovered from `src/tools/definitions/*.tool.ts`. To add a tool: create the file, export `toolDefinition`, add the tool name to `ALFRED_AGENT.toolAllowlist` in `src/runtime/specialists.ts`.

## What Tools May Not Do

- Interpret user intent or decide what the task is.
- Mutate the task brief or rewrite user requirements.
- Make routing decisions ("this should go to a different agent").
- Hold semantic state between turns (use `context.state` for mechanical state only).

## Determinism Policy

Deterministic code is limited to:
- Budget enforcement (time, tool calls, LLM calls)
- Schema validation (Zod, input repair)
- Safety policies (approval gates, path sandboxing)
- Persistence (run store, session store, CSV writes)

Deterministic logic must not become a source of semantic truth. If a heuristic is deciding what the user "really meant," that logic belongs in the system prompt, not in code.

## Brief Preservation

When Alfred performs a task with explicit user requirements (count, geography, company type, format), those requirements are immutable within the run unless the user changes them. Tools receive these via `context.state` and must not silently relax or reinterpret them.

Agentic freedom applies to tactics: search phrasing, tool choice, retry strategy, sequencing. Not to rewriting what the user asked for.
