import test from "node:test";
import assert from "node:assert/strict";
import { leadQualityScoringForTests } from "../../src/tools/lead/subReactPipeline.js";
import type { LeadCandidate } from "../../src/types.js";

function baseLead(): LeadCandidate {
  return {
    companyName: "Acme MSP",
    website: "https://acme.example",
    location: "Austin, TX",
    shortDesc: "Managed IT services for SMBs.",
    sourceUrl: "https://directory.example/acme",
    confidence: 0.7,
    evidence: "Listed as a USA MSP with managed services and cloud support for SMB clients."
  };
}

test("size scoring boosts near_range and keeps unknown neutral relative to out_of_range", () => {
  const targetRange = { min: 5, max: 50 };
  const inRange = leadQualityScoringForTests.scoreLead({ ...baseLead(), sizeMatch: "in_range" }, targetRange, false);
  const nearRange = leadQualityScoringForTests.scoreLead({ ...baseLead(), sizeMatch: "near_range" }, targetRange, false);
  const unknown = leadQualityScoringForTests.scoreLead({ ...baseLead(), sizeMatch: "unknown" }, targetRange, false);
  const outOfRange = leadQualityScoringForTests.scoreLead({ ...baseLead(), sizeMatch: "out_of_range" }, targetRange, false);

  assert.ok(inRange > nearRange);
  assert.ok(nearRange > unknown);
  assert.ok(unknown > outOfRange);
});

test("email-aware scoring prefers leads with email when email is requested", () => {
  const targetRange = { min: 5, max: 50 };
  const withEmail = leadQualityScoringForTests.scoreLead(
    { ...baseLead(), sizeMatch: "in_range", email: "hello@acme.example" },
    targetRange,
    true
  );
  const withoutEmail = leadQualityScoringForTests.scoreLead(
    { ...baseLead(), sizeMatch: "in_range" },
    targetRange,
    true
  );

  assert.ok(withEmail > withoutEmail);
});
