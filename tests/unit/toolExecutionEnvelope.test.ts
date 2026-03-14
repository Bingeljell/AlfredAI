import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { executeToolWithEnvelope } from "../../src/agent/tools/registry.js";
import type { LeadAgentToolContext, LeadAgentToolDefinition } from "../../src/agent/types.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

function makeToolContext(runStore: RunStore): LeadAgentToolContext {
  return {
    runId: "run-1",
    sessionId: "session-1",
    message: "test",
    deadlineAtMs: Date.now() + 60_000,
    policyMode: "trusted",
    projectRoot: process.cwd(),
    runStore,
    searchManager: {} as LeadAgentToolContext["searchManager"],
    workspaceDir: process.cwd(),
    defaults: {
      searchMaxResults: 15,
      subReactMaxPages: 8,
      subReactBrowseConcurrency: 3,
      subReactBatchSize: 4,
      subReactLlmMaxCalls: 6,
      subReactMinConfidence: 0.6
    },
    leadPipelineExecutor: async () =>
      ({
        leads: [],
        cancelled: false,
        llmCallsUsed: 0,
        llmCallsRemaining: 0,
        llmUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          callCount: 0
        },
        requestedLeadCount: 0,
        rawCandidateCount: 0,
        validatedCandidateCount: 0,
        finalCandidateCount: 0,
        queryCount: 0,
        pagesVisited: 0,
        deficitCount: 0,
        sizeRangeRequested: undefined,
        sizeMatchBreakdown: {
          in_range: 0,
          near_range: 0,
          unknown: 0,
          out_of_range: 0
        },
        relaxModeApplied: false,
        strictMinConfidence: 0.6,
        effectiveMinConfidence: 0.6,
        searchFailureCount: 0,
        searchFailureSamples: [],
        browseFailureCount: 0,
        browseFailureSamples: []
      }) as Awaited<ReturnType<LeadAgentToolContext["leadPipelineExecutor"]>>,
    state: {
      leads: [],
      artifacts: [],
      requestedLeadCount: 0,
      fetchedPages: [],
      shortlistedUrls: []
    },
    isCancellationRequested: async () => false,
    addLeads: () => ({ addedCount: 0, totalCount: 0 }),
    addArtifact: () => {},
    setFetchedPages: () => {},
    getFetchedPages: () => [],
    setShortlistedUrls: () => {},
    getShortlistedUrls: () => []
  };
}

test("executeToolWithEnvelope returns standardized success envelope and persists tool call", async () => {
  const workspace = await createTempWorkspace("tool-envelope-success");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "test", "running");
  const context = makeToolContext(runStore);
  context.runId = run.runId;

  const schema = z.object({ value: z.string().min(1) });
  const tool: LeadAgentToolDefinition<typeof schema> = {
    name: "sample_tool",
    description: "sample",
    inputSchema: schema,
    inputHint: "sample",
    async execute(input) {
      return {
        echoed: input.value
      };
    }
  };

  const result = await executeToolWithEnvelope({
    toolName: "sample_tool",
    inputJson: JSON.stringify({ value: "hello" }),
    tools: new Map([[tool.name, tool]]),
    context,
    runStore,
    runId: run.runId
  });

  assert.equal(result.status, "ok");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.inputRepairApplied, false);
  assert.equal(result.inputRepairStrategy, null);
  assert.deepEqual(result.input, { value: "hello" });
  assert.deepEqual(result.result, { echoed: "hello" });
  assert.equal(result.error, null);

  const updatedRun = await runStore.getRun(run.runId);
  assert.equal(updatedRun?.toolCalls.length, 1);
  assert.equal(updatedRun?.toolCalls[0]?.toolName, "sample_tool");
  assert.equal(updatedRun?.toolCalls[0]?.status, "ok");
});

test("executeToolWithEnvelope blocks approval-gated tools with standardized error envelope", async () => {
  const workspace = await createTempWorkspace("tool-envelope-approval");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "test", "running");
  const context = makeToolContext(runStore);
  context.runId = run.runId;

  const schema = z.object({ command: z.string().min(1) });
  const tool: LeadAgentToolDefinition<typeof schema> = {
    name: "dangerous_tool",
    description: "danger",
    inputSchema: schema,
    inputHint: "danger",
    requiresApproval: true,
    async execute() {
      throw new Error("should_not_execute");
    }
  };

  const result = await executeToolWithEnvelope({
    toolName: "dangerous_tool",
    inputJson: JSON.stringify({ command: "rm -rf /" }),
    tools: new Map([[tool.name, tool]]),
    context,
    runStore,
    runId: run.runId
  });

  assert.equal(result.status, "error");
  assert.equal(result.requiresApproval, true);
  assert.equal(result.inputRepairApplied, false);
  assert.equal(result.inputRepairStrategy, null);
  assert.equal(result.error, "approval_required_not_supported");

  const updatedRun = await runStore.getRun(run.runId);
  assert.equal(updatedRun?.toolCalls.length, 0);
});

