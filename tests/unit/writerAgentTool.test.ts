import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../../src/runs/runStore.js";
import { toolDefinition as writerAgentTool } from "../../src/agent/tools/definitions/writerAgent.tool.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { LeadAgentToolContext } from "../../src/agent/types.js";

function buildToolContext(workspace: string, runStore: RunStore, runId = "writer-run", sessionId = "session-1"): LeadAgentToolContext {
  const state: LeadAgentToolContext["state"] = {
    leads: [],
    artifacts: [],
    requestedLeadCount: 0,
    fetchedPages: [],
    researchSourceCards: []
  };
  return {
    runId,
    sessionId,
    message: "writer test",
    deadlineAtMs: Date.now() + 60_000,
    policyMode: "trusted" as const,
    projectRoot: workspace,
    runStore,
    searchManager: {} as never,
    workspaceDir: workspace,
    openAiApiKey: undefined,
    defaults: {
      searchMaxResults: 15,
      subReactMaxPages: 10,
      subReactBrowseConcurrency: 3,
      subReactBatchSize: 4,
      subReactLlmMaxCalls: 6,
      subReactMinConfidence: 0.6
    },
    leadPipelineExecutor: (async () => {
      throw new Error("not used");
    }) as never,
    state,
    isCancellationRequested: async () => false,
    addLeads: () => ({ addedCount: 0, totalCount: 0 }),
    addArtifact: (artifactPath) => {
      if (!state.artifacts.includes(artifactPath)) {
        state.artifacts.push(artifactPath);
      }
    },
    setFetchedPages: () => undefined,
    getFetchedPages: () => [],
    setResearchSourceCards: () => undefined,
    getResearchSourceCards: () => []
  };
}

test("writer_agent creates fallback draft and writes output file", async () => {
  const workspace = await createTempWorkspace("alfred-writer-tool");
  const docsDir = path.join(workspace, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "brief.md"), "Alfred helps teams execute reliably.", "utf8");

  const runStore = new RunStore(workspace);
  const output = await writerAgentTool.execute(
    {
      instruction: "Write a short launch memo about Alfred's capabilities.",
      format: "memo",
      maxWords: 180,
      contextPaths: ["docs/brief.md"],
      outputPath: "artifacts/draft.md"
    },
    buildToolContext(workspace, runStore)
  );

  assert.equal(output.fallbackUsed, true);
  assert.equal(output.outputPath, "artifacts/draft.md");
  assert.equal(output.persistedFallbackDraft, true);
  assert.ok((output.wordCount as number) > 0);

  const written = await readFile(path.join(workspace, "artifacts/draft.md"), "utf8");
  assert.match(written, /Draft unavailable:/);
});

test("writer_agent respects overwrite=false and errors on existing file", async () => {
  const workspace = await createTempWorkspace("alfred-writer-overwrite");
  const artifactsDir = path.join(workspace, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "draft.md"), "existing", "utf8");

  const runStore = new RunStore(workspace);
  await assert.rejects(
    () =>
      writerAgentTool.execute(
        {
          instruction: "Write an update note.",
          outputPath: "artifacts/draft.md",
          overwrite: false
        },
        buildToolContext(workspace, runStore)
      ),
    /overwrite=false/
  );
});

test("writer_agent fallback includes source-card context and reports sourceCardCount", async () => {
  const workspace = await createTempWorkspace("alfred-writer-source-cards");
  const runStore = new RunStore(workspace);
  const context = buildToolContext(workspace, runStore);
  context.state.researchSourceCards = [
    {
      url: "https://example.com/news/ai-policy",
      title: "AI policy updates",
      date: "2026-03-14",
      claim: "Regulators announced stricter disclosure requirements for foundation models.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];
  context.getResearchSourceCards = () => context.state.researchSourceCards ?? [];

  const output = await writerAgentTool.execute(
    {
      instruction: "Write a concise blog summary with one citation line.",
      format: "blog_post",
      maxWords: 220
    },
    context
  );

  assert.equal(output.fallbackUsed, true);
  assert.equal(output.draftQuality, "placeholder");
  assert.equal(output.sourceCardCount, 1);
  assert.match(String(output.content), /https:\/\/example.com\/news\/ai-policy/);
});

test("writer_agent persists to a session-scoped default path when outputPath is omitted", async () => {
  const workspace = await createTempWorkspace("alfred-writer-default-output");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-default", "writer default output", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);

  const output = await writerAgentTool.execute(
    {
      instruction: "Write a concise memo about Alfred's session memory behavior.",
      format: "memo",
      maxWords: 180
    },
    context
  );

  const expectedPath = `workspace/alfred/sessions/${run.sessionId}/outputs/${run.runId}-memo.md`;
  assert.equal(output.outputPath, expectedPath);
  assert.ok(context.state.artifacts.includes(expectedPath));

  const written = await readFile(path.join(workspace, expectedPath), "utf8");
  assert.match(written, /Draft unavailable:/);
});

test("writer_agent emits writer_stage trace events for attempt and persistence", async () => {
  const workspace = await createTempWorkspace("alfred-writer-stage-events");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "writer stage test", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);

  await writerAgentTool.execute(
    {
      instruction: "Write a short article draft about AI trends.",
      format: "blog_post",
      maxWords: 180,
      outputPath: "artifacts/stage.md"
    },
    context
  );

  const events = await runStore.listRunEvents(run);
  const writerStages = events.filter((event) => event.eventType === "writer_stage");
  assert.ok(writerStages.length >= 2);
  assert.ok(writerStages.some((event) => (event.payload as { stage?: string }).stage === "structured_attempt"));
  assert.ok(writerStages.some((event) => (event.payload as { stage?: string }).stage === "persist"));
});

test("writer_agent does not overwrite an existing complete draft with a placeholder fallback", async () => {
  const workspace = await createTempWorkspace("alfred-writer-preserve-complete");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "writer preserve test", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);

  const body = Array.from({ length: 110 }, (_, index) => `Evidence-backed sentence ${index + 1} [S${(index % 4) + 1}].`).join(" ");
  const existingDraft = [
    "# Existing Complete Draft",
    "",
    body,
    "",
    "## References",
    "[S1] Source one — https://example.com/1",
    "[S2] Source two — https://example.com/2",
    "[S3] Source three — https://example.com/3",
    "[S4] Source four — https://example.com/4"
  ].join("\n");

  const outputPath = path.join(workspace, "artifacts", "preserve.md");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, existingDraft, "utf8");

  const output = await writerAgentTool.execute(
    {
      instruction: "Write an updated article with citations.",
      format: "blog_post",
      maxWords: 480,
      outputPath: "artifacts/preserve.md"
    },
    context
  );

  const written = await readFile(outputPath, "utf8");
  assert.equal(written, existingDraft);
  assert.equal(output.draftQuality, "complete");
  assert.equal(output.fallbackUsed, false);
  assert.equal(output.outputPath, "artifacts/preserve.md");
  assert.equal(output.persistedFallbackDraft, false);

  const events = await runStore.listRunEvents(run);
  const downgradeEvent = events.find((event) =>
    event.eventType === "writer_stage"
    && (event.payload as { stage?: string; reason?: string }).stage === "persist"
    && (event.payload as { stage?: string; reason?: string }).reason === "quality_downgrade_prevented"
  );
  assert.ok(downgradeEvent);
});
