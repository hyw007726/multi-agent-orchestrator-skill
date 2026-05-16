"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  liveTempDir,
  liveTailCommand,
  roleModel,
  writeAllLiveProviderConfig,
  writeLiveProviderConfig,
  writeLiveWorkerConfig,
} = require("./live/helpers/live-harness");

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
