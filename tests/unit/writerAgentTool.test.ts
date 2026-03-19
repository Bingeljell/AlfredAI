import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../../src/runs/runStore.js";
import { toolDefinition as writerAgentTool } from "../../src/tools/definitions/writerAgent.tool.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { LeadAgentToolContext } from "../../src/tools/types.js";
import type { LlmProvider, LlmTextRequest, LlmTextResult } from "../../src/provider/types.js";

class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly textRequests: LlmTextRequest[] = [];
  private readonly textResponses: Array<{ content?: string; failureCode?: string; failureClass?: string; failureMessage?: string }> = [];

  enqueueText(response: { content?: string; failureCode?: string; failureClass?: string; failureMessage?: string }): void {
    this.textResponses.push(response);
  }

  async generateStructured(): Promise<never> {
    throw new Error("generateStructured should not be used by writer_agent");
  }

  async generateWithTools(): Promise<never> {
    throw new Error("generateWithTools should not be used by writer_agent");
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResult> {
    this.textRequests.push(request);
    const next = this.textResponses.shift();
    if (!next) {
      throw new Error("No fake text response queued");
    }
    if (next.content !== undefined) {
      return {
        provider: this.name,
        content: next.content
      };
    }
    return {
      provider: this.name,
      failureCode: next.failureCode,
      failureClass: next.failureClass as never,
      failureMessage: next.failureMessage
    };
  }
}

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
    getResearchSourceCards: () => state.researchSourceCards ?? []
  };
}

test("writer_agent creates fallback draft without persisting when no provider is configured", async () => {
  const workspace = await createTempWorkspace("alfred-writer-no-provider");
  const runStore = new RunStore(workspace);

  const output = await writerAgentTool.execute(
    {
      instruction: "Write a short launch memo about Alfred's capabilities.",
      format: "memo",
      maxWords: 180,
      outputPath: "artifacts/draft.md"
    },
    buildToolContext(workspace, runStore)
  );

  assert.equal(output.fallbackUsed, true);
  assert.equal(output.outputPath, null);
  assert.equal(output.persistedFallbackDraft, false);
  assert.equal(output.draftQuality, "placeholder");
  await assert.rejects(() => readFile(path.join(workspace, "artifacts/draft.md"), "utf8"), /ENOENT/);
});

