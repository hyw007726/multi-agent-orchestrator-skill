'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { acquireLock, updateJSON, updateJSONL, writeAtomic } = require('../scripts/lib/locking');

describe('locking primitives', () => {
  let tmpDir;
  let testFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locking-test-'));
    testFile = path.join(tmpDir, 'test.lock');
    fs.writeFileSync(testFile, '');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // 1. acquireLock creates <file>.lock/pid and release removes the lock dir.
  it('creates lock dir with pid file and release removes it', () => {
    const lockDir = `${testFile}.lock`;
    assert.strictEqual(fs.existsSync(lockDir), false);

    const release = acquireLock(testFile, { retries: 0 });
    assert.strictEqual(fs.existsSync(lockDir), true);

    const pidFile = path.join(lockDir, 'pid');
    assert.strictEqual(fs.existsSync(pidFile), true);
    assert.strictEqual(fs.readFileSync(pidFile, 'utf-8'), String(process.pid));

    release();
    assert.strictEqual(fs.existsSync(lockDir), false);
  });

  // 2. Held lock failure: second acquire throws ELOCKED.
  it('throws ELOCKED when lock is already held', () => {
    const release = acquireLock(testFile, { retries: 0 });
    let thrown;
    try {
      acquireLock(testFile, { retries: 0 });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'should have thrown');
    assert.strictEqual(thrown.code, 'ELOCKED');
    release();
  });

  // 3. Stale lock recovery by dead PID.
  it('recovers stale lock when holder PID is dead', () => {
    const lockDir = `${testFile}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '99999999');

    const release = acquireLock(testFile, { retries: 0 });
    assert.strictEqual(fs.existsSync(lockDir), true);
    // pid file should be rewritten to the current process PID
    assert.strictEqual(fs.readFileSync(path.join(lockDir, 'pid'), 'utf-8'), String(process.pid));
    release();
  });

  // 4. Mtime fallback recovery.
  it('recovers stale lock by mtime fallback when pid file is unreadable', () => {
    const lockDir = `${testFile}.lock`;
    fs.mkdirSync(lockDir);
    // No pid file written — simulate unreadable pid

    const oldDate = new Date(2000, 0, 1);
    fs.utimesSync(lockDir, oldDate, oldDate);

    const release = acquireLock(testFile, { retries: 0, stale: 1 });
    assert.strictEqual(fs.existsSync(lockDir), true);
    assert.strictEqual(fs.readFileSync(path.join(lockDir, 'pid'), 'utf-8'), String(process.pid));
    release();
  });

  // 5. updateJSON atomic write behavior.
  it('updateJSON mutates JSON atomically without leaving tmp files', () => {
    const jsonFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(jsonFile, JSON.stringify({ count: 0, items: [] }));

    updateJSON(jsonFile, (data) => {
      data.count = 1;
      data.items.push('a');
    });

    const contents = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    assert.strictEqual(contents.count, 1);
    assert.deepStrictEqual(contents.items, ['a']);

    // No sibling .tmp.* file should remain
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('data.json.tmp.'));
    assert.strictEqual(tmpFiles.length, 0, `tmp files left behind: ${tmpFiles.join(', ')}`);
  });

  it('updateJSON uses returned value when mutator returns a new object', () => {
    const jsonFile = path.join(tmpDir, 'data2.json');
    fs.writeFileSync(jsonFile, JSON.stringify({ old: true }));

    updateJSON(jsonFile, () => ({ new: true, built: 'from scratch' }));

    const contents = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    assert.deepStrictEqual(contents, { new: true, built: 'from scratch' });
  });

  // 6. updateJSONL malformed-line behavior.
  it('updateJSONL skips malformed and fenced-code lines, preserves valid records', () => {
    const jsonlFile = path.join(tmpDir, 'data.jsonl');
    fs.writeFileSync(jsonlFile, [
      JSON.stringify({ id: 1, valid: true }),
      'not-json-at-all',
      '\`\`\`',
      '  {"id": 2, "malformed": true  ', // trailing space + unclosed
      '\`\`\`json',
      JSON.stringify({ id: 3, valid: true }),
      '', // empty line should be skipped
    ].join('\n'));

    updateJSONL(jsonlFile, (data) => {
      // Mutator sees only valid records (id:1 and id:3)
      assert.strictEqual(data.length, 2, 'should have 2 valid records');
      assert.strictEqual(data[0].id, 1);
      assert.strictEqual(data[1].id, 3);
      // Append a new record
      data.push({ id: 4, appended: true });
      // Update an existing record
      data[0].modified = true;
    });

    const lines = fs.readFileSync(jsonlFile, 'utf-8').split('\n').filter(l => l.trim() !== '');
    assert.ok(lines.length >= 3, 'should have at least 3 valid records');

    const parsed = lines.map(l => JSON.parse(l));
    const byId = new Map(parsed.map(r => [r.id, r]));
    assert.ok(byId.has(1));
    assert.strictEqual(byId.get(1).modified, true);
    assert.ok(byId.has(3));
    assert.ok(byId.has(4));
    assert.strictEqual(byId.get(4).appended, true);
    // No malformed or fenced-code lines should be present
    for (const record of parsed) {
      assert.ok(typeof record.id === 'number', `record should have numeric id: ${JSON.stringify(record)}`);
    }
  });

  it('updateJSONL never writes malformed lines back and preserves write order', () => {
    const jsonlFile = path.join(tmpDir, 'data3.jsonl');
    // Write only malformed/fenced lines
    fs.writeFileSync(jsonlFile, [
      'not json',
      '\`\`\`python',
      '\`\`\`',
    ].join('\n'));

    updateJSONL(jsonlFile, (data) => {
      // All malformed — data array is empty
      assert.strictEqual(data.length, 0);
      // Append from scratch
      data.push({ fresh: 1 });
    });

    const lines = fs.readFileSync(jsonlFile, 'utf-8').split('\n').filter(l => l.trim() !== '');
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(JSON.parse(lines[0]), { fresh: 1 });
  });

  it('writeAtomic leaves no tmp files', () => {
    const targetFile = path.join(tmpDir, 'atom.txt');
    const before = fs.readdirSync(tmpDir).length;

    writeAtomic(targetFile, 'atomic content\n');

    assert.strictEqual(fs.readFileSync(targetFile, 'utf-8'), 'atomic content\n');
    const after = fs.readdirSync(tmpDir);
    const tmpFiles = after.filter(f => f.includes('.tmp.'));
    assert.strictEqual(tmpFiles.length, 0, `tmp files left behind: ${tmpFiles.join(', ')}`);
  });
});
