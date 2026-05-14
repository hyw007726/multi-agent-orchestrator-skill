"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  parseArgs,
  runLiveTests,
  selectedTestFiles,
} = require("../scripts/run-live-tests");

describe("live test runner", () => {
  it("parses provider selection and help", () => {
    assert.deepStrictEqual(parseArgs([]), { provider: "all", help: false });
    assert.deepStrictEqual(parseArgs(["--provider", "codex"]), { provider: "codex", help: false });
    assert.deepStrictEqual(parseArgs(["--help"]), { provider: "all", help: true });
    assert.throws(() => parseArgs(["--provider", "unknown"]), /provider must be one of/);
    assert.throws(() => parseArgs(["--provider"]), /requires a value/);
  });

  it("selects provider-specific live test files", () => {
    const root = "/repo";
    assert.deepStrictEqual(selectedTestFiles("codex", root), [
      path.join(root, "tests/live/codex-reviewer-smoke.test.js"),
      path.join(root, "tests/live/codex-arbitrator-smoke.test.js"),
      path.join(root, "tests/live/codex-worker-smoke.test.js"),
    ]);
    assert.deepStrictEqual(selectedTestFiles("all", root), [
      path.join(root, "tests/live/codex-reviewer-smoke.test.js"),
      path.join(root, "tests/live/codex-arbitrator-smoke.test.js"),
      path.join(root, "tests/live/codex-worker-smoke.test.js"),
      path.join(root, "tests/live/claude-reviewer-smoke.test.js"),
      path.join(root, "tests/live/claude-arbitrator-smoke.test.js"),
      path.join(root, "tests/live/claude-worker-smoke.test.js"),
      path.join(root, "tests/live/gemini-reviewer-smoke.test.js"),
      path.join(root, "tests/live/gemini-arbitrator-smoke.test.js"),
      path.join(root, "tests/live/gemini-worker-smoke.test.js"),
    ]);
  });

  it("requires explicit live-test opt-in", () => {
    let spawned = false;
    const stderr = capture();
    const status = runLiveTests(["--provider", "codex"], {
      env: {},
      stderr,
      stdout: capture(),
      spawnSyncImpl: () => {
        spawned = true;
        return { status: 0 };
      },
    });

    assert.strictEqual(status, 1);
    assert.strictEqual(spawned, false);
    assert.match(stderr.text(), /RUN_LIVE_MODEL_TESTS=1/);
  });

  it("passes the selected provider to node --test", () => {
    let call = null;
    const status = runLiveTests(["--provider", "gemini"], {
      cwd: "/repo",
      env: { RUN_LIVE_MODEL_TESTS: "1" },
      stderr: capture(),
      stdout: capture(),
      spawnSyncImpl: (cmd, args, options) => {
        call = { cmd, args, options };
        return { status: 0 };
      },
    });

    assert.strictEqual(status, 0);
    assert.ok(call);
    assert.strictEqual(call.args[0], "--test");
    assert.ok(call.args.includes("--test-concurrency=1"));
    assert.ok(call.args.some((arg) => arg.endsWith("tests/live/gemini-reviewer-smoke.test.js")));
    assert.strictEqual(call.options.env.LIVE_PROVIDER, "gemini");
  });
});

function capture() {
  let value = "";
  return {
    write(chunk) {
      value += String(chunk);
    },
    text() {
      return value;
    },
  };
}
