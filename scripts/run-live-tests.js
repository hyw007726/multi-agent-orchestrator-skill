#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PROVIDERS = ["codex", "claude", "gemini", "kilo", "opencode"];
const LIVE_TEST_FILES = {
  codex: [
    "tests/live/codex-reviewer-smoke.test.js",
    "tests/live/codex-arbitrator-smoke.test.js",
    "tests/live/codex-worker-smoke.test.js",
    "tests/live/codex-all-live-smoke.test.js",
  ],
  claude: [
    "tests/live/claude-reviewer-smoke.test.js",
    "tests/live/claude-arbitrator-smoke.test.js",
    "tests/live/claude-worker-smoke.test.js",
    "tests/live/claude-all-live-smoke.test.js",
  ],
  gemini: [
    "tests/live/gemini-reviewer-smoke.test.js",
    "tests/live/gemini-arbitrator-smoke.test.js",
    "tests/live/gemini-worker-smoke.test.js",
    "tests/live/gemini-all-live-smoke.test.js",
  ],
  kilo: [
    "tests/live/kilo-reviewer-smoke.test.js",
    "tests/live/kilo-arbitrator-smoke.test.js",
    "tests/live/kilo-worker-smoke.test.js",
    "tests/live/kilo-all-live-smoke.test.js",
  ],
  opencode: [
    "tests/live/opencode-reviewer-smoke.test.js",
    "tests/live/opencode-arbitrator-smoke.test.js",
    "tests/live/opencode-worker-smoke.test.js",
    "tests/live/opencode-all-live-smoke.test.js",
  ],
};

if (require.main === module) {
  process.exitCode = runLiveTests(process.argv.slice(2));
}

function runLiveTests(argv = [], options = {}) {
  const cwd = options.cwd || ROOT;
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n\n${usage()}\n`);
    return 1;
  }

  if (args.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  if (env.RUN_LIVE_MODEL_TESTS !== "1") {
    stderr.write([
      "Live model tests are disabled.",
      "Set RUN_LIVE_MODEL_TESTS=1 to acknowledge that these tests call authenticated CLIs and may use paid model calls.",
      "",
    ].join("\n"));
    return 1;
  }

  const files = selectedTestFiles(args.provider, cwd);
  const childEnv = { ...env };
  if (args.provider === "all") {
    delete childEnv.LIVE_PROVIDER;
  } else {
    childEnv.LIVE_PROVIDER = args.provider;
  }

  stdout.write(`Running live model tests for provider: ${args.provider}\n`);
  const result = spawnSyncImpl(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd,
    env: childEnv,
    stdio: "inherit",
  });

  if (result.error) {
    stderr.write(`Failed to start live tests: ${result.error.message}\n`);
    return 1;
  }
  return result.status === null || result.status === undefined ? 1 : result.status;
}

function parseArgs(argv = []) {
  const out = {
    provider: "all",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--provider":
        out.provider = requireValue(argv, ++i, arg);
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (out.provider !== "all" && !PROVIDERS.includes(out.provider)) {
    throw new Error(`--provider must be one of: all, ${PROVIDERS.join(", ")}`);
  }
  return out;
}

function selectedTestFiles(provider, root = ROOT) {
  const names = provider === "all" ? PROVIDERS : [provider];
  return names.flatMap((name) => LIVE_TEST_FILES[name].map((file) => path.join(root, file)));
}

function usage() {
  return [
    "Usage:",
    "  RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js [--provider all|codex|claude|gemini|kilo|opencode]",
    "",
    "Runs opt-in live model tests. These tests are intentionally excluded from node scripts/run-tests.js.",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

module.exports = {
  LIVE_TEST_FILES,
  PROVIDERS,
  parseArgs,
  runLiveTests,
  selectedTestFiles,
  usage,
};
