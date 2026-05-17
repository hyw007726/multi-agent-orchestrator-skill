"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MIXED_ROLE_COMBOS,
  MIXED_PROVIDER_TARGET,
  liveRoleMappings,
  roleModel,
  roleProviderName,
  selectedMixedCombo,
  writeMixedProviderConfig,
} = require("./helpers/live-harness");

const MIXED_ENV_KEYS = [
  "LIVE_MIXED_COMBO",
  "LIVE_MIXED_PLANNER_PROVIDER",
  "LIVE_MIXED_REVIEWER_PROVIDER",
  "LIVE_MIXED_ARBITRATOR_PROVIDER",
  "LIVE_MIXED_WORKER_PROVIDER",
  "LIVE_MIXED_PLANNER_MODEL",
  "LIVE_MIXED_REVIEWER_MODEL",
  "LIVE_MIXED_ARBITRATOR_MODEL",
  "LIVE_MIXED_WORKER_MODEL",
  "LIVE_CLAUDE_MODEL",
  "LIVE_CLAUDE_PLANNER_MODEL",
  "LIVE_CODEX_MODEL",
  "LIVE_CODEX_REVIEWER_MODEL",
  "LIVE_GEMINI_MODEL",
  "LIVE_GEMINI_ARBITRATOR_MODEL",
  "LIVE_KILO_MODEL",
  "LIVE_KILO_WORKER_MODEL",
  "LIVE_OPENCODE_MODEL",
];

