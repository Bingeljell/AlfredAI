import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../../src/runs/runStore.js";
import { toolDefinition as docQaTool } from "../../src/agent/tools/definitions/docQa.tool.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

function buildToolContext(workspace: string, runStore: RunStore) {
  return {
    runId: "doc-qa-run",
    sessionId: "session-1",
    message: "doc qa test",
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
      fetchedPages: []
    },
    isCancellationRequested: async () => false,
    addLeads: () => ({ addedCount: 0, totalCount: 0 }),
    addArtifact: () => undefined,
    setFetchedPages: () => undefined,
    getFetchedPages: () => []
  };
}

test("doc_qa returns fallback answer with citations when api key is missing", async () => {
  const workspace = await createTempWorkspace("alfred-doc-qa");
  const docsDir = path.join(workspace, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    path.join(docsDir, "search.md"),
    [
      "# Search Provider",
      "Alfred supports SearXNG, Bright Data fallback, and Brave fallback.",
      "Use provider status checks before retrying failed searches."
    ].join("\n"),
    "utf8"
  );

  const runStore = new RunStore(workspace);
  const output = await docQaTool.execute(
    {
      question: "What search providers does Alfred support?",
      scopePaths: ["docs"]
    },
    buildToolContext(workspace, runStore)
  );

  assert.equal(output.fallbackUsed, true);
  assert.equal((output.citations as Array<unknown>).length > 0, true);
  assert.match(String(output.answer), /SearXNG|Bright Data|search/i);
});

test("doc_qa reports no matching snippets when question has no overlap", async () => {
  const workspace = await createTempWorkspace("alfred-doc-qa-empty");
  const docsDir = path.join(workspace, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "notes.md"), "This file describes build and test scripts only.", "utf8");

  const runStore = new RunStore(workspace);
  const output = await docQaTool.execute(
    {
      question: "How do I configure Kubernetes ingress annotations?"
    },
    buildToolContext(workspace, runStore)
  );

  assert.equal(output.fallbackUsed, true);
  assert.equal((output.snippetCount as number), 0);
  assert.match(String(output.answer), /No relevant snippets found/i);
});

