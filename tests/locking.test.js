'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { spawn, spawnSync } = require('node:child_process');

const { acquireLock, acquireInstanceLock, readCurrentRunId, updateJSON, updateJSONL, writeAtomic } = require('../scripts/lib/locking');

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

    const malformedLines = fs.readFileSync(`${jsonlFile}.malformed`, 'utf-8').split('\n').filter(Boolean);
    assert.deepStrictEqual(malformedLines, [
      'not-json-at-all',
      '\`\`\`',
      '  {"id": 2, "malformed": true  ',
      '\`\`\`json',
    ]);
  });

  it('updateJSONL quarantines malformed lines before rewriting and preserves write order', () => {
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

    const malformedLines = fs.readFileSync(`${jsonlFile}.malformed`, 'utf-8').split('\n').filter(Boolean);
    assert.deepStrictEqual(malformedLines, [
      'not json',
      '\`\`\`python',
      '\`\`\`',
    ]);
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

  // 7. acquireLock never exposes a half-formed lock dir (mkdir-without-pid).
  // Regression: the previous mkdir-then-write-pid sequence let a concurrent
  // acquirer read between the two writes, fall into the mtime-stale branch,
  // and rm a brand-new valid lock.
  it('exposes a complete pid file every time the lock dir is observed', async () => {
    // Spawn N parallel subprocesses that each acquire+hold-briefly+release the
    // same lock, while a watcher peeks at the lock dir on every iteration. If
    // the watcher ever sees the lock dir without a parseable pid file, the
    // half-formed window is back.
    const lockTarget = path.join(tmpDir, 'race.lock');
    fs.writeFileSync(lockTarget, '');

    const lockingModule = path.resolve(__dirname, '..', 'scripts', 'lib', 'locking');
    const workerSrc = `
      const { acquireLock } = require(${JSON.stringify(lockingModule)});
      const release = acquireLock(${JSON.stringify(lockTarget)}, { retries: 100, minTimeout: 5, maxTimeout: 20 });
      // Hold briefly so peers race against a live holder.
      const end = Date.now() + 10;
      while (Date.now() < end) {}
      release();
    `;

    let halfFormed = 0;
    let peeks = 0;
    let stop = false;
    const peeker = (async () => {
      const lockDirPath = `${lockTarget}.lock`;
      while (!stop) {
        // Atomically observe lockDir contents via readdirSync. If the dir was
        // renamed/removed between calls (concurrent release), we get ENOENT —
        // that's a peeker TOCTOU, not a half-formed lock. Only count it as
        // half-formed when readdir succeeds AND pid is missing.
        let entries;
        try {
          entries = fs.readdirSync(lockDirPath);
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
            await new Promise((r) => setImmediate(r));
            continue;
          }
          throw err;
        }
        peeks++;
        if (!entries.includes('pid')) {
          halfFormed++;
        } else {
          // pid file is listed — its contents must be parseable. Reading can
          // still race with cleanup; treat ENOENT as a TOCTOU and skip.
          try {
            const raw = fs.readFileSync(path.join(lockDirPath, 'pid'), 'utf-8');
            const pid = parseInt(raw, 10);
            if (!Number.isInteger(pid) || pid <= 0) halfFormed++;
          } catch (err) {
            if (err.code !== 'ENOENT') halfFormed++;
          }
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    const workers = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', workerSrc], { stdio: 'pipe' });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`worker exited ${code}: ${stderr}`));
      });
    }));

    await Promise.all(workers);
    stop = true;
    await peeker;

    assert.strictEqual(halfFormed, 0, `observed ${halfFormed} half-formed lock states across ${peeks} peeks`);
    // After all workers finish, the lock dir should be gone.
    assert.strictEqual(fs.existsSync(`${lockTarget}.lock`), false);
  });
});

describe('acquireInstanceLock run_id and live-loop detection', () => {
  let coordDir;

  beforeEach(() => {
    coordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-lock-coord-'));
  });

  afterEach(() => {
    try { fs.rmSync(coordDir, { recursive: true, force: true }); } catch {}
  });

  it('mints a run_id, persists it to coord/current_run.json, and readCurrentRunId returns it', () => {
    const handle = acquireInstanceLock(coordDir);
    try {
      assert.ok(handle.runId, 'runId should be returned');
      assert.match(handle.runId, /^run-\d{4}-\d{2}-\d{2}T/, 'runId should be ISO-stamped');

      const persisted = JSON.parse(fs.readFileSync(path.join(coordDir, 'current_run.json'), 'utf-8'));
      assert.strictEqual(persisted.run_id, handle.runId);
      assert.strictEqual(typeof persisted.started_at, 'string');
      assert.strictEqual(persisted.pid, process.pid);

      assert.strictEqual(readCurrentRunId(coordDir), handle.runId);
    } finally {
      handle.release();
    }
  });

  it('refuses to acquire when a sibling orchestrator-loop is running on the same coord (lock dir removed)', async () => {
    // Stand up a fake orchestrator-loop.js binary that just sleeps. We need the
    // command line to literally contain "orchestrator-loop.js --coord <coord>" so
    // the ps scan matches it the same way it would match a real loop.
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-loop-'));
    const fakeLoop = path.join(fakeDir, 'orchestrator-loop.js');
    fs.writeFileSync(fakeLoop, 'setInterval(() => {}, 1000);\n', 'utf-8');

    const child = spawn(process.execPath, [fakeLoop, '--coord', coordDir], {
      stdio: 'ignore',
      detached: false,
    });

    try {
      // Give ps a moment to see the process.
      await new Promise((r) => setTimeout(r, 150));

      // Sanity: make sure ps can actually see it; otherwise the test is meaningless.
      const ps = spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf-8' });
      const visible = (ps.stdout || '').split('\n').some((line) =>
        line.includes('orchestrator-loop.js') &&
        line.includes(`--coord ${coordDir}`) &&
        line.match(new RegExp(`\\b${child.pid}\\b`)),
      );
      if (!visible) return; // ps doesn't see it (e.g. unusual env); skip without failing.

      // No instance.lock dir exists — the "user deleted a stale lock" scenario.
      // Spawn a subprocess that calls acquireInstanceLock so its process.exit(1)
      // doesn't take down the test runner.
      const probe = spawnSync(process.execPath, [
        '-e',
        `const { acquireInstanceLock } = require(${JSON.stringify(path.resolve(__dirname, '..', 'scripts', 'lib', 'locking'))});` +
        `acquireInstanceLock(${JSON.stringify(coordDir)});`,
      ], { encoding: 'utf-8' });

      assert.strictEqual(probe.status, 1, `expected exit 1, got ${probe.status}. stderr:\n${probe.stderr}`);
      assert.match(probe.stderr, /Another orchestrator loop is already running/);
      assert.match(probe.stderr, new RegExp(`PID ${child.pid}`));
      assert.match(probe.stderr, /Detected via ps scan/);
    } finally {
      try { child.kill('SIGKILL'); } catch {}
      try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch {}
    }
  });
});
