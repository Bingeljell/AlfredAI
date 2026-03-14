import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../../src/runs/runStore.js";
import { toolDefinition as writerAgentTool } from "../../src/agent/tools/definitions/writerAgent.tool.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { LeadAgentToolContext } from "../../src/agent/types.js";

function buildToolContext(workspace: string, runStore: RunStore): LeadAgentToolContext {
  return {
    runId: "writer-run",
    sessionId: "session-1",
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
    state: {
      leads: [],
      artifacts: [],
      requestedLeadCount: 0,
      fetchedPages: [],
      researchSourceCards: []
    },
    isCancellationRequested: async () => false,
    addLeads: () => ({ addedCount: 0, totalCount: 0 }),
    addArtifact: () => undefined,
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
  assert.ok((output.wordCount as number) > 0);

  const written = await readFile(path.join(workspace, "artifacts/draft.md"), "utf8");
  assert.match(written, /Draft:/);
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
  assert.equal(output.sourceCardCount, 1);
  assert.match(String(output.content), /https:\/\/example.com\/news\/ai-policy/);
});