test("executeToolWithEnvelope auto-repairs markdown-fenced JSON input", async () => {
  const workspace = await createTempWorkspace("tool-envelope-repair");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "test", "running");
  const context = makeToolContext(runStore);
  context.runId = run.runId;

  const schema = z.object({ value: z.string().min(1) });
  const tool: LeadAgentToolDefinition<typeof schema> = {
    name: "sample_tool",
    description: "sample",
    inputSchema: schema,
    inputHint: "sample",
    async execute(input) {
      return {
        echoed: input.value
      };
    }
  };

  const result = await executeToolWithEnvelope({
    toolName: "sample_tool",
    inputJson: "```json\n{\"value\":\"hello\"}\n```",
    tools: new Map([[tool.name, tool]]),
    context,
    runStore,
    runId: run.runId
  });

  assert.equal(result.status, "ok");
  assert.equal(result.inputRepairApplied, true);
  assert.equal(result.inputRepairStrategy, "strip_markdown_fence");
  assert.deepEqual(result.input, { value: "hello" });
});

test("executeToolWithEnvelope repairs search-style query aliases into schema-compliant input", async () => {
  const workspace = await createTempWorkspace("tool-envelope-search-shape-repair");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "test", "running");
  const context = makeToolContext(runStore);
  context.runId = run.runId;

  const schema = z.object({
    query: z.string().min(1),
    maxResults: z.number().int().positive().optional()
  });
  const tool: LeadAgentToolDefinition<typeof schema> = {
    name: "search",
    description: "search",
    inputSchema: schema,
    inputHint: "search",
    async execute(input) {
      return {
        echoed: input
      };
    }
  };

  const result = await executeToolWithEnvelope({
    toolName: "search",
    inputJson: JSON.stringify({ queries: ["managed service provider usa"], numResults: 5 }),
    tools: new Map([[tool.name, tool]]),
    context,
    runStore,
    runId: run.runId
  });

  assert.equal(result.status, "ok");
  assert.equal(result.inputRepairApplied, true);
  assert.match(result.inputRepairStrategy ?? "", /tool_shape_repair_query/);
  assert.deepEqual(result.input, {
    queries: ["managed service provider usa"],
    numResults: 5,
    query: "managed service provider usa",
    maxResults: 5
  });
});

test("executeToolWithEnvelope coerces plain string input for writer_agent", async () => {
  const workspace = await createTempWorkspace("tool-envelope-writer-plain-string");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "test", "running");
  const context = makeToolContext(runStore);
  context.runId = run.runId;

  const schema = z.object({ instruction: z.string().min(8) });
  const tool: LeadAgentToolDefinition<typeof schema> = {
    name: "writer_agent",
    description: "writer",
    inputSchema: schema,
    inputHint: "writer",
    async execute(input) {
      return {
        echoed: input.instruction
      };
    }
  };

  const result = await executeToolWithEnvelope({
    toolName: "writer_agent",
    inputJson: "Write a concise test memo with two bullets.",
    tools: new Map([[tool.name, tool]]),
    context,
    runStore,
    runId: run.runId
  });

  assert.equal(result.status, "ok");
  assert.equal(result.inputRepairApplied, true);
  assert.equal(result.inputRepairStrategy, "coerce_plain_instruction");
  assert.deepEqual(result.input, {
    instruction: "Write a concise test memo with two bullets."
  });
});

test("executeToolWithEnvelope repairs web_fetch query/url aliases and noisy URL payloads", async () => {
  const workspace = await createTempWorkspace("tool-envelope-web-fetch-shape-repair");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "test", "running");
  const context = makeToolContext(runStore);
  context.runId = run.runId;

  const schema = z
    .object({
      query: z.string().min(2).max(400).optional(),
      urls: z.array(z.string().url()).max(30).optional(),
      useStoredUrls: z.boolean().optional(),
      maxPages: z.number().int().min(1).max(25).optional()
    })
    .refine((value) => Boolean(value.query || value.useStoredUrls || (value.urls && value.urls.length > 0)));

  const tool: LeadAgentToolDefinition<typeof schema> = {
    name: "web_fetch",
    description: "fetch",
    inputSchema: schema,
    inputHint: "fetch",
    async execute(input) {
      return {
        echoed: input
      };
    }
  };

  const result = await executeToolWithEnvelope({
    toolName: "web_fetch",
    inputJson: JSON.stringify({
      queries: ["latest ai policy updates"],
      urls: [
        "https://example.com/article-1%22,%22snippet%22:%22hello",
        "https://example.com/article-2"
      ],
      pageLimit: 8
    }),
    tools: new Map([[tool.name, tool]]),
    context,
    runStore,
    runId: run.runId
  });

  assert.equal(result.status, "ok");
  assert.equal(result.inputRepairApplied, true);
  assert.match(result.inputRepairStrategy ?? "", /tool_shape_repair_query/);
  assert.match(result.inputRepairStrategy ?? "", /tool_shape_repair_urls/);
  assert.match(result.inputRepairStrategy ?? "", /tool_shape_repair_max_pages/);
  assert.deepEqual(result.input, {
    queries: ["latest ai policy updates"],
    urls: ["https://example.com/article-1", "https://example.com/article-2"],
    pageLimit: 8,
    query: "latest ai policy updates",
    maxPages: 8
  });
});
