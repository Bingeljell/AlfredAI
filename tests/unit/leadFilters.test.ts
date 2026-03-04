import test from "node:test";
import assert from "node:assert/strict";
import { LeadPipelineToolInputSchema } from "../../src/agent/tools/definitions/leadPipeline.tool.js";
import { normalizeLeadPipelineFilters } from "../../src/tools/lead/filters.js";

test("lead pipeline input schema accepts filters payload", () => {
  const parsed = LeadPipelineToolInputSchema.parse({
    maxPages: 12,
    filters: {
      employeeCountMax: 50,
      country: "USA",
      industryKeywords: ["msp", "system integrator"],
      requireEmail: true
    }
  });

  assert.equal(parsed.maxPages, 12);
  assert.equal(parsed.filters?.employeeCountMax, 50);
  assert.equal(parsed.filters?.country, "USA");
  assert.equal(parsed.filters?.requireEmail, true);
});

test("normalizeLeadPipelineFilters normalizes keyword strings and employee range order", () => {
  const normalized = normalizeLeadPipelineFilters({
    employeeCountMin: 80,
    employeeCountMax: 20,
    country: "  United States  ",
    industryKeywords: "msp, cloud services | cybersecurity",
    requireEmail: true
  });

  assert.equal(normalized?.employeeCountMin, 20);
  assert.equal(normalized?.employeeCountMax, 80);
  assert.equal(normalized?.country, "United States");
  assert.deepEqual(normalized?.industryKeywords, ["msp", "cloud services", "cybersecurity"]);
  assert.equal(normalized?.requireEmail, true);
});
