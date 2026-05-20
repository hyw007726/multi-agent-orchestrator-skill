'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  bootstrapProject,
} = require('./helpers/temp-project');

describe('per-cycle subprocess count', () => {
  it('checks ten running agents with one ps scan and one git status per agent', {
    skip: process.platform === 'win32' ? 'POSIX ps wrapping is not available on Windows' : false,
  }, () => {
    let project;
    try {
      project = createTempProject('per-cycle-subprocess-');
      bootstrapProject(project.root, 'Per-cycle subprocess count test project');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "fake",',
        '  orchestrator_cli: "fake",',
        '  cli_templates: { fake: { cmd: "node", args: ["-e", "console.log(JSON.stringify({ approved: [], rejected: [], actions: [] }))"] } },',
        '  cli_health_checks: { fake: "node -e \\"process.exit(0)\\"" },',
        '  default_timeout_mins: 10,',
        '  default_progress_timeout_mins: 60,',
        '  poll_min_ms: 100,',
        '  poll_max_ms: 100,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      const now = new Date().toISOString();
      const agentCount = 10;
      const agents = {};
      const syntheticPsLines = [];
      for (let i = 0; i < agentCount; i++) {
        const name = `agent-${i}`;
        const pid = 900000 + i;
        syntheticPsLines.push(`${pid} node fake-worker-${name}`);
        agents[name] = {
          task: 'Keep the loop in the running-agent liveness path.',
          status: 'running',
          worktree: project.root,
          cli: 'fake',
          process_match: 'node',
          pid,
          started_at: now,
          last_spawned_at: now,
          current_started_at: now,
          timeout_mins: 10,
          progress_timeout_mins: 60,
        };
      }
      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify(agents, null, 2) + '\n', 'utf-8');

      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subprocess-wrappers-'));
      const callsPath = path.join(project.root, 'subprocess-calls.jsonl');
      const gitStatusCountPath = path.join(project.root, 'git-status-count.txt');
      const realGit = commandPath('git');
      const realPs = commandPath('ps');

      writeWrapper(path.join(binDir, 'ps'), buildPsWrapper({ callsPath, syntheticPsLines }));
      writeWrapper(path.join(binDir, 'git'), buildGitWrapper({
        callsPath,
        gitStatusCountPath,
        agentsPath: path.join(project.root, 'coord', 'agents.json'),
        agentCount,
      }));

      const result = spawnSync(process.execPath, [
        path.join(repoRoot(), 'scripts', 'orchestrator-loop.js'),
        '--coord',
        './coord',
        '--poll-interval',
        '100',
      ], {
        cwd: project.root,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
          REAL_GIT: realGit,
          REAL_PS: realPs,
        },
      });

      assert.strictEqual(result.status, 0,
        `orchestrator loop failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

      const calls = readJsonl(callsPath);
      const psEoCalls = calls.filter((call) =>
        call.cmd === 'ps' &&
        call.args[0] === '-eo' &&
        call.args[1] === 'pid=,command='
      );
      const psPerPidCalls = calls.filter((call) =>
        call.cmd === 'ps' &&
        call.args[0] === '-p'
      );
      const gitCalls = calls.filter((call) => call.cmd === 'git');
      const gitStatusCalls = gitCalls.filter((call) =>
        call.args.join('\0') === ['status', '--porcelain=v2', '--branch', '-uall'].join('\0')
      );

      // One ps scan is expected before the loop for singleton detection, and
      // the running-agent tick should add at most one more.
      assert.ok(psEoCalls.length <= 2, `expected <=2 ps scans including startup, got ${psEoCalls.length}`);
      assert.strictEqual(psPerPidCalls.length, 0, `per-pid ps fallback should not run:\n${JSON.stringify(psPerPidCalls, null, 2)}`);
      assert.ok(gitCalls.length <= agentCount, `expected <=${agentCount} git calls, got ${gitCalls.length}`);
      assert.strictEqual(gitStatusCalls.length, agentCount,
        `expected one git status per running agent, got ${gitStatusCalls.length}`);
    } finally {
      if (project) project.cleanup();
    }
  });
});

function commandPath(name) {
  const result = spawnSync('/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf-8' });
  assert.strictEqual(result.status, 0, `could not resolve ${name}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeWrapper(filePath, source) {
  fs.writeFileSync(filePath, source, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

function buildPsWrapper({ callsPath, syntheticPsLines }) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("fs");',
    'const { spawnSync } = require("node:child_process");',
    `const callsPath = ${JSON.stringify(callsPath)};`,
    `const syntheticPsLines = ${JSON.stringify(syntheticPsLines.join('\n'))};`,
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(callsPath, JSON.stringify({ cmd: "ps", args }) + "\\n", "utf-8");',
    'if (args.join("\\0") === ["-eo", "pid=,command="].join("\\0") && syntheticPsLines) {',
    '  process.stdout.write(syntheticPsLines + "\\n");',
    '  process.exit(0);',
    '}',
    'const result = spawnSync(process.env.REAL_PS, args, { encoding: "utf-8" });',
    'if (result.stdout) process.stdout.write(result.stdout);',
    'if (result.stderr) process.stderr.write(result.stderr);',
    'if (result.error) { console.error(result.error.message); process.exit(1); }',
    'process.exit(result.status === null ? 1 : result.status);',
    '',
  ].join('\n');
}

function buildGitWrapper({ callsPath, gitStatusCountPath, agentsPath, agentCount }) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("fs");',
    'const { spawnSync } = require("node:child_process");',
    `const callsPath = ${JSON.stringify(callsPath)};`,
    `const gitStatusCountPath = ${JSON.stringify(gitStatusCountPath)};`,
    `const agentsPath = ${JSON.stringify(agentsPath)};`,
    `const agentCount = ${JSON.stringify(agentCount)};`,
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(callsPath, JSON.stringify({ cmd: "git", args }) + "\\n", "utf-8");',
    'const result = spawnSync(process.env.REAL_GIT, args, { encoding: "utf-8" });',
    'if (result.stdout) process.stdout.write(result.stdout);',
    'if (result.stderr) process.stderr.write(result.stderr);',
    'if (args.join("\\0") === ["status", "--porcelain=v2", "--branch", "-uall"].join("\\0")) {',
    '  let count = 0;',
    '  try { count = Number(fs.readFileSync(gitStatusCountPath, "utf-8")) || 0; } catch {}',
    '  count += 1;',
    '  fs.writeFileSync(gitStatusCountPath, String(count), "utf-8");',
    '  if (count === agentCount) {',
    '    const agents = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));',
    '    for (const agent of Object.values(agents)) agent.status = "completed";',
    '    fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + "\\n", "utf-8");',
    '  }',
    '}',
    'if (result.error) { console.error(result.error.message); process.exit(1); }',
    'process.exit(result.status === null ? 1 : result.status);',
    '',
  ].join('\n');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
