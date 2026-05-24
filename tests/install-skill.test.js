'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { repoRoot } = require('./helpers/temp-project');

describe('install skill scripts', () => {
  it('syncs the canonical tree from SOURCE_DIR', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
    const source = repoRoot();
    const script = path.join(source, 'install-codex.sh');

    const result = spawnSync('sh', [script], {
      env: { ...process.env, SOURCE_DIR: source, DEST: dest },
      encoding: 'utf-8',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const installedSkill = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8');
    const canonicalSkill = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf-8');
    assert.strictEqual(installedSkill, canonicalSkill);
    assert.ok(fs.existsSync(path.join(dest, 'scripts', 'status.js')));
    assert.ok(fs.existsSync(path.join(dest, 'scripts', 'integrate-agent.js')));
  });

  it('replaces a stale SKILL.md snapshot when syncing from SOURCE_DIR', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-legacy-'));
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '# stale snapshot\n');
    const source = repoRoot();
    const script = path.join(source, 'install-codex.sh');

    const result = spawnSync('sh', [script], {
      env: { ...process.env, SOURCE_DIR: source, DEST: dest },
      encoding: 'utf-8',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.notStrictEqual(
      fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8'),
      '# stale snapshot\n',
    );
    assert.ok(fs.existsSync(path.join(dest, 'scripts', 'integrate-agent.js')));
  });
});
