"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runLiveReviewerSmoke } = require("./helpers/live-harness");

test("claude lower-model reviewer returns valid plan-review JSON", { timeout: 11 * 60 * 1000 }, (t) => {
  const result = runLiveReviewerSmoke(t, "claude");
  if (result.skipped) return;

  assert.equal(result.provider, "claude");
  assert.equal(result.reviewer, "claude-live-reviewer");
  assert.match(result.review.summary, /\S/);
});