test("mixed-provider live contract resolves one canonical role combo", (t) => {
  if (process.env.RUN_LIVE_MODEL_TESTS !== "1" || process.env.RUN_MIXED_LIVE_TESTS !== "1") {
    t.skip("Set RUN_LIVE_MODEL_TESTS=1 and RUN_MIXED_LIVE_TESTS=1 to run mixed-provider live contract tests.");
    return;
  }

  withEnv(Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])), () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-live-contract-"));
    try {
      const config = writeMixedProviderConfig(root);
      const roles = liveRoleMappings(MIXED_PROVIDER_TARGET);

      assert.strictEqual(config.default_cli, "mixed-live-worker");
      assert.strictEqual(config.orchestrator_cli, "mixed-live-arbitrator");
      assert.strictEqual(config.reviewers[0].cli, "mixed-live-reviewer");

      assert.deepStrictEqual(Object.keys(roles), ["planner", "reviewer", "arbitrator", "worker"]);
      assert.strictEqual(roles.planner.provider, "claude");
      assert.strictEqual(roles.planner.model, "claude-sonnet-4-6");
      assert.strictEqual(roles.reviewer.provider, "codex");
      assert.strictEqual(roles.reviewer.model, "gpt-5.4-mini");
      assert.strictEqual(roles.arbitrator.provider, "gemini");
      assert.strictEqual(roles.arbitrator.model, "gemini-2.5-flash-lite");
      assert.strictEqual(roles.worker.provider, "kilo");
      assert.strictEqual(roles.worker.model, "cli-default");

      assert.strictEqual(config.live_roles.planner.alias, "mixed-live-planner");
      assert.strictEqual(config.live_roles.reviewer.alias, "mixed-live-reviewer");
      assert.strictEqual(config.live_roles.arbitrator.alias, "mixed-live-arbitrator");
      assert.strictEqual(config.live_roles.worker.alias, "mixed-live-worker");

      assert.strictEqual(config.cli_templates["mixed-live-planner"].cmd, "claude");
      assert.ok(config.cli_templates["mixed-live-planner"].args.includes("claude-sonnet-4-6"));

      assert.strictEqual(config.cli_templates["mixed-live-reviewer"].cmd, "codex");
      assert.ok(config.cli_templates["mixed-live-reviewer"].args.includes("gpt-5.4-mini"));

      assert.strictEqual(config.cli_templates["mixed-live-arbitrator"].cmd, "gemini");
      assert.ok(config.cli_templates["mixed-live-arbitrator"].args.includes("gemini-2.5-flash-lite"));
      const includeIndex = config.cli_templates["mixed-live-arbitrator"].args.indexOf("--include-directories");
      assert.notStrictEqual(includeIndex, -1);
      assert.strictEqual(config.cli_templates["mixed-live-arbitrator"].args[includeIndex + 1], path.join(root, "coord"));

      assert.strictEqual(config.cli_templates["mixed-live-worker"].cmd, "kilo");
      assert.strictEqual(config.cli_templates["mixed-live-worker"].args.includes("--model"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("mixed-provider live contract exposes the second named combo without expanding into a provider matrix", (t) => {
  if (process.env.RUN_LIVE_MODEL_TESTS !== "1" || process.env.RUN_MIXED_LIVE_TESTS !== "1") {
    t.skip("Set RUN_LIVE_MODEL_TESTS=1 and RUN_MIXED_LIVE_TESTS=1 to run mixed-provider live contract tests.");
    return;
  }

  withEnv({
    ...Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])),
    LIVE_MIXED_COMBO: "opencode-worker",
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-live-second-combo-"));
    try {
      const config = writeMixedProviderConfig(root);
      const roles = liveRoleMappings(MIXED_PROVIDER_TARGET);

      assert.deepStrictEqual(Object.keys(MIXED_ROLE_COMBOS), ["canonical", "opencode-worker"]);
      assert.strictEqual(selectedMixedCombo(), "opencode-worker");
      assert.strictEqual(config.mixed_combo, "opencode-worker");
      assert.strictEqual(roles.planner.provider, "claude");
      assert.strictEqual(roles.reviewer.provider, "gemini");
      assert.strictEqual(roles.arbitrator.provider, "codex");
      assert.strictEqual(roles.worker.provider, "opencode");

      assert.strictEqual(config.cli_templates["mixed-live-reviewer"].cmd, "gemini");
      assert.strictEqual(config.cli_templates["mixed-live-arbitrator"].cmd, "codex");
      assert.strictEqual(config.cli_templates["mixed-live-worker"].cmd, process.execPath);
      assert.ok(config.cli_templates["mixed-live-worker"].args.some((arg) => String(arg).endsWith("opencode-json-text.js")));
      assert.ok(config.cli_templates["mixed-live-worker"].args.includes("--opencode-json-text-live-worker-smoke"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("mixed-provider live contract supports provider and role model overrides", (t) => {
  if (process.env.RUN_LIVE_MODEL_TESTS !== "1" || process.env.RUN_MIXED_LIVE_TESTS !== "1") {
    t.skip("Set RUN_LIVE_MODEL_TESTS=1 and RUN_MIXED_LIVE_TESTS=1 to run mixed-provider live contract tests.");
    return;
  }

  withEnv({
    ...Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])),
    LIVE_MIXED_PLANNER_PROVIDER: "gemini",
    LIVE_GEMINI_PLANNER_MODEL: "gemini-planner-model",
    LIVE_MIXED_REVIEWER_PROVIDER: "Claude",
    LIVE_MIXED_REVIEWER_MODEL: "claude-reviewer-model",
    LIVE_MIXED_ARBITRATOR_PROVIDER: "codex",
    LIVE_CODEX_ARBITRATOR_MODEL: "gpt-arbitrator-model",
    LIVE_MIXED_WORKER_PROVIDER: "opencode",
    LIVE_OPENCODE_MODEL: "opencode-default-model",
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-live-overrides-"));
    try {
      const config = writeMixedProviderConfig(root);

      assert.strictEqual(roleProviderName(MIXED_PROVIDER_TARGET, "planner"), "gemini");
      assert.strictEqual(roleModel(MIXED_PROVIDER_TARGET, "planner"), "gemini-planner-model");
      assert.strictEqual(roleProviderName(MIXED_PROVIDER_TARGET, "reviewer"), "claude");
      assert.strictEqual(roleModel(MIXED_PROVIDER_TARGET, "reviewer"), "claude-reviewer-model");
      assert.strictEqual(roleProviderName(MIXED_PROVIDER_TARGET, "arbitrator"), "codex");
      assert.strictEqual(roleModel(MIXED_PROVIDER_TARGET, "arbitrator"), "gpt-arbitrator-model");
      assert.strictEqual(roleProviderName(MIXED_PROVIDER_TARGET, "worker"), "opencode");
      assert.strictEqual(roleModel(MIXED_PROVIDER_TARGET, "worker"), "opencode-default-model");

      assert.strictEqual(config.live_roles.worker.provider, "opencode");
      assert.strictEqual(config.cli_templates["mixed-live-worker"].cmd, process.execPath);
      assert.ok(config.cli_templates["mixed-live-worker"].args.includes("--model"));
      assert.ok(config.cli_templates["mixed-live-worker"].args.includes("opencode-default-model"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function withEnv(updates, fn) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    if (updates[key] === undefined) delete process.env[key];
    else process.env[key] = updates[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
