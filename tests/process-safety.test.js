'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pidMatchesCli, getProcessCommandMap, safeKill, REFUSAL_FALLBACK_THRESHOLD, _resetRefusalCounts } = require('../scripts/lib/process');
const { waitFor, cleanupProcess } = require('./helpers/temp-project');

// Shared — used by the waitForExitMs tests below. Spawns a worker via an
// intermediate `node -e` that exits immediately after detaching, so the worker
// is orphaned to init (PID 1). Production safeKill callers (orchestrator-loop)
// never parent their workers directly either — spawn-agent.js exits after
// detaching — so this mirrors the real reaping topology and avoids zombies
// piling up under the test runner while safeKill's blocking poll loop runs.
//
// `setupSrc` runs first in the worker. If it touches a ready-marker file, the
// caller can await its appearance to be sure subsequent signals reach an
// initialised worker rather than racing the JS startup window.
async function spawnOrphanedWorkerReady(setupSrc) {
  const readyFile = path.join(os.tmpdir(), `worker-ready-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const workerSrc = [
    setupSrc,
    `require("fs").writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const dispatcher = [
    'const cp = require("child_process");',
    `const child = cp.spawn(process.execPath, ["-e", ${JSON.stringify(workerSrc)}], { detached: true, stdio: "ignore" });`,
    'child.unref();',
    'process.stdout.write(String(child.pid));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', dispatcher], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`spawnOrphanedWorkerReady dispatcher failed: ${result.stderr}`);
  }
  const pid = parseInt(String(result.stdout).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`spawnOrphanedWorkerReady got non-numeric pid: ${result.stdout}`);
  }
  await waitFor(() => fs.existsSync(readyFile), { timeoutMs: 3000, intervalMs: 25 });
  try { fs.unlinkSync(readyFile); } catch {}
  return pid;
}

