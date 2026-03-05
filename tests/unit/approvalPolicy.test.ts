import test from "node:test";
import assert from "node:assert/strict";
import { evaluateApprovalNeed } from "../../src/core/approvalPolicy.js";

test("trusted mode skips approvals", () => {
  const decision = evaluateApprovalNeed("send email to team", "trusted");
  assert.equal(decision.needed, false);
});

test("balanced mode requires approvals for risky actions", () => {
  const decision = evaluateApprovalNeed("send email to leads", "balanced");
  assert.equal(decision.needed, true);
  assert.ok(decision.token);
});
