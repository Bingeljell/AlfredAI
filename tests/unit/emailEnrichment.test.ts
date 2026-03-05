import test from "node:test";
import assert from "node:assert/strict";
import { emailEnrichmentForTests } from "../../src/tools/lead/subReactPipeline.js";

test("extractEmailsFromPayload picks valid addresses and strips trailing punctuation", () => {
  const emails = emailEnrichmentForTests.extractEmailsFromPayload({
    url: "https://example-msp.com/contact",
    title: "Contact",
    text: "Reach us at info@example-msp.com, or support@example-msp.com.",
    listItems: [],
    tableRows: [],
    outboundLinks: ["Email -> mailto:sales@example-msp.com"]
  });

  assert.deepEqual(emails.sort(), ["info@example-msp.com", "sales@example-msp.com", "support@example-msp.com"]);
});

test("pickBestEmail deprioritizes noreply addresses", () => {
  const picked = emailEnrichmentForTests.pickBestEmail([
    "noreply@example.com",
    "hello@example.com",
    "contact@example.com"
  ]);

  assert.equal(picked, "hello@example.com");
});

test("computeEmailEnrichmentUrlCap shrinks under low remaining budget", () => {
  const now = Date.now();
  const highBudgetCap = emailEnrichmentForTests.computeEmailEnrichmentUrlCap({ deadlineAtMs: now + 500_000 } as any);
  const mediumBudgetCap = emailEnrichmentForTests.computeEmailEnrichmentUrlCap({ deadlineAtMs: now + 100_000 } as any);
  const lowBudgetCap = emailEnrichmentForTests.computeEmailEnrichmentUrlCap({ deadlineAtMs: now + 15_000 } as any);

  assert.ok(highBudgetCap > mediumBudgetCap);
  assert.ok(mediumBudgetCap > lowBudgetCap);
  assert.equal(lowBudgetCap, 0);
});
