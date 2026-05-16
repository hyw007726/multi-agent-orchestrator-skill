"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runLiveReviewerSmoke } = require("./helpers/live-harness");

test("kilo configured-model reviewer returns valid plan-review JSON", { timeout: 11 * 60 * 1000 }, (t) => {
  const result = runLiveReviewerSmoke(t, "kilo");
  if (result.skipped) return;

  assert.equal(result.provider, "kilo");
  assert.equal(result.reviewer, "kilo-live-reviewer");
  assert.match(result.review.summary, /\S/);
});
