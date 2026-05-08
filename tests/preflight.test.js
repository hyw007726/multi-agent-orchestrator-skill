'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { repoRoot } = require('./helpers/temp-project');

const preflightPath = path.join(repoRoot(), 'scripts', 'preflight.js');

describe('preflight CLI', () => {
  it('prints help without requiring a project config', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-help-'));
    try {
      const result = runPreflight(tmp, ['--help']);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /See header of .*preflight\.js for usage/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs install, template, and auth checks for a healthy configured CLI', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-auth-'));
    try {
      const healthPath = writeScript(tmp, 'health.js', [
        'process.stdout.write("health-ok\\n");',
      ]);
      const cliPath = writeScript(tmp, 'auth-cli.js', [
        'const fs = require("node:fs");',
        'const promptFile = process.argv[2];',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'if (!prompt.includes("Reply with the single word: OK")) process.exit(9);',
        'process.stdout.write("auth-ok\\n");',
      ]);

      writeConfig(tmp, [
        'module.exports = {',
        '  default_cli: "authfake",',
        '  orchestrator_cli: "authfake",',
        '  cli_templates: {',
        `    authfake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(cliPath)}, { prompt_file: true }] },`,
        '  },',
        '  cli_health_checks: {',
        `    authfake: ${JSON.stringify(`${shellQuote(process.execPath)} ${shellQuote(healthPath)}`)},`,
        '  },',
        '};',
      ]);

      const result = runPreflight(tmp, ['--timeout', '1000']);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /authfake \(install\): health-ok/);
      assert.match(result.stdout, /authfake \(template\): argv mode/);
      assert.match(result.stdout, /authfake \(auth\): auth-ok \(argv\)/);
      assert.match(result.stdout, /Preflight passed/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports missing health checks and missing auth templates', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-missing-'));
    try {
      const healthPath = writeScript(tmp, 'silent-health.js', [
        'process.exit(0);',
      ]);

      writeConfig(tmp, [
        'module.exports = {',
        '  default_cli: "templategap",',
        '  orchestrator_cli: "templategap",',
        '  cli_health_checks: {',
        `    templategap: ${JSON.stringify(`${shellQuote(process.execPath)} ${shellQuote(healthPath)}`)},`,
        '  },',
        '};',
      ]);

      const result = runPreflight(tmp, [
        '--timeout',
        '1000',
        '--cli',
        'templategap',
        '--cli',
        'missing-health',
      ]);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stdout, /templategap \(install\): \(silent OK\)/);
      assert.match(result.stdout, /templategap \(auth\): No spawn template/);
      assert.match(result.stdout, /missing-health \(install\): No health check configured/);
      assert.match(result.stderr, /Preflight FAILED/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports health-check timeouts and stderr tails', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-health-fail-'));
    try {
      const slowPath = writeScript(tmp, 'slow-health.js', [
        'setTimeout(() => {}, 1000);',
      ]);

      writeConfig(tmp, [
        'module.exports = {',
        '  default_cli: "slow",',
        '  orchestrator_cli: "slow",',
        '  cli_health_checks: {',
        `    slow: ${JSON.stringify(`${shellQuote(process.execPath)} ${shellQuote(slowPath)}`)},`,
        `    fail: ${JSON.stringify("printf 'first line\\nbad health tail\\n' >&2; exit 7")},`,
        '  },',
        '};',
      ]);

      const timeoutResult = runPreflight(tmp, [
        '--skip-auth',
        '--timeout',
        '20',
        '--cli',
        'slow',
      ]);

      assert.notStrictEqual(timeoutResult.status, 0);
      assert.match(timeoutResult.stdout, /slow \(install\): Timed out after 20ms/);
      assert.match(timeoutResult.stderr, /Preflight FAILED/);

      const failureResult = runPreflight(tmp, [
        '--skip-auth',
        '--timeout',
        '1000',
        '--cli',
        'fail',
      ]);

      assert.notStrictEqual(failureResult.status, 0);
      assert.match(failureResult.stdout, /fail \(install\): Exit 7 .*bad health tail/);
      assert.match(failureResult.stderr, /Preflight FAILED/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function runPreflight(cwd, args) {
  return spawnSync(process.execPath, [preflightPath, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
}

function writeConfig(dir, lines) {
  fs.writeFileSync(path.join(dir, 'orchestrator.config.js'), lines.join('\n') + '\n', 'utf-8');
}

function writeScript(dir, name, bodyLines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "'use strict';",
    ...bodyLines,
  ].join('\n') + '\n', 'utf-8');
  return file;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
