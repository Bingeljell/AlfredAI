import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFetchedPageQuality,
  selectFetchedPagesForStorage
} from "../../src/tools/definitions/webFetch.tool.js";

test("evaluateFetchedPageQuality flags captcha/paywall pages as unusable", () => {
  const quality = evaluateFetchedPageQuality({
    url: "https://example.com/blocked",
    title: "Are you a robot?",
    text: "Please verify you are human before continuing."
  });

  assert.equal(quality.usable, false);
  assert.ok(quality.signals.includes("blocked_or_paywalled"));
});

test("evaluateFetchedPageQuality marks substantive pages as usable", () => {
  const quality = evaluateFetchedPageQuality({
    url: "https://example.com/news",
    title: "AI policy roundup",
    text: "This week several AI policy updates were announced. ".repeat(12)
  });

  assert.equal(quality.usable, true);
  assert.equal(quality.signals.includes("blocked_or_paywalled"), false);
});

test("selectFetchedPagesForStorage prefers usable pages and preserves fallback when all are degraded", () => {
  const mixedSelection = selectFetchedPagesForStorage(
    [
      {
        url: "https://example.com/blocked",
        title: "Access denied",
        text: "captcha required"
      },
      {
        url: "https://example.com/good",
        title: "Latest AI News",
        text: "A long article body. ".repeat(40)
      }
    ],
    5
  );

  assert.equal(mixedSelection.selectedPages.length, 1);
  assert.equal(mixedSelection.selectedPages[0]?.url, "https://example.com/good");
  assert.equal(mixedSelection.usableCount, 1);

  const degradedOnlySelection = selectFetchedPagesForStorage(
    [
      {
        url: "https://example.com/blocked-a",
        title: "404",
        text: "not found"
      },
      {
        url: "https://example.com/blocked-b",
        title: "",
        text: "x-forbidden"
      }
    ],
    5
  );

  assert.equal(degradedOnlySelection.selectedPages.length, 2);
  assert.equal(degradedOnlySelection.usableCount, 0);
  assert.equal(degradedOnlySelection.degradedCount, 2);
});
