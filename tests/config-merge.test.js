'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

describe('config merging', () => {
  it('returns defaults when no supported config file exists', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(emptyDir);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'kilo');
    assert.strictEqual(config.orchestrator_cli, 'kilo');
    assert.strictEqual(config.planner_cli, undefined);
    assert.strictEqual(config.default_timeout_mins, 10);
    assert.strictEqual(config.default_progress_timeout_mins, 15);
    assert.strictEqual(config.orchestrator_cli_timeout_ms, 120000);
    assert.strictEqual(config.default_max_restarts, 3);
    assert.strictEqual(config.orchestrator_failure_threshold, 5);
    assert.strictEqual(config.claude_failure_threshold, 5);
    assert.strictEqual(config.poll_min_ms, 1000);
    assert.strictEqual(config.poll_max_ms, 15000);
    assert.strictEqual(config.launch_dashboard, 'auto');
    assert.strictEqual(config.launch_review_terminal, false);
    assert.deepStrictEqual(config.reviewers, []);
    assert.strictEqual(config.max_plan_review_iterations, 'auto');

    // Verify cli_templates defaults are present for all known CLIs.
    assert.ok(config.cli_templates, 'cli_templates should exist');
    assert.ok(config.cli_templates.kilo, 'kilo template should exist');
    assert.ok(config.cli_templates.claude, 'claude template should exist');
    assert.ok(config.cli_templates.gemini, 'gemini template should exist');
    assert.ok(config.cli_templates.codex, 'codex template should exist');
    assert.ok(config.cli_templates.opencode, 'opencode template should exist');
    assert.ok(config.cli_templates.kilo.includes('kilo'), 'kilo template should contain "kilo"');
    assert.strictEqual(config.cli_templates.claude.cmd, 'claude', 'claude should use argv template mode');
    assert.strictEqual(config.cli_templates.codex.cmd, 'codex', 'codex should use argv template mode');
    assert.ok(config.cli_templates.codex.args.includes('exec'), 'codex should use the exec subcommand');
    assert.ok(!config.cli_templates.codex.args.includes('--exec'), 'codex should not use the removed --exec flag');

    // Verify cli_health_checks defaults are present.
    assert.ok(config.cli_health_checks, 'cli_health_checks should exist');
    assert.ok(config.cli_health_checks.kilo, 'kilo health check should exist');
    assert.ok(config.cli_health_checks.claude, 'claude health check should exist');
  });

  it('loads JSONC config with comments and trailing commas', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.jsonc'), [
        '{',
        '  // JSONC is the preferred data-only config format.',
        '  "default_cli": "codex",',
        '  "orchestrator_cli": "claude",',
        '  "default_timeout_mins": 12,',
        '  "cli_templates": {',
        '    "codex": { "cmd": "codex", "args": ["exec", { "prompt_text": true }, "--model", "gpt-5.4-mini"] },',
        '  },',
        '  "cli_health_checks": {',
        '    "codex": "codex --version",',
        '  },',
        '}',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'codex');
    assert.strictEqual(config.orchestrator_cli, 'claude');
    assert.strictEqual(config.default_timeout_mins, 12);
    assert.deepStrictEqual(config.cli_templates.codex, {
      cmd: 'codex',
      args: ['exec', { prompt_text: true }, '--model', 'gpt-5.4-mini'],
    });
    assert.strictEqual(config.cli_health_checks.codex, 'codex --version');
    assert.ok(config.cli_templates.kilo, 'omitted built-in templates should still be present');
  });

  it('keeps the shipped JSONC config and schema parseable', () => {
    const repoRoot = path.join(__dirname, '..');
    const { stripJsonc } = require(path.join(repoRoot, 'scripts', 'lib', 'config'));
    const configPath = path.join(repoRoot, 'orchestrator.config.jsonc');
    const config = JSON.parse(stripJsonc(fs.readFileSync(configPath, 'utf-8')));
    const schemaPath = path.join(repoRoot, 'references', 'orchestrator-config.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

    assert.strictEqual(config.$schema, 'https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/references/orchestrator-config.schema.json');
    assert.strictEqual(schema.title, 'Multi-Agent Orchestrator Configuration');
    assert.ok(schema.properties.default_cli);
    assert.ok(schema.properties.cli_templates);
  });

  it('prefers JSONC over legacy JavaScript config when both exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.jsonc'), '{ "default_cli": "gemini" }\n', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), 'module.exports = { default_cli: "codex" };\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'gemini');
    assert.strictEqual(config.orchestrator_cli, 'gemini');
  });

  it('layers local JSONC overrides on top of the shared project config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.jsonc'), [
        '{',
        '  "default_cli": "codex",',
        '  "orchestrator_cli": "claude",',
        '  "default_timeout_mins": 12,',
        '  "cli_templates": {',
        '    "codex": { "cmd": "codex", "args": ["exec", { "prompt_text": true }] }',
        '  },',
        '  "cli_health_checks": {',
        '    "codex": "codex --version"',
        '  }',
        '}',
      ].join('\n') + '\n', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.local.jsonc'), [
        '{',
        '  // Personal overrides only.',
        '  "default_cli": "localworker",',
        '  "launch_dashboard": false,',
        '  "cli_templates": {',
        '    "localworker": { "cmd": "node", "args": ["worker.js", { "prompt_file": true }, "--model", "local-model"] },',
        '  },',
        '  "cli_health_checks": {',
        '    "localworker": "node --version",',
        '  },',
        '}',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'localworker');
    assert.strictEqual(config.orchestrator_cli, 'claude');
    assert.strictEqual(config.default_timeout_mins, 12);
    assert.strictEqual(config.launch_dashboard, false);
    assert.deepStrictEqual(config.cli_templates.codex, {
      cmd: 'codex',
      args: ['exec', { prompt_text: true }],
    });
    assert.deepStrictEqual(config.cli_templates.localworker, {
      cmd: 'node',
      args: ['worker.js', { prompt_file: true }, '--model', 'local-model'],
    });
    assert.strictEqual(config.cli_health_checks.codex, 'codex --version');
    assert.strictEqual(config.cli_health_checks.localworker, 'node --version');
  });

  it('allows local config alone and lets null orchestrator_cli follow the final worker CLI', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.local.json'), [
        '{',
        '  "default_cli": "gemini",',
        '  "orchestrator_cli": null',
        '}',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.default_cli, 'gemini');
    assert.strictEqual(config.orchestrator_cli, 'gemini');
    assert.strictEqual(config.default_timeout_mins, 10);
  });

  it('overrides scalar fields from orchestrator.config.js', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "codex",',
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

    assert.strictEqual(config.default_cli, 'codex');
    assert.strictEqual(config.orchestrator_cli, 'gemini');
    assert.strictEqual(config.planner_cli, undefined);
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

  it('rejects invalid timeout, restart, failure-threshold, and poll values', () => {
    const cases = [
      [['default_timeout_mins: 0,'], /default_timeout_mins must be a positive number/],
      [['default_progress_timeout_mins: -1,'], /default_progress_timeout_mins must be a positive number/],
      [['orchestrator_cli_timeout_ms: 1.5,'], /orchestrator_cli_timeout_ms must be a positive integer/],
      [['default_max_restarts: -1,'], /default_max_restarts must be a non-negative integer/],
      [['orchestrator_failure_threshold: 0,'], /orchestrator_failure_threshold must be a positive integer/],
      [['claude_failure_threshold: 0,'], /claude_failure_threshold must be a positive integer/],
      [['poll_min_ms: 0,'], /poll_min_ms must be a positive integer/],
      [['poll_max_ms: 0,'], /poll_max_ms must be a positive integer/],
      [['poll_min_ms: 1000,', 'poll_max_ms: 500,'], /poll_min_ms \(1000\) must be less than or equal to poll_max_ms \(500\)/],
    ];

    for (const [bodyLines, pattern] of cases) {
      assertConfigThrows(bodyLines, pattern);
    }
  });

  it('rejects invalid dashboard settings', () => {
    assertConfigThrows(['launch_dashboard: "yes",'], /launch_dashboard must be "auto", true, or false/);
    assertConfigThrows(['launch_review_terminal: "auto",'], /launch_review_terminal must be a boolean/);
  });

  it('merges cli_templates - project values override defaults, omitted CLIs keep defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  cli_templates: {',
        '    kilo: \'custom-kilo --prompt {prompt_file}\',',
        '    localworker: \'custom-worker -f {prompt_file} --model local-model\',',
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
    assert.strictEqual(config.cli_templates.localworker, 'custom-worker -f {prompt_file} --model local-model');

    // Unspecified CLIs should keep the built-in defaults.
    assert.ok(config.cli_templates.claude, 'claude template should still exist from defaults');
    assert.ok(templateContains(config.cli_templates.claude, 'claude'), 'claude template should contain "claude"');
    assert.ok(config.cli_templates.gemini, 'gemini template should still exist from defaults');
    assert.ok(config.cli_templates.codex, 'codex template should still exist from defaults');
    assert.ok(config.cli_templates.opencode, 'opencode template should still exist from defaults');
  });

  it('rejects invalid cli template and health-check containers', () => {
    assertConfigThrows(['cli_templates: [],'], /cli_templates must be an object/);
    assertConfigThrows(['cli_health_checks: [],'], /cli_health_checks must be an object/);
    assertConfigThrows(['cli_health_checks: { bad: "" },'], /cli_health_checks\.bad must be a non-empty string/);
  });

  it('merges cli_health_checks - project values override defaults, omitted CLIs keep defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  cli_health_checks: {',
        '    kilo: "custom-kilo --health",',
        '    localworker: "custom-worker --health",',
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
    assert.strictEqual(config.cli_health_checks.localworker, 'custom-worker --health');

    // Unspecified CLIs should keep the built-in defaults.
    assert.ok(config.cli_health_checks.claude, 'claude health check should still exist from defaults');
    assert.ok(config.cli_health_checks.claude.includes('claude'), 'claude health check should contain "claude"');
    assert.ok(config.cli_health_checks.gemini, 'gemini health check should still exist from defaults');
    assert.ok(config.cli_health_checks.codex, 'codex health check should still exist from defaults');
    assert.ok(config.cli_health_checks.opencode, 'opencode health check should still exist from defaults');
  });

  it('uses default_cli as the orchestrator_cli when no explicit role CLI is set', () => {
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

    // Unspecified orchestrator_cli follows the worker CLI.
    assert.strictEqual(config.orchestrator_cli, 'codex');
    assert.strictEqual(config.planner_cli, undefined);
    assert.strictEqual(config.default_timeout_mins, 10);
    assert.strictEqual(config.default_max_restarts, 3);
    assert.strictEqual(config.orchestrator_failure_threshold, 5);
    assert.strictEqual(config.claude_failure_threshold, 5);
    assert.strictEqual(config.poll_max_ms, 15000);
    assert.strictEqual(config.launch_dashboard, 'auto');
    assert.strictEqual(config.launch_review_terminal, false);

    // Templates and health checks should still have full defaults.
    assert.ok(config.cli_templates.kilo && config.cli_templates.kilo.includes('kilo'));
    assert.ok(config.cli_health_checks.kilo && config.cli_health_checks.kilo.includes('kilo'));
  });

  it('rejects non-standard keys in the config file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "kilo",',
        '  planner_cli: "unsupported",',
        '  unsupported_key: "should-be-ignored",',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      assert.throws(
        () => loadConfig(tmpDir),
        /Unsupported config key 'planner_cli'.*orchestrator-config\.schema\.json/
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects configs that do not parse to an object', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), 'module.exports = [];\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      assert.throws(() => loadConfig(tmpDir), /orchestrator config must export or parse to an object/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it('accepts launch_dashboard auto mode explicitly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  launch_dashboard: "auto",',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.launch_dashboard, 'auto');
  });

  it('parses reviewer config and numeric plan review iterations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    let config;
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  max_plan_review_iterations: 2,',
        '  reviewers: [',
        '    {',
        '      name: "architecture",',
        '      cli: "reviewfake",',
        '      model: "review-model",',
        '      model_flag: "--model-id",',
        '      template_args: ["--json"],',
        '      timeout_mins: 0.25,',
        '      review_focus: "ownership boundaries",',
        '    },',
        '  ],',
        '  cli_templates: {',
        '    reviewfake: { cmd: "node", args: ["reviewer.js", { prompt_file: true }] },',
        '  },',
        '  cli_health_checks: {',
        '    reviewfake: "node --version",',
        '  },',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      config = loadConfig(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.strictEqual(config.max_plan_review_iterations, 2);
    assert.deepStrictEqual(config.reviewers, [
      {
        name: 'architecture',
        cli: 'reviewfake',
        model: 'review-model',
        model_flag: '--model-id',
        template_args: ['--json'],
        timeout_mins: 0.25,
        review_focus: 'ownership boundaries',
      },
    ]);
  });

  it('rejects reviewer config values that violate the runtime schema', () => {
    assertConfigThrows(['reviewers: "architecture",'], /reviewers must be an array/);
    assertConfigThrows([
      'reviewers: [{ name: "architecture", cli: "reviewfake", review_focus: "ownership", unexpected: true }],',
    ], /reviewers\[0\]\.unexpected is not supported/);
    assertConfigThrows([
      'reviewers: [{ name: "architecture", cli: "reviewfake", review_focus: "ownership", timeout_mins: 0 }],',
      'cli_templates: { reviewfake: { cmd: "node", args: ["reviewer.js", { prompt_file: true }] } },',
      'cli_health_checks: { reviewfake: "node --version" },',
    ], /reviewers\[0\]\.timeout_mins must be a positive number/);
    assertConfigThrows([
      'reviewers: [{ name: "architecture", cli: "reviewfake", review_focus: "ownership", template_args: [""] }],',
      'cli_templates: { reviewfake: { cmd: "node", args: ["reviewer.js", { prompt_file: true }] } },',
      'cli_health_checks: { reviewfake: "node --version" },',
    ], /reviewers\[0\]\.template_args\[0\] must be a non-empty string/);
  });

  it('rejects reviewer CLIs without templates or health checks', () => {
    const tmpMissingTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    const tmpMissingHealth = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    try {
      fs.writeFileSync(path.join(tmpMissingTemplate, 'orchestrator.config.js'), [
        'module.exports = {',
        '  reviewers: [{ name: "reviewer", cli: "notempl", review_focus: "boundaries" }],',
        '  cli_health_checks: { notempl: "node --version" },',
        '};',
      ].join('\n') + '\n', 'utf-8');

      fs.writeFileSync(path.join(tmpMissingHealth, 'orchestrator.config.js'), [
        'module.exports = {',
        '  reviewers: [{ name: "reviewer", cli: "nohealth", review_focus: "boundaries" }],',
        '  cli_templates: { nohealth: { cmd: "node", args: ["reviewer.js", { prompt_file: true }] } },',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      assert.throws(() => loadConfig(tmpMissingTemplate), /cli_templates\.notempl/);
      assert.throws(() => loadConfig(tmpMissingHealth), /cli_health_checks\.nohealth/);
    } finally {
      fs.rmSync(tmpMissingTemplate, { recursive: true, force: true });
      fs.rmSync(tmpMissingHealth, { recursive: true, force: true });
    }
  });

  it('rejects invalid max_plan_review_iterations values', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
        'module.exports = {',
        '  max_plan_review_iterations: 0,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
      assert.throws(() => loadConfig(tmpDir), /max_plan_review_iterations/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function assertConfigThrows(bodyLines, pattern) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.js'), [
      'module.exports = {',
      ...bodyLines.map((line) => `  ${line}`),
      '};',
    ].join('\n') + '\n', 'utf-8');

    const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
    assert.throws(() => loadConfig(tmpDir), pattern);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function templateContains(template, text) {
  if (typeof template === 'string') return template.includes(text);
  return template && (template.cmd === text || (Array.isArray(template.args) && template.args.includes(text)));
}
