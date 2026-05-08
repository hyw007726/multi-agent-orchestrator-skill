'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

describe('config merging', () => {
  it('returns defaults when no orchestrator.config.js exists', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(emptyDir);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'kilo');
    assert.strictEqual(config.orchestrator_cli, 'claude');
    assert.strictEqual(config.default_timeout_mins, 10);
    assert.strictEqual(config.default_progress_timeout_mins, 15);
    assert.strictEqual(config.default_max_restarts, 3);
    assert.strictEqual(config.orchestrator_failure_threshold, 5);
    assert.strictEqual(config.claude_failure_threshold, 5);
    assert.strictEqual(config.poll_min_ms, 1000);
    assert.strictEqual(config.poll_max_ms, 15000);
    assert.strictEqual(config.launch_dashboard, false);
    assert.strictEqual(config.launch_review_terminal, false);

    // Verify cli_templates defaults are present for all known CLIs.
    assert.ok(config.cli_templates, 'cli_templates should exist');
    assert.ok(config.cli_templates.kilo, 'kilo template should exist');
    assert.ok(config.cli_templates.aider, 'aider template should exist');
    assert.ok(config.cli_templates.claude, 'claude template should exist');
    assert.ok(config.cli_templates.gemini, 'gemini template should exist');
    assert.ok(config.cli_templates.codex, 'codex template should exist');
    assert.ok(config.cli_templates.opencode, 'opencode template should exist');
    assert.ok(config.cli_templates.kilo.includes('kilo'), 'kilo template should contain "kilo"');
    assert.strictEqual(config.cli_templates.aider.cmd, 'aider', 'aider should use argv template mode');
    assert.strictEqual(config.cli_templates.claude.cmd, 'claude', 'claude should use argv template mode');
    assert.strictEqual(config.cli_templates.codex.cmd, 'codex', 'codex should use argv template mode');
    assert.ok(config.cli_templates.codex.args.includes('exec'), 'codex should use the exec subcommand');
    assert.ok(!config.cli_templates.codex.args.includes('--exec'), 'codex should not use the removed --exec flag');

    // Verify cli_health_checks defaults are present.
    assert.ok(config.cli_health_checks, 'cli_health_checks should exist');
    assert.ok(config.cli_health_checks.kilo, 'kilo health check should exist');
    assert.ok(config.cli_health_checks.aider, 'aider health check should exist');
    assert.ok(config.cli_health_checks.claude, 'claude health check should exist');
  });

  it('overrides scalar fields from orchestrator.config.js', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "aider",',
        '  orchestrator_cli: "gemini",',
        '  default_timeout_mins: 20,',
        '  default_progress_timeout_mins: 30,',
        '  default_max_restarts: 5,',
        '  orchestrator_failure_threshold: 10,',
        '  poll_min_ms: 500,',
        '  poll_max_ms: 30000,',
        '  launch_dashboard: true,',
        '  launch_review_terminal: true,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'aider');
    assert.strictEqual(config.orchestrator_cli, 'gemini');
    assert.strictEqual(config.default_timeout_mins, 20);
    assert.strictEqual(config.default_progress_timeout_mins, 30);
    assert.strictEqual(config.default_max_restarts, 5);
    assert.strictEqual(config.orchestrator_failure_threshold, 10);
    assert.strictEqual(config.claude_failure_threshold, 10);
    assert.strictEqual(config.poll_min_ms, 500);
    assert.strictEqual(config.poll_max_ms, 30000);
    assert.strictEqual(config.launch_dashboard, true);
    assert.strictEqual(config.launch_review_terminal, true);
  });

  it('merges cli_templates - project values override defaults, omitted CLIs keep defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  cli_templates: {',
        '    kilo: \'custom-kilo --prompt {prompt_file}\',',
        '    aider: \'custom-aider -f {prompt_file} --model gpt-4\',',
        '  },',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Project overrides should take effect.
    assert.strictEqual(config.cli_templates.kilo, 'custom-kilo --prompt {prompt_file}');
    assert.strictEqual(config.cli_templates.aider, 'custom-aider -f {prompt_file} --model gpt-4');

    // Unspecified CLIs should keep the built-in defaults.
    assert.ok(config.cli_templates.claude, 'claude template should still exist from defaults');
    assert.ok(templateContains(config.cli_templates.claude, 'claude'), 'claude template should contain "claude"');
    assert.ok(config.cli_templates.gemini, 'gemini template should still exist from defaults');
    assert.ok(config.cli_templates.codex, 'codex template should still exist from defaults');
    assert.ok(config.cli_templates.opencode, 'opencode template should still exist from defaults');
  });

  it('merges cli_health_checks - project values override defaults, omitted CLIs keep defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  cli_health_checks: {',
        '    kilo: "custom-kilo --health",',
        '    aider: "custom-aider --health",',
        '  },',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Project overrides should take effect.
    assert.strictEqual(config.cli_health_checks.kilo, 'custom-kilo --health');
    assert.strictEqual(config.cli_health_checks.aider, 'custom-aider --health');

    // Unspecified CLIs should keep the built-in defaults.
    assert.ok(config.cli_health_checks.claude, 'claude health check should still exist from defaults');
    assert.ok(config.cli_health_checks.claude.includes('claude'), 'claude health check should contain "claude"');
    assert.ok(config.cli_health_checks.gemini, 'gemini health check should still exist from defaults');
    assert.ok(config.cli_health_checks.codex, 'codex health check should still exist from defaults');
    assert.ok(config.cli_health_checks.opencode, 'opencode health check should still exist from defaults');
  });

  it('handles partial overrides - unspecified scalar fields keep defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "codex",',
        '  poll_min_ms: 2000,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Overridden.
    assert.strictEqual(config.default_cli, 'codex');
    assert.strictEqual(config.poll_min_ms, 2000);

    // Unspecified - should keep defaults.
    assert.strictEqual(config.orchestrator_cli, 'claude');
    assert.strictEqual(config.default_timeout_mins, 10);
    assert.strictEqual(config.default_max_restarts, 3);
    assert.strictEqual(config.orchestrator_failure_threshold, 5);
    assert.strictEqual(config.claude_failure_threshold, 5);
    assert.strictEqual(config.poll_max_ms, 15000);
    assert.strictEqual(config.launch_dashboard, false);
    assert.strictEqual(config.launch_review_terminal, false);

    // Templates and health checks should still have full defaults.
    assert.ok(config.cli_templates.kilo && config.cli_templates.kilo.includes('kilo'));
    assert.ok(config.cli_health_checks.kilo && config.cli_health_checks.kilo.includes('kilo'));
  });

  it('ignores non-standard keys in the config file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "kilo",',
        '  unsupported_key: "should-be-ignored",',
        '  another_random: 42,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'kilo');
    // Extra keys should NOT leak onto the merged config.
    assert.strictEqual(config.unsupported_key, undefined);
    assert.strictEqual(config.another_random, undefined);
  });

  it('accepts claude_failure_threshold as a deprecated alias', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  claude_failure_threshold: 9,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.orchestrator_failure_threshold, 9);
    assert.strictEqual(config.claude_failure_threshold, 9);
  });
});

function templateContains(template, text) {
  if (typeof template === 'string') return template.includes(text);
  return template && (template.cmd === text || (Array.isArray(template.args) && template.args.includes(text)));
}
