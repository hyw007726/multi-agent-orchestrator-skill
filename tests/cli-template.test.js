'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildCliTemplateInvocation,
  shellQuote,
  spawnCliTemplateSync,
  validateCliTemplate,
} = require('../scripts/lib/cli-template');

describe('CLI template execution', () => {
  it('runs structured templates in argv mode with prompt paths containing spaces and shell metacharacters', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-template-argv-'));
    try {
      const scriptPath = writePromptReader(tmp);
      const promptFile = path.join(tmp, 'prompt with spaces $(touch argv-injected).txt');
      fs.writeFileSync(promptFile, 'argv prompt content', 'utf-8');

      const template = {
        cmd: process.execPath,
        args: [scriptPath, { prompt_file: true }, '--literal', '$(touch extra-argv-injected)'],
      };
      const invocation = buildCliTemplateInvocation('argvfake', template, { promptFile });
      assert.strictEqual(invocation.mode, 'argv');
      assert.deepStrictEqual(invocation.args, [scriptPath, promptFile, '--literal', '$(touch extra-argv-injected)']);

      const { mode, result } = spawnCliTemplateSync('argvfake', template, {
        promptFile,
        cwd: tmp,
        encoding: 'utf-8',
      });

      assert.strictEqual(mode, 'argv');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /argv prompt content/);
      assert.ok(!fs.existsSync(path.join(tmp, 'argv-injected')), 'prompt path must not trigger command substitution');
      assert.ok(!fs.existsSync(path.join(tmp, 'extra-argv-injected')), 'argv args must not trigger command substitution');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps shell templates supported while quoting prompt paths and appended extra args', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-template-shell-'));
    try {
      const scriptPath = writePromptReader(tmp);
      const promptFile = path.join(tmp, 'prompt with spaces $(touch shell-injected).txt');
      fs.writeFileSync(promptFile, 'shell prompt content', 'utf-8');

      const template = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} {prompt_file}`;
      const { mode, result } = spawnCliTemplateSync('shellfake', template, {
        promptFile,
        extraArgs: ['$(touch extra-shell-injected)'],
        cwd: tmp,
        encoding: 'utf-8',
      });

      assert.strictEqual(mode, 'shell');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /shell prompt content/);
      assert.match(result.stdout, /\$\(touch extra-shell-injected\)/);
      assert.ok(!fs.existsSync(path.join(tmp, 'shell-injected')), 'quoted prompt path must not trigger command substitution');
      assert.ok(!fs.existsSync(path.join(tmp, 'extra-shell-injected')), 'quoted extra args must not trigger command substitution');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('validates structured templates and rejects interpolation inside argv strings', () => {
    const result = validateCliTemplate('bad', {
      cmd: 'fake',
      args: ['--message-file', '{prompt_file}'],
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.message, /prompt_file/);
  });

  it('preflight validates malformed templates even when auth checks are skipped', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-template-preflight-'));
    try {
      fs.writeFileSync(path.join(tmp, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "bad",',
        '  orchestrator_cli: "bad",',
        '  cli_templates: {',
        '    bad: { cmd: "fake", args: ["--message-file", "{prompt_file}"] },',
        '  },',
        `  cli_health_checks: { bad: ${JSON.stringify(`${JSON.stringify(process.execPath)} --version`)} },`,
        '};',
      ].join('\n') + '\n', 'utf-8');

      const result = spawnSync(process.execPath, [
        path.join(__dirname, '..', 'scripts', 'preflight.js'),
        '--skip-auth',
        '--cli',
        'bad',
      ], {
        cwd: tmp,
        encoding: 'utf-8',
      });

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stdout, /bad \(template\):/);
      assert.match(result.stdout, /prompt_file/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function writePromptReader(dir) {
  const scriptPath = path.join(dir, 'read-prompt.js');
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("node:fs");',
    'const promptFile = process.argv[2];',
    'console.log(fs.readFileSync(promptFile, "utf-8"));',
    'console.log(process.argv.slice(3).join("\\n"));',
  ].join('\n') + '\n', 'utf-8');
  return scriptPath;
}
