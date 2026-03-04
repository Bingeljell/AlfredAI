import test from "node:test";
import assert from "node:assert/strict";
import { QueryExpansionSchema, ExtractedLeadBatchSchema } from "../../src/tools/lead/schemas.js";

test("QueryExpansionSchema accepts null targetLeadCount for strict JSON-schema compatibility", () => {
  const parsed = QueryExpansionSchema.parse({
    queries: ["top managed service providers usa", "best system integrators usa", "msp directory usa"],
    targetLeadCount: null
  });

  assert.equal(parsed.targetLeadCount, null);
});

test("ExtractedLeadBatchSchema accepts nullable website/location and sizeEvidence text", () => {
  const parsed = ExtractedLeadBatchSchema.parse({
    leads: [
      {
        companyName: "Acme MSP",
        email: null,
        website: null,
        location: null,
        employeeSizeText: null,
        employeeMin: null,
        employeeMax: null,
        sizeEvidence: null,
        shortDesc: "Managed IT services and cloud operations for SMB customers.",
        sourceUrl: "https://example.com/listing/acme",
        confidence: 0.78,
        evidence: "Listed in provider roundup with services and region details."
      }
    ]
  });

  assert.equal(parsed.leads.length, 1);
  assert.equal(parsed.leads[0]?.website, null);
  assert.equal(parsed.leads[0]?.email, null);
  assert.equal(parsed.leads[0]?.location, null);
  assert.equal(parsed.leads[0]?.employeeSizeText, null);
  assert.equal(parsed.leads[0]?.employeeMin, null);
  assert.equal(parsed.leads[0]?.employeeMax, null);
  assert.equal(parsed.leads[0]?.sizeEvidence, null);
});
