import test from "node:test";
import assert from "node:assert/strict";
import { QueryExpansionSchema, ExtractedLeadBatchSchema } from "../../src/tools/lead/schemas.js";

test("QueryExpansionSchema accepts null targetLeadCount for strict JSON-schema compatibility", () => {
  const parsed = QueryExpansionSchema.parse({
    queries: ["top fintech suppliers india", "payment processing companies directory india", "b2b fintech contact leads india"],
    targetLeadCount: null,
    objectiveBrief: {
      objectiveSummary: "Find fintech supplier leads in India with contact details.",
      companyType: "suppliers",
      industry: "fintech",
      geography: "India",
      businessModel: "b2b",
      contactRequirement: "email contacts requested",
      constraintsMissing: []
    }
  });

  assert.equal(parsed.targetLeadCount, null);
  assert.equal(parsed.objectiveBrief.industry, "fintech");
});

test("ExtractedLeadBatchSchema accepts nullable website/location and sizeEvidence text", () => {
  const parsed = ExtractedLeadBatchSchema.parse({
    leads: [
      {
        companyName: "Acme MSP",
        email: null,
        emailEvidence: null,
        website: null,
        location: null,
        employeeSizeText: "unknown",
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
  assert.equal(parsed.leads[0]?.emailEvidence, null);
  assert.equal(parsed.leads[0]?.location, null);
  assert.equal(parsed.leads[0]?.employeeSizeText, "unknown");
  assert.equal(parsed.leads[0]?.employeeMin, null);
  assert.equal(parsed.leads[0]?.employeeMax, null);
  assert.equal(parsed.leads[0]?.sizeEvidence, null);
});
