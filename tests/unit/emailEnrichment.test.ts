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

test("pickBestEmail prefers source-domain business email over personal inboxes", () => {
  const picked = emailEnrichmentForTests.pickBestEmail(
    [
      "owner@gmail.com",
      "contact@listings.clutch.co",
      "hello@acmeit.com"
    ],
    "acmeit.com"
  );

  assert.equal(picked, "hello@acmeit.com");
  assert.equal(emailEnrichmentForTests.isAcceptableBusinessEmail("hello@acmeit.com", "acmeit.com"), true);
  assert.equal(emailEnrichmentForTests.isAcceptableBusinessEmail("owner@gmail.com", "acmeit.com"), false);
});

test("extractEmailsFromHtml captures mailto and body text emails", () => {
  const emails = emailEnrichmentForTests.extractEmailsFromHtml(`
    <html>
      <body>
        <footer>support@acmeit.com</footer>
        <a href="mailto:sales@acmeit.com">Email us</a>
      </body>
    </html>
  `);

  assert.deepEqual(emails.sort(), ["sales@acmeit.com", "support@acmeit.com"]);
});

test("scrubDuplicateLeadEmails removes duplicate email from lower-confidence lead", () => {
  const leads = emailEnrichmentForTests.scrubDuplicateLeadEmails([
    {
      companyName: "Alpha MSP",
      website: "https://alpha.example",
      location: "Austin, TX",
      shortDesc: "MSP services",
      sourceUrl: "https://example.com/alpha",
      confidence: 0.82,
      evidence: "Good fit",
      email: "hello@alpha.example",
      emailEvidence: "contact"
    },
    {
      companyName: "Beta SI",
      website: "https://beta.example",
      location: "Dallas, TX",
      shortDesc: "SI services",
      sourceUrl: "https://example.com/beta",
      confidence: 0.65,
      evidence: "Good fit",
      email: "hello@alpha.example",
      emailEvidence: "footer"
    }
  ]);

  assert.equal(leads[0]?.email, "hello@alpha.example");
  assert.equal(leads[1]?.email, undefined);
  assert.equal(leads[1]?.emailEvidence, undefined);
  assert.ok((leads[1]?.confidence ?? 1) < 0.65);
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
