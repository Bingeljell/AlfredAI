import test from "node:test";
import assert from "node:assert/strict";
import { applyToolAllowlist, discoverLeadAgentTools } from "../../src/agent/tools/registry.js";

test("auto-discovers lead agent tools from definitions folder", async () => {
  const tools = await discoverLeadAgentTools();

  assert.ok(tools.has("lead_pipeline"));
  assert.ok(tools.has("lead_search_shortlist"));
  assert.ok(tools.has("lead_extract"));
  assert.ok(tools.has("recover_search"));
  assert.ok(tools.has("search"));
  assert.ok(tools.has("web_fetch"));
  assert.ok(tools.has("run_diagnostics"));
  assert.ok(tools.has("doc_qa"));
  assert.ok(tools.has("writer_agent"));
  assert.ok(tools.has("email_enrich"));
  assert.ok(tools.has("search_status"));
  assert.ok(tools.has("write_csv"));
  assert.ok(tools.has("file_list"));
  assert.ok(tools.has("file_read"));
  assert.ok(tools.has("file_write"));
  assert.ok(tools.has("file_edit"));
  assert.ok(tools.has("shell_exec"));
  assert.ok(tools.has("process_list"));
  assert.ok(tools.has("process_stop"));

  const searchTool = tools.get("search");
  assert.ok(searchTool);
  const parsed = searchTool!.inputSchema.parse({ query: "top msp usa", maxResults: 10 }) as {
    query: string;
    maxResults?: number;
  };
  assert.equal(parsed.maxResults, 10);

  const filtered = applyToolAllowlist(tools, ["search", "web_fetch", "write_csv"]);
  assert.equal(filtered.has("search"), true);
  assert.equal(filtered.has("web_fetch"), true);
  assert.equal(filtered.has("write_csv"), true);
  assert.equal(filtered.has("lead_pipeline"), false);
});
