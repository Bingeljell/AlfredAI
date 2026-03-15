import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { computeWritingRuntimeMetrics, type WritingRuntimeMetrics } from "../../../src/evals/writingRuntimeMetrics.js";
import type { DebugRunExport } from "../../../src/evals/turnRuntimeMetrics.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests/evals/turn_runtime/fixtures");
const FIXTURES = [
  "alfred-run-b92d1701-36c3-4bf5-936d-57221c6da178.json",
  "alfred-run-89aa357a-5c5c-4897-b293-a1431c3995ba.json",
  "alfred-run-b2d941ef-ca2d-47e1-96f8-49ecabd80113.json"
];

async function loadFixture(fileName: string): Promise<DebugRunExport> {
  const raw = await readFile(path.join(FIXTURE_DIR, fileName), "utf8");
  return JSON.parse(raw) as DebugRunExport;
}

test("writing replay metrics compute stable quality signals from real writing runs", async () => {
  const bundles = await Promise.all(FIXTURES.map((file) => loadFixture(file)));
  const metrics = computeWritingRuntimeMetrics(bundles);

  assert.equal(metrics.runCount, 3);
  assert.equal(metrics.writingRunCount, 3);
  assert.ok(metrics.artifactCompletionRate > 0.5);
  assert.ok(metrics.draftEvidenceRate > 0.5);
  assert.ok(metrics.writerFailureRate >= 0 && metrics.writerFailureRate <= 1);
  assert.ok(metrics.avgWriterCallsPerWritingRun >= 1);
  assert.ok(metrics.citationEvidenceRate >= 0 && metrics.citationEvidenceRate <= 1);
});

test("writing replay metrics handle empty fixture sets", () => {
  const metrics = computeWritingRuntimeMetrics([]);
  const expected: WritingRuntimeMetrics = {
    runCount: 0,
    writingRunCount: 0,
    artifactCompletionRate: 0,
    draftEvidenceRate: 0,
    citationEvidenceRate: 0,
    writerFailureRate: 0,
    avgWriterCallsPerWritingRun: 0
  };
  assert.deepEqual(metrics, expected);
});

