import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCapabilityGateThreadParams,
  buildCapabilityGateTurnParams,
  classifyCapabilityGateServerRequest,
  validateGateDynamicToolCall,
  CODEX_APP_SERVER_GATE_TOOL,
  CODEX_APP_SERVER_GATE_VALUE
} from "../../src/provider/codex/appServerGate.js";

const fixture = async (name: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/codex-app-server", name), "utf8")) as Record<string, unknown>;

test("capability gate advertises ephemeral Alfred-only execution with no environment or network access", () => {
  const thread = buildCapabilityGateThreadParams();
  const turn = buildCapabilityGateTurnParams("thread-1");
  assert.equal(thread.ephemeral, true);
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(thread.runtimeWorkspaceRoots, []);
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.deepEqual(turn.environments, []);
  assert.deepEqual(turn.runtimeWorkspaceRoots, []);
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(thread.dynamicTools, [CODEX_APP_SERVER_GATE_TOOL]);
});

test("Alfred accepts only the known dynamic tool and exact arguments", () => {
  const valid = validateGateDynamicToolCall({ callId: "call-1", tool: CODEX_APP_SERVER_GATE_TOOL.name, arguments: { value: CODEX_APP_SERVER_GATE_VALUE } });
  assert.deepEqual(valid, { ok: true, value: CODEX_APP_SERVER_GATE_VALUE });

  const jsonString = validateGateDynamicToolCall({ callId: "call-1", tool: CODEX_APP_SERVER_GATE_TOOL.name, arguments: JSON.stringify({ value: CODEX_APP_SERVER_GATE_VALUE }) });
  assert.deepEqual(jsonString, { ok: true, value: CODEX_APP_SERVER_GATE_VALUE });

  assert.equal(validateGateDynamicToolCall({ callId: "call-1", tool: "shell", arguments: {} }).ok, false);
  assert.equal(validateGateDynamicToolCall({ callId: "call-1", tool: CODEX_APP_SERVER_GATE_TOOL.name, arguments: "not-json" }).ok, false);
  assert.equal(validateGateDynamicToolCall({ callId: "call-1", tool: CODEX_APP_SERVER_GATE_TOOL.name, arguments: { value: CODEX_APP_SERVER_GATE_VALUE, extra: true } }).ok, false);
});

test("capability gate classifies built-in effects for safe rejection", () => {
  assert.equal(classifyCapabilityGateServerRequest("item/tool/call"), "dynamic_tool");
  assert.equal(classifyCapabilityGateServerRequest("item/commandExecution/requestApproval"), "safe_rejection");
  assert.equal(classifyCapabilityGateServerRequest("item/fileChange/requestApproval"), "safe_rejection");
  assert.equal(classifyCapabilityGateServerRequest("applyPatchApproval"), "safe_rejection");
  assert.equal(classifyCapabilityGateServerRequest("command/exec"), "unexpected");
});

test("protocol fixtures use the installed App Server JSON-RPC method and payload shapes", async () => {
  const initialize = await fixture("initialize.request.json");
  const thread = await fixture("thread-start-safe.request.json");
  const toolCall = await fixture("dynamic-tool-call.request.json");
  const toolResponse = await fixture("dynamic-tool-call.response.json");
  assert.equal(initialize.method, "initialize");
  assert.equal(thread.method, "thread/start");
  assert.equal(toolCall.method, "item/tool/call");
  assert.equal((toolCall.params as Record<string, unknown>).tool, CODEX_APP_SERVER_GATE_TOOL.name);
  assert.equal((toolResponse.result as Record<string, unknown>).success, true);
});