describe('process safety helpers', () => {
  // 1. pidMatchesCli returns true when the process CLI matches.
  it('pidMatchesCli returns true for a matching CLI', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      const result = pidMatchesCli(child.pid, 'node');
      assert.strictEqual(result, true);
    } finally {
      cleanupProcess(child);
    }
  });

  // 2. pidMatchesCli returns false when the expected CLI does not match.
  it('pidMatchesCli returns false for a mismatched CLI', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      const result = pidMatchesCli(child.pid, 'definitely-not-the-command');
      assert.strictEqual(result, false);
    } finally {
      cleanupProcess(child);
    }
  });

  it('pidMatchesCli compares the first argv basename instead of any substring', () => {
    const pid = 42424242;
    assert.strictEqual(
      pidMatchesCli(pid, 'codex', { cmdMap: new Map([[pid, '/opt/homebrew/bin/codex exec --json']]) }),
      true,
      'basename of the first argv token should match',
    );
    assert.strictEqual(
      pidMatchesCli(pid, '/opt/homebrew/bin/codex', { cmdMap: new Map([[pid, 'codex exec --json']]) }),
      true,
      'expected CLI may include a path',
    );
    assert.strictEqual(
      pidMatchesCli(pid, 'codex', { cmdMap: new Map([[pid, 'vim cli-templates/codex.md']]) }),
      false,
      'a later filename containing the CLI name must not match',
    );
    assert.strictEqual(
      pidMatchesCli(pid, 'codex', { cmdMap: new Map([[pid, 'tail /tmp/codex.log']]) }),
      false,
      'a log filename containing the CLI name must not match',
    );
  });

  // 3. safeKill skips when expectedCli does not match the process.
  it('safeKill skips on CLI mismatch and returns false', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      const logs = [];
      const result = safeKill({
        pid: child.pid,
        expectedCli: 'not-node',
        log: (msg) => logs.push(msg),
      });
      assert.strictEqual(result, false);
      assert.ok(
        logs.some((msg) => msg.includes('Skipping SIGTERM')),
        `expected skip log, got: ${logs.join('\n')}`
      );
      // Process should still be alive
      assert.strictEqual(child.exitCode, null);
    } finally {
      cleanupProcess(child);
    }
  });

  // 4. Already-exited PID handling.
  it('safeKill skips already-exited PIDs and returns false', async () => {
    const child = spawn('node', ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    await new Promise((resolve) => child.on('exit', resolve));

    const logs = [];
    const result = safeKill({
      pid: child.pid,
      expectedCli: 'node',
      log: (msg) => logs.push(msg),
    });
    assert.strictEqual(result, false);
    // pidMatchesCli returns false when the process is gone, so safeKill should log a skip
    assert.ok(
      logs.some((msg) => msg.includes('Skipping SIGTERM') || msg.includes('already exited')),
      `expected skip log, got: ${logs.join('\n')}`
    );
  });

  // 5. Process-group kill behavior.
  it('signals the detached worker process group, including child processes', {
    skip: process.platform === 'win32' ? 'POSIX process groups are not available on Windows' : false,
  }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-group-kill-'));
    const childScript = path.join(tempDir, 'child.js');
    const parentScript = path.join(tempDir, 'parent.js');
    const markerFile = path.join(tempDir, 'child-signalled.txt');
    const childReadyFile = path.join(tempDir, 'child-ready.txt');
    const pidsFile = path.join(tempDir, 'pids.json');
    let parent;

    try {
      fs.writeFileSync(childScript, [
        "'use strict';",
        'const fs = require("fs");',
        'const markerFile = process.argv[2];',
        'const readyFile = process.argv[3];',
        'fs.writeFileSync(readyFile, String(process.pid), "utf-8");',
        'process.on("SIGTERM", () => {',
        '  fs.writeFileSync(markerFile, "child received SIGTERM\\n", "utf-8");',
        '  process.exit(0);',
        '});',
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n', 'utf-8');

      fs.writeFileSync(parentScript, [
        "'use strict';",
        'const { spawn } = require("child_process");',
        'const fs = require("fs");',
        'const childScript = process.argv[2];',
        'const markerFile = process.argv[3];',
        'const readyFile = process.argv[4];',
        'const pidsFile = process.argv[5];',
        'const child = spawn(process.execPath, [childScript, markerFile, readyFile], { stdio: "ignore" });',
        'fs.writeFileSync(pidsFile, JSON.stringify({ parent: process.pid, child: child.pid }), "utf-8");',
        'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25));',
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n', 'utf-8');

      parent = spawn(process.execPath, [parentScript, childScript, markerFile, childReadyFile, pidsFile], {
        detached: true,
        stdio: 'ignore',
      });
      parent.unref();

      await waitFor(
        () => fs.existsSync(pidsFile) && fs.existsSync(childReadyFile),
        { timeoutMs: 3000, intervalMs: 50 }
      );

      const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf-8'));
      const logs = [];
      const killed = safeKill({
        pid: pids.parent,
        expectedCli: 'node',
        log: (message) => logs.push(message),
      });

      assert.strictEqual(killed, true);
      await waitFor(() => fs.existsSync(markerFile), { timeoutMs: 3000, intervalMs: 50 });
      assert.match(fs.readFileSync(markerFile, 'utf-8'), /child received SIGTERM/);
      assert.ok(
        logs.some((message) => message.includes('process group')),
        `expected process-group log line, got:\n${logs.join('\n')}`
      );
    } finally {
      if (parent?.pid) {
        try { process.kill(-parent.pid, 'SIGKILL'); } catch {}
        try { process.kill(parent.pid, 'SIGKILL'); } catch {}
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  // 6. pidMatchesCli accepts the recorded cmdline fallback only when the
  //    expected CLI appears as a token in both live and recorded command lines.
  it('pidMatchesCli gates wrapper substring fallback on the recorded cmdline', () => {
    const pid = 52525252;
    const recorded = '/bin/sh -c codex exec /tmp/original-prompt.txt';
    assert.strictEqual(
      pidMatchesCli(pid, 'codex', {
        recordedCmdline: recorded,
        cmdMap: new Map([[pid, '/bin/sh -c codex exec /tmp/current-prompt.txt']]),
      }),
      true,
      'shell wrappers should match when both live and recorded cmdlines contain the CLI token',
    );
    assert.strictEqual(
      pidMatchesCli(pid, 'codex', {
        recordedCmdline: recorded,
        cmdMap: new Map([[pid, '/bin/sh -c tail /tmp/codex.log']]),
      }),
      false,
      'matching wrapper binary alone is not enough when the live command only mentions a codex log file',
    );
    assert.strictEqual(
      pidMatchesCli(pid, 'not-codex', {
        recordedCmdline: recorded,
        cmdMap: new Map([[pid, '/bin/sh -c codex exec /tmp/current-prompt.txt']]),
      }),
      false,
      'the recorded fallback must also match the expected CLI token',
    );
    assert.strictEqual(
      pidMatchesCli(pid, 'codex', {
        recordedCmdline: recorded,
        cmdMap: new Map([[pid, '/bin/sh -c vim codex']]),
      }),
      false,
      'should not match if the token is just a filename argument to vim',
    );
  });

  // 7. After REFUSAL_FALLBACK_THRESHOLD refused checks, safeKill signals anyway
  //    when events.jsonl shows the orchestrator spawned the PID.
  it(`falls back to signalling after ${REFUSAL_FALLBACK_THRESHOLD} refused checks if events.jsonl confirms we spawned the PID`, async () => {
    _resetRefusalCounts();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-kill-fallback-'));
    const child = spawn('node', ['-e', [
      'process.title = "definitely-not-our-cli";',
      'setInterval(() => {}, 1000);',
      'process.on("SIGTERM", () => process.exit(0));',
    ].join('')], { stdio: 'ignore' });

    try {
      // Wait until ps reflects the new process title (process.title takes a tick).
      await waitFor(() => {
        const { getProcessCommand } = require('../scripts/lib/process');
        const live = getProcessCommand(child.pid);
        return live && !live.includes('node');
      }, { timeoutMs: 2000, intervalMs: 25 }).catch(() => null);

      // Seed events.jsonl with an agent_spawned event for this PID.
      const eventsPath = path.join(tempDir, 'events.jsonl');
      fs.writeFileSync(eventsPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'agent_spawned',
        agent: 'test-agent',
        pid: child.pid,
      }) + '\n', 'utf-8');

      const logs = [];
      const log = (msg) => logs.push(msg);

      // First N-1 calls should refuse without signalling.
      for (let i = 1; i < REFUSAL_FALLBACK_THRESHOLD; i++) {
        const result = safeKill({
          pid: child.pid,
          expectedCli: 'absolutely-not-the-process',
          coordDir: tempDir,
          agent: 'test-agent',
          log,
        });
        assert.strictEqual(result, false, `call ${i} should have refused`);
      }
      // On the threshold call, safeKill should fall back and signal.
      const result = safeKill({
        pid: child.pid,
        expectedCli: 'absolutely-not-the-process',
        coordDir: tempDir,
        agent: 'test-agent',
        log,
      });
      assert.strictEqual(result, true);
      assert.ok(
        logs.some((msg) => msg.includes('safeKill fallback') && msg.includes('events.jsonl')),
        `expected fallback log, got:\n${logs.join('\n')}`,
      );
      // signal_sent event with fallback marker should be appended.
      const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      const signalEvent = events.find((e) => e.event === 'signal_sent' && e.pid === child.pid);
      assert.ok(signalEvent, 'expected a signal_sent event for the fallback');
      assert.match(String(signalEvent.reason), /fallback/);
    } finally {
      cleanupProcess(child);
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  // 8. Without an agent_spawned event for the PID, the fallback declines.
  it('does not fall back when events.jsonl has no record of spawning the PID', async () => {
    _resetRefusalCounts();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-kill-no-fallback-'));
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

    try {
      // Empty events.jsonl ⇒ no proof we spawned this PID ⇒ no fallback.
      fs.writeFileSync(path.join(tempDir, 'events.jsonl'), '', 'utf-8');

      const logs = [];
      const log = (msg) => logs.push(msg);
      for (let i = 0; i < REFUSAL_FALLBACK_THRESHOLD + 2; i++) {
        const result = safeKill({
          pid: child.pid,
          expectedCli: 'absolutely-not-the-process',
          coordDir: tempDir,
          agent: 'test-agent',
          log,
        });
        assert.strictEqual(result, false, `call ${i + 1} should still refuse without spawn evidence`);
      }
      // Process must still be alive.
      assert.strictEqual(child.exitCode, null);
    } finally {
      cleanupProcess(child);
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  // 9a. waitForExitMs blocks until the PID is dead and escalates to SIGKILL
  //     when SIGTERM is trapped indefinitely. Regression for the
  //     respawn-into-same-worktree race in bumpRestartAndRespawn: a worker
  //     that traps SIGTERM must not still be running when the next respawn
  //     reuses the same worktree.
  //
  //     The worker is spawned via an intermediate process that exits right
  //     after spawning so the worker is orphaned to init. This mirrors how
  //     spawn-agent.js detaches workers in production, and (importantly)
  //     means safeKill's blocking poll loop doesn't sit between SIGCHLD and
  //     the test runner's reaper — which would leave zombies that kill(0)
  //     can't distinguish from live processes.
  it('safeKill with waitForExitMs blocks until the PID is gone, escalating to SIGKILL', {
    skip: process.platform === 'win32' ? 'SIGTERM-trapping semantics differ on Windows' : false,
  }, async () => {
    _resetRefusalCounts();
    const workerPid = await spawnOrphanedWorkerReady('process.on("SIGTERM", () => {});');

    try {
      const logs = [];
      const startedAt = Date.now();
      const result = safeKill({
        pid: workerPid,
        expectedCli: 'node',
        waitForExitMs: 800,
        log: (msg) => logs.push(msg),
      });
      const elapsedMs = Date.now() - startedAt;

      assert.strictEqual(result, true, 'safeKill should report it dispatched');
      // SIGTERM was trapped — waitForExit must have elapsed at least the
      // grace window before SIGKILL fired.
      assert.ok(elapsedMs >= 700, `safeKill should have waited at least the grace window, got ${elapsedMs}ms`);
      assert.ok(
        logs.some((msg) => msg.includes('escalating to SIGKILL')),
        `expected escalation log, got:\n${logs.join('\n')}`,
      );
      // PID must be gone immediately after safeKill returns — that's the
      // regression: respawn into the same worktree can never start while
      // the previous PID is still alive.
      try {
        process.kill(workerPid, 0);
        assert.fail(`PID ${workerPid} should be dead after safeKill returned`);
      } catch (err) {
        assert.strictEqual(err.code, 'ESRCH', `expected ESRCH, got ${err.code}`);
      }
    } finally {
      try { process.kill(workerPid, 'SIGKILL'); } catch {}
    }
  });

  // 9b. When SIGTERM actually works, waitForExitMs returns promptly without
  //     escalating — escalation must be the exception, not the rule, so a
  //     well-behaved worker is reaped without paying the full grace window.
  it('safeKill with waitForExitMs returns promptly when SIGTERM is honoured', {
    skip: process.platform === 'win32' ? 'POSIX process groups are not available on Windows' : false,
  }, async () => {
    _resetRefusalCounts();
    const workerPid = await spawnOrphanedWorkerReady('');

    try {
      const logs = [];
      const startedAt = Date.now();
      const result = safeKill({
        pid: workerPid,
        expectedCli: 'node',
        waitForExitMs: 5000,
        log: (msg) => logs.push(msg),
      });
      const elapsedMs = Date.now() - startedAt;

      assert.strictEqual(result, true);
      assert.ok(elapsedMs < 2000, `SIGTERM-respecting child should be reaped well under the grace window, got ${elapsedMs}ms`);
      assert.ok(
        !logs.some((msg) => msg.includes('escalating to SIGKILL')),
        `should not escalate when SIGTERM works, got:\n${logs.join('\n')}`,
      );
      try {
        process.kill(workerPid, 0);
        assert.fail(`PID ${workerPid} should be dead after safeKill returned`);
      } catch (err) {
        assert.strictEqual(err.code, 'ESRCH');
      }
    } finally {
      try { process.kill(workerPid, 'SIGKILL'); } catch {}
    }
  });

  // 10. getProcessCommandMap returns a populated pid→cmdline map and
  //    pidMatchesCli consults it instead of spawning its own ps.
  it('pidMatchesCli reads from a per-cycle cmdMap and avoids the per-pid ps fan-out', {
    skip: process.platform === 'win32' ? 'ps -eo is POSIX-only' : false,
  }, async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const cmdMap = getProcessCommandMap();
      assert.ok(cmdMap instanceof Map, 'cmdMap should be a Map');
      assert.ok(cmdMap.size > 0, 'cmdMap should contain at least the current node process');
      assert.ok(cmdMap.has(child.pid), `cmdMap should include the spawned PID ${child.pid}`);
      const recorded = cmdMap.get(child.pid);
      assert.match(recorded, /node/, `cmdline should contain 'node', got: ${recorded}`);

      // With the map provided, the match decision is purely in-memory — no
      // per-pid ps is invoked. (We can't observe non-invocation directly,
      // but we can prove the lookup uses the map by passing a synthetic
      // map that "lies" about a non-existent pid: pidMatchesCli should
      // accept the map's claim.)
      const syntheticPid = 999999999;
      const lyingMap = new Map([[syntheticPid, '/usr/bin/node fake-script.js']]);
      assert.strictEqual(
        pidMatchesCli(syntheticPid, 'node', { cmdMap: lyingMap }),
        true,
        'cmdMap entry should drive the decision without falling through to ps',
      );

      // And a real pid not in the map falls back to per-pid ps so a worker
      // spawned mid-cycle still passes liveness.
      const emptyMap = new Map();
      assert.strictEqual(
        pidMatchesCli(child.pid, 'node', { cmdMap: emptyMap }),
        true,
        'a real PID missing from the cmdMap must fall back to per-pid ps',
      );
    } finally {
      cleanupProcess(child);
    }
  });
});
