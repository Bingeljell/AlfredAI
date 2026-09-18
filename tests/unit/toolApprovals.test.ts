import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolDefinition as shellExec } from "../../src/tools/definitions/shellExec.tool.js";
import { ToolApprovalStore, toolApprovalActionKey, toolApprovalStore } from "../../src/runtime/toolApprovalStore.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(projectRoot: string, policyMode: ToolContext["policyMode"]): ToolContext {
  return {
    runId: "run-1", sessionId: "session-1", message: "test", deadlineAtMs: Date.now() + 60_000,
    policyMode, projectRoot, workspaceDir: projectRoot, runStore: {} as ToolContext["runStore"],
    searchManager: {} as ToolContext["searchManager"], defaults: { searchMaxResults: 1, browseConcurrency: 1 },
    state: { artifacts: [], fetchedPages: [] }, isCancellationRequested: async () => false,
    addArtifact: () => {}, setFetchedPages: () => {}, getFetchedPages: () => []
  };
}

test("tool approvals are exact, expiring, session-bound, and one-use", () => {
  let now = 1_000;
  const store = new ToolApprovalStore(100, () => now);
  const key = toolApprovalActionKey("shell_exec", { command: "pwd" });
  const request = store.request("session-a", key, "shell_exec: pwd");
  assert.equal(store.approve("session-b", request.token).ok, false);
  assert.equal(store.approve("session-a", request.token).ok, true);
  assert.equal(store.consume("session-a", key), true);
  assert.equal(store.consume("session-a", key), false);

  const expiring = store.request("session-a", key, "shell_exec: pwd");
  now += 101;
  assert.equal(store.approve("session-a", expiring.token).ok, false);
});

test("shell access is blocked, approval-gated, or direct according to access mode", async () => {
  toolApprovalStore.clear();
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "alfred-shell-approval-"));
  const input = { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('approved')"` };

  const limited = await shellExec.execute(input, context(projectRoot, "limited"));
  assert.equal(limited.reason, "shell_exec_disabled_in_limited_mode");

  const approvalContext = context(projectRoot, "balanced");
  const pending = await shellExec.execute(input, approvalContext);
  assert.equal(pending.reason, "approval_required");
  assert.equal(typeof pending.approvalToken, "string");
  assert.equal(toolApprovalStore.approve(approvalContext.sessionId, String(pending.approvalToken)).ok, true);
  const approved = await shellExec.execute(input, approvalContext);
  assert.equal(approved.success, true);
  assert.equal(approved.stdout, "approved");

  const trusted = await shellExec.execute(input, context(projectRoot, "trusted"));
  assert.equal(trusted.success, true);
});