test("writer_agent respects overwrite=false and errors on existing file", async () => {
  const workspace = await createTempWorkspace("alfred-writer-overwrite");
  const artifactsDir = path.join(workspace, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "draft.md"), "existing", "utf8");

  const runStore = new RunStore(workspace);
  const context = buildToolContext(workspace, runStore);
  const provider = new FakeLlmProvider();
  context.llmProviders = [provider];
  provider.enqueueText({
    content: [
      "# Update",
      "",
      Array.from({ length: 60 }, () => "A grounded update sentence with evidence [S1].").join(" "),
      "",
      "## References",
      "[S1] Source one — https://example.com/1"
    ].join("\n")
  });
  context.state.researchSourceCards = [
    {
      url: "https://example.com/1",
      title: "Source one",
      date: "2026-03-16",
      claim: "Source one confirms the update.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];
  await assert.rejects(
    () =>
      writerAgentTool.execute(
        {
          instruction: "Write an update note.",
          outputPath: "artifacts/draft.md",
          overwrite: false
        },
        context
      ),
    /overwrite=false/
  );
});

test("writer_agent emits generate and persist stage events", async () => {
  const workspace = await createTempWorkspace("alfred-writer-stage-events");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "writer stage test", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);
  const provider = new FakeLlmProvider();
  context.llmProviders = [provider];
  provider.enqueueText({
    content: [
      "# AI Trends",
      "",
      "A grounded note on current AI trends [S1].",
      "",
      "## References",
      "[S1] Source one — https://example.com/1"
    ].join("\n")
  });
  context.state.researchSourceCards = [
    {
      url: "https://example.com/1",
      title: "Source one",
      date: "2026-03-16",
      claim: "Source one confirms the trend.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];

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
  assert.ok(writerStages.some((event) => (event.payload as { stage?: string; status?: string }).stage === "generate"));
  assert.ok(writerStages.some((event) => (event.payload as { stage?: string; status?: string }).stage === "persist"));
});

test("writer_agent preserves an existing complete draft instead of downgrading it", async () => {
  const workspace = await createTempWorkspace("alfred-writer-preserve-complete");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "writer preserve test", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);
  const provider = new FakeLlmProvider();
  context.llmProviders = [provider];
  provider.enqueueText({
    content: [
      "# Draft revision",
      "",
      Array.from({ length: 20 }, (_, index) =>
        `Useful supporting sentence ${index + 1} with grounded evidence [S1][S2].`
      ).join(" ")
    ].join("\n")
  });
  context.state.researchSourceCards = [
    {
      url: "https://example.com/1",
      title: "Source one",
      date: "2026-03-16",
      claim: "Source one confirms the draft.",
      quote: null,
      sourceTool: "web_fetch"
    },
    {
      url: "https://example.com/2",
      title: "Source two",
      date: "2026-03-16",
      claim: "Source two confirms the draft.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];

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

  const events = await runStore.listRunEvents(run);
  const downgradeEvent = events.find((event) =>
    event.eventType === "writer_stage"
    && (event.payload as { stage?: string; reason?: string }).stage === "persist"
    && (event.payload as { stage?: string; reason?: string }).reason === "quality_downgrade_prevented"
  );
  assert.ok(downgradeEvent);
});

test("writer_agent blocks placeholder persistence when deadline budget is insufficient", async () => {
  const workspace = await createTempWorkspace("alfred-writer-budget-blocked");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "writer deadline test", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);
  context.openAiApiKey = "test-key";
  context.deadlineAtMs = Date.now() + 2_000;
  context.state.researchSourceCards = [
    {
      url: "https://example.com/source",
      title: "Example Source",
      date: "2026-03-16",
      claim: "Example grounded claim for writing.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];

  const output = await writerAgentTool.execute(
    {
      instruction: "Write a concise cited note from the source.",
      format: "memo",
      maxWords: 220,
      outputPath: "artifacts/budget.md"
    },
    context
  );

  assert.equal(output.draftQuality, "placeholder");
  assert.equal(output.persistedFallbackDraft, false);
  assert.equal(output.outputPath, null);
  await assert.rejects(() => readFile(path.join(workspace, "artifacts/budget.md"), "utf8"), /ENOENT/);
});

test("writer_agent generates a complete ranked list in one pass and persists it", async () => {
  const workspace = await createTempWorkspace("alfred-writer-ranked-list");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-ranked", "writer ranked list", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);
  const provider = new FakeLlmProvider();
  context.llmProviders = [provider];
  context.state.researchSourceCards = [
    {
      url: "https://example.com/game-a",
      title: "Game A",
      date: "2026-03-10",
      claim: "Game A supports 1-4 players and local plus online co-op.",
      quote: null,
      sourceTool: "web_fetch"
    },
    {
      url: "https://example.com/game-b",
      title: "Game B",
      date: "2026-03-11",
      claim: "Game B is family-friendly and released on PC in 2026.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];
  provider.enqueueText({
    content: [
      "# Top 2 PC Co-op Games for Families",
      "",
      "1. Game A: Great for siblings because it mixes light puzzles with co-op teamwork [S1]. It works well for mixed-age groups, has forgiving onboarding, and supports quick sessions for weeknights. Players and modes: 1-4 players; local and online co-op [S1]. Cautions: Mild fantasy combat.",
      "",
      "2. Game B: Strong pick for mixed-age groups thanks to forgiving controls [S2]. It is easier for younger children to understand, has a clearer objective loop, and remains fun even when parents jump in for short sessions. Players and modes: 1-4 players; online co-op [S2]. Cautions: In-game chat should be supervised.",
      "",
      "## References",
      "[S1] Game A — https://example.com/game-a",
      "[S2] Game B — https://example.com/game-b"
    ].join("\n")
  });

  const output = await writerAgentTool.execute(
    {
      instruction: "Give me the top 2 PC-first games to play with children, ranked, with players and cautions.",
      format: "notes",
      outputShapeHint: "ranked_list",
      maxWords: 420,
      outputPath: "artifacts/ranked.md"
    },
    context
  );

  assert.equal(output.outputShape, "ranked_list");
  assert.equal(output.deliverableStatus, "complete");
  assert.equal(output.draftQuality, "complete");
  assert.equal(output.fallbackUsed, false);
  assert.equal(provider.textRequests.length, 1);
  assert.match(provider.textRequests[0]?.messages[1]?.content ?? "", /Deliverable shape: ranked_list/);

  const written = await readFile(path.join(workspace, "artifacts/ranked.md"), "utf8");
  assert.match(written, /Top 2 PC Co-op Games for Families/);
  assert.match(written, /Game A/);
});
