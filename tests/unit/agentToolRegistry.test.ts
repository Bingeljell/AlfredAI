import test from "node:test";
import assert from "node:assert/strict";
import { applyToolAllowlist, discoverTools } from "../../src/tools/registry.js";

test("auto-discovers lead agent tools from definitions folder", async () => {
  const tools = await discoverTools();

  assert.ok(tools.has("lead_generation"));
  assert.ok(tools.has("lead_extractor"));
  assert.ok(tools.has("recover_search"));
  assert.ok(tools.has("search"));
  assert.ok(tools.has("web_fetch"));
  assert.ok(tools.has("run_diagnostics"));
  assert.ok(tools.has("doc_qa"));
  assert.ok(tools.has("writer_agent"));
  assert.ok(tools.has("article_writer"));
  assert.ok(tools.has("search_status"));
  assert.ok(tools.has("file_list"));
  assert.ok(tools.has("file_read"));
  assert.ok(tools.has("file_write"));
  assert.ok(tools.has("file_edit"));
  assert.ok(tools.has("shell_exec"));
  assert.ok(tools.has("process_list"));
  assert.ok(tools.has("process_stop"));
  assert.ok(tools.has("browser_navigate"));
  assert.ok(tools.has("browser_snapshot"));
  assert.ok(tools.has("browser_click"));
  assert.ok(tools.has("browser_type"));
  assert.ok(tools.has("browser_nav"));
  assert.ok(tools.has("browser_screenshot"));
  assert.ok(tools.has("browser_tabs"));
  assert.ok(tools.has("browser_close"));

  const searchTool = tools.get("search");
  assert.ok(searchTool);
  const parsed = searchTool!.inputSchema.parse({ query: "top msp usa", maxResults: 10 }) as {
    query: string;
    maxResults?: number;
  };
  assert.equal(parsed.maxResults, 10);

  const filtered = applyToolAllowlist(tools, ["search", "web_fetch", "file_read"]);
  assert.equal(filtered.has("search"), true);
  assert.equal(filtered.has("web_fetch"), true);
  assert.equal(filtered.has("file_read"), true);
  assert.equal(filtered.has("lead_generation"), false);
});
