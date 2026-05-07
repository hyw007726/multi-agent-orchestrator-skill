'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { safeKill } = require('../scripts/lib/process');
const { waitFor } = require('./helpers/temp-project');

describe('process group termination', () => {
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
});
