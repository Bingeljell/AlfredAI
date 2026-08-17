import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("Codex auth canaries are redacted before run persistence, events, and debug export", async () => {
  const workspace = await createTempWorkspace("alfred-codex-security");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Bearer eyJhbGciOiJub25lIn0.eyJjYW5hcnkiOnRydWV9.signature", "running");
  const canaries = ["access-canary-unique", "refresh-canary-unique", "account-canary-unique", "auth-header-canary-unique", "token-response-canary-unique"];

  const updated = await runStore.updateRun(run.runId, {
    assistantText: `provider error accessToken=${canaries[0]} response eyJhbGciOiJub25lIn0.eyJjYW5hcnkiOnRydWV9.signature`
  });
  await runStore.appendEvent({
    runId: run.runId,
    sessionId: "session-1",
    phase: "final",
    eventType: "codex_failure",
    payload: {
      accessToken: canaries[0],
      refresh_token: canaries[1],
      accountId: canaries[2],
      authorization: `Bearer ${canaries[3]}`,
      tokenResponse: { access_token: canaries[4] }
    },
    timestamp: new Date().toISOString()
  });
  await runStore.flushEvents();

  const day = run.createdAt.slice(0, 10);
  const runFile = await readFile(path.join(workspace, "runs/state", `${run.runId}.json`), "utf8");
  const eventFile = await readFile(path.join(workspace, "runs", "session-1", `${day}.jsonl`), "utf8");
  const debug = JSON.stringify(await runStore.buildDebugExport(run.runId));
  const returned = JSON.stringify(updated);
  for (const canary of canaries) {
    assert.equal(runFile.includes(canary), false);
    assert.equal(eventFile.includes(canary), false);
    assert.equal(debug.includes(canary), false);
    assert.equal(returned.includes(canary), false);
  }
});
