"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MIXED_ROLE_COMBOS,
  MIXED_PROVIDER_TARGET,
  liveRoleMappings,
  liveSkipReason,
  liveTempDir,
  liveTailCommand,
  roleModel,
  roleProviderName,
  selectedMixedCombo,
  transientProviderSkipReason,
  writeAllLiveProviderConfig,
  writeLiveProviderConfig,
  writeLiveWorkerConfig,
  writeMixedProviderConfig,
} = require("./live/helpers/live-harness");

const MIXED_ENV_KEYS = [
  "RUN_LIVE_MODEL_TESTS",
  "RUN_MIXED_LIVE_TESTS",
  "LIVE_SKIP_TRANSIENT_PROVIDER_ERRORS",
  "LIVE_PROVIDER",
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

describe("live harness provider config", () => {
  it("uses absolute coord include directories for Gemini live templates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-live-config-"));
    try {
      const configWriters = [
        ["provider", writeLiveProviderConfig],
        ["all-live", writeAllLiveProviderConfig],
        ["worker", writeLiveWorkerConfig],
      ];

      for (const [name, writeConfig] of configWriters) {
        const projectRoot = path.join(root, name);
        fs.mkdirSync(projectRoot, { recursive: true });
        const config = writeConfig(projectRoot, "gemini");
        const expectedCoord = path.join(projectRoot, "coord");

        for (const template of Object.values(config.cli_templates)) {
          if (template.cmd !== "gemini") continue;
          const promptIndex = template.args.indexOf("--prompt");
          assert.notStrictEqual(promptIndex, -1, `${name} template should select Gemini headless mode`);
          assert.strictEqual(template.args[promptIndex + 1], "");
          assert.deepStrictEqual(template.stdin, { prompt_file: true });
          assert.strictEqual(JSON.stringify(template).includes("prompt_text"), false);
          const includeIndex = template.args.indexOf("--include-directories");
          assert.notStrictEqual(includeIndex, -1, `${name} template should include coord`);
          assert.strictEqual(template.args[includeIndex + 1], expectedCoord);
          assert.strictEqual(path.isAbsolute(template.args[includeIndex + 1]), true);
          assert.strictEqual(fs.existsSync(template.args[includeIndex + 1]), true);
          assert.strictEqual(template.args.includes("../../coord"), false);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints copyable tail commands for live test sessions", () => {
    const root = "/tmp/live-gemini-all-live--abc123";
    const allLive = liveTailCommand(root, "gemini", "all-live");
    assert.match(allLive, /^tail -F /);
    assert.match(allLive, /gemini-live-reviewer\.md/);
    assert.match(allLive, /orchestrator\.log/);
    assert.match(allLive, /agent-live-all\.log/);

    const arbitrator = liveTailCommand(root, "gemini", "arbitrator");
    assert.match(arbitrator, /^tail -F /);
    assert.match(arbitrator, /orchestrator\.log/);
    assert.doesNotMatch(arbitrator, /agent-live-all\.log/);
  });

  it("uses Kilo's configured default model unless a live model override is set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-live-config-"));
    const previous = process.env.LIVE_KILO_MODEL;
    try {
      delete process.env.LIVE_KILO_MODEL;
      const config = writeLiveProviderConfig(root, "kilo");
      const template = config.cli_templates["kilo-live-worker"];

      assert.strictEqual(roleModel("kilo", "worker"), "cli-default");
      assert.strictEqual(template.cmd, "kilo");
      assert.ok(template.args.includes("run"));
      assert.ok(template.args.includes("--auto"));
      assert.strictEqual(template.args.includes("--dangerously-skip-permissions"), false);
      assert.strictEqual(template.args.includes("--model"), false);

      process.env.LIVE_KILO_MODEL = "anthropic/claude-sonnet-4-6";
      const pinned = writeLiveProviderConfig(path.join(root, "pinned"), "kilo");
      const pinnedTemplate = pinned.cli_templates["kilo-live-worker"];
      const modelIndex = pinnedTemplate.args.indexOf("--model");

      assert.notStrictEqual(modelIndex, -1);
      assert.strictEqual(pinnedTemplate.args[modelIndex + 1], "anthropic/claude-sonnet-4-6");
    } finally {
      if (previous === undefined) delete process.env.LIVE_KILO_MODEL;
      else process.env.LIVE_KILO_MODEL = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses OpenCode's configured default model unless a live model override is set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-live-config-"));
    const previous = process.env.LIVE_OPENCODE_MODEL;
    try {
      delete process.env.LIVE_OPENCODE_MODEL;
      const config = writeLiveProviderConfig(root, "opencode");
      const template = config.cli_templates["opencode-live-worker"];
      const reviewerTemplate = config.cli_templates["opencode-live-reviewer"];

      assert.strictEqual(roleModel("opencode", "worker"), "cli-default");
      assert.strictEqual(template.cmd, process.execPath);
      assert.match(template.args[0], /opencode-json-text\.js$/);
      assert.ok(template.args.includes("--dangerously-skip-permissions"));
      assert.strictEqual(template.args.includes("--model"), false);
      const fileIndex = template.args.indexOf("--file");
      assert.notStrictEqual(fileIndex, -1);
      assert.deepStrictEqual(template.args[fileIndex + 1], { prompt_file: true });
      assert.ok(template.args.includes("Follow the instructions in the attached prompt file."));
      assert.strictEqual(JSON.stringify(template).includes("prompt_text"), false);
      assert.strictEqual(template.args.includes("--opencode-json-text-cwd"), false);
      assert.ok(template.args.includes("--opencode-json-text-live-worker-smoke"));
      assert.ok(reviewerTemplate.args.includes("--opencode-json-text-cwd"));
      assert.strictEqual(reviewerTemplate.args.includes("--opencode-json-text-live-worker-smoke"), false);

      process.env.LIVE_OPENCODE_MODEL = "moonshot/kimi-k2.6";
      const pinned = writeLiveProviderConfig(path.join(root, "pinned"), "opencode");
      const pinnedTemplate = pinned.cli_templates["opencode-live-worker"];
      const modelIndex = pinnedTemplate.args.indexOf("--model");

      assert.notStrictEqual(modelIndex, -1);
      assert.strictEqual(pinnedTemplate.args[modelIndex + 1], "moonshot/kimi-k2.6");
    } finally {
      if (previous === undefined) delete process.env.LIVE_OPENCODE_MODEL;
      else process.env.LIVE_OPENCODE_MODEL = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes an explicit canonical mixed-provider role config", () => {
    withEnv(Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])), () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-live-config-"));
      try {
        const config = writeMixedProviderConfig(root);
        const roles = liveRoleMappings(MIXED_PROVIDER_TARGET);

        assert.strictEqual(config.default_cli, "mixed-live-worker");
        assert.strictEqual(config.orchestrator_cli, "mixed-live-arbitrator");
        assert.strictEqual(config.reviewers[0].cli, "mixed-live-reviewer");
        assert.deepStrictEqual(Object.keys(config.live_roles), ["planner", "reviewer", "arbitrator", "worker"]);

        assert.deepStrictEqual(Object.fromEntries(Object.entries(roles).map(([role, mapping]) => [role, mapping.provider])), {
          planner: "claude",
          reviewer: "codex",
          arbitrator: "gemini",
          worker: "kilo",
        });
        assert.deepStrictEqual(Object.fromEntries(Object.entries(roles).map(([role, mapping]) => [role, mapping.model])), {
          planner: "claude-sonnet-4-6",
          reviewer: "gpt-5.4-mini",
          arbitrator: "gemini-2.5-flash-lite",
          worker: "cli-default",
        });

        assert.strictEqual(config.live_roles.planner.alias, "mixed-live-planner");
        assert.strictEqual(config.live_roles.planner.provider_cli, "claude");
        assert.strictEqual(config.cli_templates["mixed-live-planner"].cmd, "claude");
        assert.ok(config.cli_templates["mixed-live-planner"].args.includes("claude-sonnet-4-6"));

        assert.strictEqual(config.live_roles.reviewer.provider_cli, "codex");
        assert.strictEqual(config.cli_templates["mixed-live-reviewer"].cmd, "codex");
        assert.ok(config.cli_templates["mixed-live-reviewer"].args.includes("gpt-5.4-mini"));

        assert.strictEqual(config.live_roles.arbitrator.provider_cli, "gemini");
        assert.strictEqual(config.cli_templates["mixed-live-arbitrator"].cmd, "gemini");
        const includeIndex = config.cli_templates["mixed-live-arbitrator"].args.indexOf("--include-directories");
        assert.notStrictEqual(includeIndex, -1);
        assert.strictEqual(config.cli_templates["mixed-live-arbitrator"].args[includeIndex + 1], path.join(root, "coord"));

        assert.strictEqual(config.live_roles.worker.provider_cli, "kilo");
        assert.strictEqual(config.cli_templates["mixed-live-worker"].cmd, "kilo");
        assert.strictEqual(config.cli_templates["mixed-live-worker"].args.includes("--model"), false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("allows mixed-provider role provider and model overrides", () => {
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
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-live-override-config-"));
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
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("supports a second named mixed-provider combo without expanding the matrix", () => {
    withEnv({
      ...Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])),
      LIVE_MIXED_COMBO: "opencode-worker",
    }, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-live-second-combo-config-"));
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
        assert.strictEqual(config.cli_templates["mixed-live-worker"].cmd, process.execPath);
        assert.ok(config.cli_templates["mixed-live-worker"].args.includes("--opencode-json-text-live-worker-smoke"));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("requires the separate mixed live opt-in and validates mixed provider overrides", () => {
    withEnv({
      ...Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])),
      RUN_LIVE_MODEL_TESTS: "1",
    }, () => {
      assert.match(liveSkipReason(MIXED_PROVIDER_TARGET), /RUN_MIXED_LIVE_TESTS=1/);
    });

    withEnv({
      ...Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])),
      RUN_LIVE_MODEL_TESTS: "1",
      RUN_MIXED_LIVE_TESTS: "1",
      LIVE_MIXED_WORKER_PROVIDER: "unknown",
    }, () => {
      assert.match(liveSkipReason(MIXED_PROVIDER_TARGET), /LIVE_MIXED_WORKER_PROVIDER/);
    });

    withEnv({
      ...Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])),
      RUN_LIVE_MODEL_TESTS: "1",
      RUN_MIXED_LIVE_TESTS: "1",
      LIVE_MIXED_COMBO: "unknown",
    }, () => {
      assert.match(liveSkipReason(MIXED_PROVIDER_TARGET), /LIVE_MIXED_COMBO/);
    });
  });

  it("classifies transient provider quota and rate-limit failures as skippable by default", () => {
    withEnv(Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])), () => {
      const reason = transientProviderSkipReason(
        MIXED_PROVIDER_TARGET,
        ["reviewer", "worker"],
        "Provider returned 429: quota exceeded. Please try again later."
      );

      assert.match(reason, /transient provider capacity\/quota/);
      assert.match(reason, /reviewer: alias=mixed-live-reviewer provider=codex model=gpt-5\.4-mini/);
      assert.match(reason, /worker: alias=mixed-live-worker provider=kilo model=cli-default/);
    });

    withEnv({
      ...Object.fromEntries(MIXED_ENV_KEYS.map((key) => [key, undefined])),
      LIVE_SKIP_TRANSIENT_PROVIDER_ERRORS: "0",
    }, () => {
      assert.strictEqual(transientProviderSkipReason(MIXED_PROVIDER_TARGET, ["reviewer"], "429 rate limit"), "");
    });
  });

  it("uses a stable temp root for OpenCode live workspaces", () => {
    const previous = process.env.LIVE_TEST_TMPDIR;
    try {
      delete process.env.LIVE_TEST_TMPDIR;
      assert.strictEqual(liveTempDir("codex"), "");
      if (fs.existsSync("/private/tmp")) {
        assert.strictEqual(liveTempDir("opencode"), "/private/tmp");
      }

      process.env.LIVE_TEST_TMPDIR = "/tmp/custom-live-root";
      assert.strictEqual(liveTempDir("opencode"), "/tmp/custom-live-root");
      assert.strictEqual(liveTempDir("codex"), "/tmp/custom-live-root");
    } finally {
      if (previous === undefined) delete process.env.LIVE_TEST_TMPDIR;
      else process.env.LIVE_TEST_TMPDIR = previous;
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
