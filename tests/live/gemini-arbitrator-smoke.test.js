"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runLiveArbitratorSmoke } = require("./helpers/live-harness");

test("gemini lower-model arbitrator resolves a staged question request", { timeout: 11 * 60 * 1000 }, (t) => {
  const result = runLiveArbitratorSmoke(t, "gemini");
  if (result.skipped) return;

  assert.equal(result.provider, "gemini");
  assert.equal(result.request.request_id, "agent-live-req-output-text");
  assert.ok(result.decision.disposition === "approved" || result.decision.disposition === "rejected");
});
