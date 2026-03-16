import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../../src/runs/runStore.js";
import { toolDefinition as writerAgentTool } from "../../src/agent/tools/definitions/writerAgent.tool.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { LeadAgentToolContext } from "../../src/agent/types.js";
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResult, LlmTextRequest, LlmTextResult } from "../../src/services/llm/types.js";

class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly structuredRequests: LlmStructuredRequest[] = [];
  readonly textRequests: LlmTextRequest[] = [];
  private readonly structuredResponses = new Map<string, Array<{ result?: unknown; failureCode?: string; failureClass?: string; failureMessage?: string }>>();
  private readonly textResponses: Array<{ content?: string; failureCode?: string; failureClass?: string; failureMessage?: string }> = [];

  enqueueStructured(
    schemaName: string,
    response: { result?: unknown; failureCode?: string; failureClass?: string; failureMessage?: string }
  ): void {
    const queue = this.structuredResponses.get(schemaName) ?? [];
    queue.push(response);
    this.structuredResponses.set(schemaName, queue);
  }

  enqueueText(response: { content?: string; failureCode?: string; failureClass?: string; failureMessage?: string }): void {
    this.textResponses.push(response);
  }

  async generateStructured<T>(request: LlmStructuredRequest, validator: { parse: (value: unknown) => T }): Promise<LlmStructuredResult<T>> {
    this.structuredRequests.push(request);
    const queue = this.structuredResponses.get(request.schemaName) ?? [];
    const next = queue.shift();
    this.structuredResponses.set(request.schemaName, queue);
    if (!next) {
      throw new Error(`No fake structured response queued for ${request.schemaName}`);
    }
    if (next.result !== undefined) {
      return {
        provider: this.name,
        result: validator.parse(next.result)
      };
    }
    return {
      provider: this.name,
      failureCode: next.failureCode,
      failureClass: next.failureClass as never,
      failureMessage: next.failureMessage
    };
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
  assert.equal(output.outputPath, null);
  assert.equal(output.persistedFallbackDraft, false);
  assert.ok((output.wordCount as number) > 0);
  await assert.rejects(() => readFile(path.join(workspace, "artifacts/draft.md"), "utf8"), /ENOENT/);
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
  assert.equal(output.outputPath, null);
  assert.ok(!context.state.artifacts.includes(expectedPath));
  await assert.rejects(() => readFile(path.join(workspace, expectedPath), "utf8"), /ENOENT/);
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

test("writer_agent skips placeholder persistence when deadline budget is insufficient", async () => {
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
  context.getResearchSourceCards = () => context.state.researchSourceCards ?? [];

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

  const events = await runStore.listRunEvents(run);
  const persistSkipped = events.find((event) =>
    event.eventType === "writer_stage"
    && (event.payload as { stage?: string; reason?: string }).stage === "persist"
    && (event.payload as { stage?: string; reason?: string }).reason === "placeholder_persist_blocked"
  );
  assert.ok(persistSkipped);
});

test("writer_agent uses shape-aware provider flow for ranked-list deliverables", async () => {
  const workspace = await createTempWorkspace("alfred-writer-shape-aware");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-shaped", "writer shape test", "running");
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
  context.getResearchSourceCards = () => context.state.researchSourceCards ?? [];

  provider.enqueueStructured("writer_intent_v1", {
    result: {
      outputShape: "ranked_list",
      titleHint: "Top 3 PC Co-op Games for Families",
      deliverableSummary: "A ranked list of the top 3 PC-first family games with age, players, and cautions.",
      targetItemCount: 3,
      requiredElements: ["Use exactly 3 numbered entries", "Include reason to play, age, player counts, and cautions"],
      formattingDirectives: ["Write the final answer directly as a numbered list", "Keep uncertainty inline if needed"],
      shouldIncludeReferences: true,
      shouldUseHeadings: false,
      shouldPreserveExistingStructure: false
    }
  });
  provider.enqueueStructured("writer_draft_v1", {
    result: {
      title: "Top 3 PC Co-op Games for Families",
      content: [
        "1. Game A (2026): Great for siblings because it mixes light puzzles with co-op teamwork [S1].",
        "Recommended minimum age: 8.",
        "Players and modes: 1-4 players; local and online co-op [S1].",
        "Cautions: Mild fantasy combat.",
        "",
        "2. Game B (2026): Strong pick for mixed-age groups thanks to forgiving controls [S2].",
        "Recommended minimum age: 7.",
        "Players and modes: 1-4 players; online co-op [S2].",
        "Cautions: In-game chat should be supervised.",
        "",
        "3. Game C (2025): Good starter co-op choice with short session length [S1][S2].",
        "Recommended minimum age: 9.",
        "Players and modes: 1-2 players; local co-op [S1].",
        "Cautions: Mild peril themes.",
        "",
        "## References",
        "[S1] Game A — https://example.com/game-a",
        "[S2] Game B — https://example.com/game-b"
      ].join("\n"),
      summary: "Ranked family-friendly PC recommendations.",
      nextSteps: ["Double-check age fit against your children", "Choose one local and one online option", "Start with the shortest onboarding game"]
    }
  });
  provider.enqueueStructured("writer_review_v1", {
    result: {
      deliverableStatus: "complete",
      matchesRequestedShape: true,
      processCommentaryDetected: false,
      shouldPersist: true,
      missingRequirements: [],
      repairFocus: [],
      summary: "The draft matches the requested ranked-list deliverable."
    }
  });

  const output = await writerAgentTool.execute(
    {
      instruction: "Give me the top 3 PC-first games to play with children, ranked, with age, players, and cautions.",
      format: "memo",
      maxWords: 420
    },
    context
  );

  const expectedPath = `workspace/alfred/sessions/${run.sessionId}/outputs/${run.runId}-memo.md`;
  assert.equal(output.outputShape, "ranked_list");
  assert.equal(output.deliverableStatus, "complete");
  assert.equal(output.draftQuality, "complete");
  assert.equal(output.fallbackUsed, false);
  assert.equal(output.outputPath, expectedPath);
  assert.ok(context.state.artifacts.includes(expectedPath));
  assert.equal(provider.structuredRequests.map((request) => request.schemaName).join(","), "writer_intent_v1,writer_draft_v1,writer_review_v1");

  const written = await readFile(path.join(workspace, expectedPath), "utf8");
  assert.match(written, /^Top 3 PC Co-op Games for Families/m);
  assert.match(written, /Game A/);
});

test("writer_agent repairs process commentary into the final deliverable shape", async () => {
  const workspace = await createTempWorkspace("alfred-writer-repair-shape");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-repair", "writer repair test", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);
  const provider = new FakeLlmProvider();
  context.llmProviders = [provider];
  context.state.researchSourceCards = [
    {
      url: "https://example.com/source-a",
      title: "Source A",
      date: "2026-03-12",
      claim: "Source A confirms one candidate game and its player counts.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];
  context.getResearchSourceCards = () => context.state.researchSourceCards ?? [];

  provider.enqueueStructured("writer_intent_v1", {
    result: {
      outputShape: "ranked_list",
      titleHint: "Top 2 Family PC Games",
      deliverableSummary: "A ranked list of 2 family-friendly PC games.",
      targetItemCount: 2,
      requiredElements: ["Use 2 numbered entries", "Each item should include age and player counts"],
      formattingDirectives: ["Avoid process commentary", "Keep it parent-friendly"],
      shouldIncludeReferences: true,
      shouldUseHeadings: false,
      shouldPreserveExistingStructure: false
    }
  });
  provider.enqueueStructured("writer_draft_v1", {
    result: {
      title: "Section plan for family PC games",
      content: "## Selection process\nI reviewed the evidence and would next verify two candidates before assembling the ranked list. The available evidence is promising [S1].",
      summary: "Planning memo rather than final deliverable.",
      nextSteps: ["Verify more sources", "Rewrite as final list"]
    }
  });
  provider.enqueueStructured("writer_review_v1", {
    result: {
      deliverableStatus: "partial",
      matchesRequestedShape: false,
      processCommentaryDetected: true,
      shouldPersist: false,
      missingRequirements: ["The draft is process commentary instead of the final ranked list", "It does not contain the requested numbered entries"],
      repairFocus: ["Rewrite directly as the two-item ranked list", "Remove process commentary and keep uncertainty inline"],
      summary: "Current output is a planning memo."
    }
  });
  provider.enqueueStructured("writer_repair_v2", {
    result: {
      title: "Top 2 Family PC Games",
      content: [
        "1. Game A: Best if you want quick teamwork sessions with younger kids [S1].",
        "Recommended minimum age: 8.",
        "Players and modes: 1-4 players; local and online co-op [S1].",
        "Cautions: Mild fantasy peril.",
        "",
        "2. Game B: Better if your children enjoy slower puzzle-solving [S1].",
        "Recommended minimum age: 9.",
        "Players and modes: 1-2 players; local co-op [S1].",
        "Cautions: Reading-heavy menus for younger children.",
        "",
        "## References",
        "[S1] Source A — https://example.com/source-a"
      ].join("\n"),
      summary: "Repaired into the final ranked list.",
      nextSteps: ["Choose the easier onboarding game first", "Supervise local co-op setup"]
    }
  });
  provider.enqueueStructured("writer_review_v1", {
    result: {
      deliverableStatus: "complete",
      matchesRequestedShape: true,
      processCommentaryDetected: false,
      shouldPersist: true,
      missingRequirements: [],
      repairFocus: [],
      summary: "The repaired draft now matches the requested deliverable."
    }
  });

  const output = await writerAgentTool.execute(
    {
      instruction: "Give me the top 2 family-friendly PC games in a ranked list.",
      format: "memo",
      maxWords: 320,
      outputPath: "artifacts/ranked.md"
    },
    context
  );

  assert.equal(output.draftQuality, "complete");
  assert.equal(output.deliverableStatus, "complete");
  assert.equal(output.processCommentaryDetected, false);
  assert.match(String(output.content), /Game A/);
  assert.doesNotMatch(String(output.content), /Selection process/);
  assert.equal(output.outputPath, "artifacts/ranked.md");
});

test("writer_agent does not auto-persist insufficient process commentary after review failure", async () => {
  const workspace = await createTempWorkspace("alfred-writer-insufficient-commentary");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-insufficient", "writer insufficient test", "running");
  const context = buildToolContext(workspace, runStore, run.runId, run.sessionId);
  const provider = new FakeLlmProvider();
  context.llmProviders = [provider];
  context.state.researchSourceCards = [
    {
      url: "https://example.com/source",
      title: "Source",
      date: "2026-03-13",
      claim: "Source confirms only partial research coverage.",
      quote: null,
      sourceTool: "web_fetch"
    }
  ];
  context.getResearchSourceCards = () => context.state.researchSourceCards ?? [];

  provider.enqueueStructured("writer_intent_v1", {
    result: {
      outputShape: "ranked_list",
      titleHint: "Top 5 Games",
      deliverableSummary: "A ranked list of 5 games.",
      targetItemCount: 5,
      requiredElements: ["Use 5 numbered entries"],
      formattingDirectives: ["Do not output a planning memo"],
      shouldIncludeReferences: true,
      shouldUseHeadings: false,
      shouldPreserveExistingStructure: false
    }
  });
  provider.enqueueStructured("writer_draft_v1", {
    result: {
      title: "Evidence memo",
      content: "I can only proceed after more verification. The current evidence suggests there may be multiple candidates [S1].",
      summary: "Insufficient process memo.",
      nextSteps: ["Fetch more sources"]
    }
  });
  provider.enqueueStructured("writer_review_v1", {
    result: {
      deliverableStatus: "insufficient",
      matchesRequestedShape: false,
      processCommentaryDetected: true,
      shouldPersist: false,
      missingRequirements: ["No ranked list was delivered"],
      repairFocus: [],
      summary: "This is not a reusable deliverable body."
    }
  });
  provider.enqueueText({
    failureCode: "network_error",
    failureClass: "timeout",
    failureMessage: "The operation was aborted due to timeout"
  });

  const output = await writerAgentTool.execute(
    {
      instruction: "Give me the top 5 family PC games.",
      format: "memo",
      maxWords: 260
    },
    context
  );

  assert.equal(output.draftQuality, "placeholder");
  assert.equal(output.deliverableStatus, "insufficient");
  assert.equal(output.outputPath, null);
  assert.equal(output.persistedFallbackDraft, false);
});
