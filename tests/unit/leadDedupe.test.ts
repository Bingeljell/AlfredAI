import test from "node:test";
import assert from "node:assert/strict";
import { leadDedupeForTests as outerLeadDedupe } from "../../src/core/runLeadAgenticLoop.js";
import { leadDedupeForTests as subReactLeadDedupe } from "../../src/tools/lead/subReactPipeline.js";

test("outer dedupe key collapses profile-vs-direct domains for same company identity", () => {
  const first = outerLeadDedupe.leadKey({
    companyName: "Uprite Services, Inc.",
    website: "https://www.upriteservices.com/",
    sourceUrl: "https://clutch.co/profile/uprite-services",
    location: "Houston, TX"
  });
  const second = outerLeadDedupe.leadKey({
    companyName: "Uprite Services",
    website: "https://clutch.co/profile/uprite-services",
    sourceUrl: "https://clutch.co/us/it-services/msp",
    location: "Houston TX"
  });

  assert.equal(first, second);
});

test("sub-react dedupe key collapses same company across listing/profile pages", () => {
  const first = subReactLeadDedupe.dedupeKeyForLead({
    companyName: "AppMakers USA, LLC",
    website: "https://appmakers.us/",
    location: "Los Angeles, California",
    shortDesc: "Managed services",
    sourceUrl: "https://designrush.com/x",
    confidence: 0.8,
    evidence: "e"
  });
  const second = subReactLeadDedupe.dedupeKeyForLead({
    companyName: "AppMakers USA",
    website: "https://www.designrush.com/agency/managed-service-providers/us",
    location: "Los Angeles California",
    shortDesc: "Managed services",
    sourceUrl: "https://designrush.com/y",
    confidence: 0.81,
    evidence: "e"
  });

  assert.equal(first, second);
});
