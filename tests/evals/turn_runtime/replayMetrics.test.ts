import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { computeTurnRuntimeMetrics, type DebugRunExport } from "../../../src/evals/turnRuntimeMetrics.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests/evals/turn_runtime/fixtures");
const FIXTURES = [
  "alfred-run-0e546010-f65b-4fe8-af3e-d24b3deee4ec.json",
  "alfred-run-5ab82104-cc0a-4e19-932b-ef408211c3ee.json",
  "alfred-run-73318fe5-2376-46b2-b79d-8394f1d568c4.json"
];

async function loadFixture(fileName: string): Promise<DebugRunExport> {
  const raw = await readFile(path.join(FIXTURE_DIR, fileName), "utf8");
  return JSON.parse(raw) as DebugRunExport;
}

test("turn-runtime replay metrics compute expected aggregate shape from real debug fixtures", async () => {
  const bundles = await Promise.all(FIXTURES.map((file) => loadFixture(file)));
  const metrics = computeTurnRuntimeMetrics(bundles);

  assert.equal(metrics.runCount, 3);
  assert.equal(metrics.diagnosticRunCount, 2);
  assert.equal(metrics.wrongModeExecutionRate, 0);
  assert.ok(Number.isFinite(metrics.evidenceFaithfulnessRate));
  assert.ok(Number.isFinite(metrics.yieldPerThousandTokens));
  assert.ok(metrics.evidenceFaithfulnessRate >= 0 && metrics.evidenceFaithfulnessRate <= 1);
  assert.ok(metrics.uselessToolCallCount >= 0);
});

test("turn-runtime replay metrics gracefully handles empty fixture sets", () => {
  const metrics = computeTurnRuntimeMetrics([]);
  assert.deepEqual(metrics, {
    runCount: 0,
    diagnosticRunCount: 0,
    wrongModeExecutionRate: 0,
    evidenceFaithfulnessRate: 1,
    uselessToolCallCount: 0,
    yieldPerThousandTokens: 0
  });
});
