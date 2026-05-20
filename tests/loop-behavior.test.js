'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('child_process');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  addKiloWorktree,
  runLoop,
  readJson,
  readJsonl,
  waitFor,
} = require('./helpers/temp-project');

const { checkCompletionOwnership, collectOwnershipChangedFiles } = require(path.join(repoRoot(), 'scripts', 'lib', 'ownership.js'));
const { captureRecoveryAndReset } = require(path.join(repoRoot(), 'scripts', 'lib', 'worktree-recovery.js'));
const { sweepRestartPrompts } = require(path.join(repoRoot(), 'scripts', 'lib', 'actions.js'));

describe('loop behavior', () => {
  // 1. Restart cap parks an agent for human attention.
  it('parks agent for attention when restart count exceeds max', () => {
    let project;
    try {
      project = createTempProject('restart-cap-');

      const cliPath = path.join(project.root, 'cap-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("cap-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        '',
        '// Orchestrator mode: return soft_restart for every pending request.',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Restart cap test approval."',
        '  }));',
        '  const actions = requests.map(r => ({',
        '    type: "soft_restart",',
        '    agent: r.agent,',
        '    instruction: "try again"',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        '// Summary mode.',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Cap test summary.");',
        '  process.exit(0);',
        '}',
        '',
        '// Worker mode: submit a review_request.',
        'const agentName = "agent-cap";',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'stageRequest({',
        '  request_id: agentName + "-do-something",',
        '  agent: agentName,',
        '  type: "review_request",',
        '  priority: "medium",',
        '  status: "pending",',
        '  content: "Done some work, requesting soft restart.",',
        '  created_at: new Date().toISOString()',
        '});',
        'const maxTimer = setTimeout(() => process.exit(0), 50);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n'), 'utf-8');

      const configPath = path.join(project.root, 'orchestrator.config.js');
      fs.writeFileSync(configPath, [
        'module.exports = {',
        '  default_cli: "cap",',
        '  orchestrator_cli: "cap",',
        `  cli_templates: { cap: 'node "${cliPath}" {prompt_file}' },`,
        '  cli_health_checks: { cap: "node -e \\"process.exit(0)\\"" },',
        '  default_max_restarts: 0,',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Restart cap test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-cap': {
          description: 'Test restart cap behavior.',
          cli: 'cap',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-cap');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the agent.', 'utf-8');

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-cap',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'cap',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.ok(agents && agents['agent-cap'], 'agents.json should contain agent-cap');
      const parked = agents['agent-cap'];
      assert.strictEqual(parked.status, 'needs_attention',
        `Expected "needs_attention" but got "${parked.status}"`);
      assert.match(parked.attention_reason, /max restarts \(\d+\) exhausted/);
      assert.ok(!Number.isNaN(Date.parse(parked.attention_at)), 'attention_at is an ISO timestamp');
      assert.ok(parked.next_steps && parked.next_steps.length > 0, 'next_steps populated');
      // Budget-exhausted preserves the worktree and does not respawn.
      assert.ok(parked.worktree && fs.existsSync(parked.worktree), 'worktree preserved');

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const parkEvent = events.find((e) => e.event === 'agent_parked' && e.agent === 'agent-cap');
      assert.ok(parkEvent, 'agent_parked event appended');
      assert.match(parkEvent.reason, /max restarts \(\d+\) exhausted/);
      assert.ok(parkEvent.data.attention_at && parkEvent.data.next_steps, 'event carries attention_at and next_steps');

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.ok(log.includes('max restarts'),
        `Log should mention max restarts\nlog:\n${log}`);
      assert.ok(log.includes('not respawning') || log.includes('exceeded'),
        `Log should mention not respawning\nlog:\n${log}`);
    } finally {
      if (project) project.cleanup();
    }
  });

  // 2. Abort flag preserves worktree contents.
  it('abort flag stops the loop but preserves worktree files', () => {
    let project;
    try {
      project = createTempProject('abort-flag-');

      const cliPath = path.join(project.root, 'abort-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("abort-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        '',
        '// Orchestrator mode: approve everything, no special actions.',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Abort test approval."',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions: [] }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        '// Summary mode.',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Abort test summary.");',
        '  process.exit(0);',
        '}',
        '',
        '// Worker mode: write some worktree content and keep running.',
        'fs.writeFileSync("worktree-output.txt", "important work\\n", "utf-8");',
        'const maxTimer = setTimeout(() => process.exit(0), 5000);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n'), 'utf-8');

      writeProjectConfig(project.root, cliPath);

      bootstrapProject(project.root, 'Abort flag test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-abort': {
          description: 'Test abort flag behavior.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-abort');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the agent.', 'utf-8');

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-abort',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'fake',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      // Write uncommitted content in the worktree before creating abort flag.
      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-abort');
      const extraFile = path.join(worktree, 'untracked-work.txt');
      fs.writeFileSync(extraFile, 'uncommitted content that should survive\n', 'utf-8');

      // Write untracked content too.
      const untrackedFile = path.join(worktree, 'new-file.data');
      fs.writeFileSync(untrackedFile, 'untracked data\n', 'utf-8');

      // Create an active abort flag. The loop stamps current_run.json at
      // startup, so a pre-existing test flag needs a written_at newer than
      // that startup time to model a dashboard Ctrl+C.
      fs.writeFileSync(path.join(project.root, 'coord', 'abort.flag'), JSON.stringify({
        pid: process.pid,
        written_at: new Date(Date.now() + 1000).toISOString(),
      }) + '\n', 'utf-8');

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      // After abort, worktree files must still exist.
      assert.ok(fs.existsSync(extraFile),
        `Worktree file should still exist after abort: ${extraFile}`);
      assert.strictEqual(fs.readFileSync(extraFile, 'utf-8'), 'uncommitted content that should survive\n');
      assert.ok(fs.existsSync(untrackedFile),
        `Untracked worktree file should still exist after abort: ${untrackedFile}`);
      assert.strictEqual(fs.readFileSync(untrackedFile, 'utf-8'), 'untracked data\n');

      const coordDir = path.join(project.root, 'coord');
      assert.strictEqual(fs.existsSync(coordDir), true,
        'coord directory should be preserved after an abort for inspection');
      assert.strictEqual(fs.existsSync(path.join(coordDir, 'abort.flag')), false,
        'abort flag should be consumed after the loop handles it');
      assert.ok(fs.existsSync(path.join(coordDir, 'orchestrator.log')),
        'orchestrator log should remain available after abort');
      const agents = readJson(path.join(coordDir, 'agents.json'));
      assert.strictEqual(agents['agent-abort'].status, 'terminated');
      assert.match(loop.stdout, /Coordination directory preserved/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('ignores stale abort flags from a prior run on boot', () => {
    let project;
    try {
      project = createTempProject('stale-abort-');

      const cliPath = path.join(project.root, 'stale-abort-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'console.log("stale abort noop");',
      ].join('\n'), 'utf-8');
      writeProjectConfig(project.root, cliPath);
      bootstrapProject(project.root, 'Stale abort flag test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-done': {
          description: 'Already completed before a new loop starts.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');
      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-done': {
          task: 'Already completed before a new loop starts.',
          status: 'completed',
          worktree: project.root,
          cli: 'fake',
          pid: 0,
        },
      }, null, 2) + '\n', 'utf-8');
      fs.writeFileSync(path.join(project.root, 'coord', 'abort.flag'), JSON.stringify({
        pid: 123,
        written_at: '2000-01-01T00:00:00.000Z',
      }) + '\n', 'utf-8');

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const coordDir = path.join(project.root, 'coord');
      assert.strictEqual(fs.existsSync(path.join(coordDir, 'abort.flag')), false,
        'stale abort flag should be removed after being ignored');
      const agents = readJson(path.join(coordDir, 'agents.json'));
      assert.strictEqual(agents['agent-done'].status, 'completed');
      const log = fs.readFileSync(path.join(coordDir, 'orchestrator.log'), 'utf-8');
      assert.match(log, /Ignoring stale abort\.flag/);
      assert.doesNotMatch(log, /ABORT SIGNAL RECEIVED/);
    } finally {
      if (project) project.cleanup();
    }
  });

  // 3. Hard-restart recovery fails closed without resetting worktree.
  it('hard restart recovery failure parks agent and rolls back the orphaned RECOVERY commit', () => {
    let project;
    try {
      project = createTempProject('hard-reset-fail-');

      const cliPath = path.join(project.root, 'hard-fail-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("hard-fail-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        '',
        '// Orchestrator mode: approve, return hard_restart for the known agent.',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Hard reset failure test."',
        '  }));',
        '  const actions = requests.map(r => ({',
        '    type: "hard_restart",',
        '    agent: r.agent,',
        '    instruction: "Do a hard restart."',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        '// Summary mode.',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Hard reset fail test summary.");',
        '  process.exit(0);',
        '}',
        '',
        '// Worker mode: submit a review_request and stay alive.',
        'const agentName = "agent-hardfail";',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'stageRequest({',
        '  request_id: agentName + "-need-hard-reset",',
        '  agent: agentName,',
        '  type: "review_request",',
        '  priority: "medium",',
        '  status: "pending",',
        '  content: "Requesting hard restart.",',
        '  created_at: new Date().toISOString()',
        '});',
        'const maxTimer = setTimeout(() => process.exit(0), 50);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n'), 'utf-8');

      writeProjectConfig(project.root, cliPath);

      bootstrapProject(project.root, 'Hard reset failure test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-hardfail': {
          description: 'Test hard restart recovery failure.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-hardfail');

      // Create a dirty file in the worktree that should survive.
      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-hardfail');
      const dirtyFile = path.join(worktree, 'dirty-content.txt');
      fs.writeFileSync(dirtyFile, 'dirty worktree content\n', 'utf-8');

      // Make git tag operations fail. Works because the worktree shares the
      // main repo's tag storage, so making refs/tags a regular file prevents
      // `git tag` from creating new tags.
      const tagsPath = path.join(project.root, '.git', 'refs', 'tags');
      if (fs.existsSync(tagsPath)) {
        fs.rmSync(tagsPath, { recursive: true });
      }
      fs.writeFileSync(tagsPath, '');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the agent.', 'utf-8');

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-hardfail',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'fake',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.ok(agents && agents['agent-hardfail'], 'agents.json should contain agent-hardfail');
      const parked = agents['agent-hardfail'];
      assert.strictEqual(parked.status, 'needs_attention',
        `Expected "needs_attention" but got "${parked.status}"`);
      assert.match(parked.attention_reason, /hard restart recovery failed:/);
      assert.ok(!Number.isNaN(Date.parse(parked.attention_at)), 'attention_at is an ISO timestamp');
      assert.ok(parked.next_steps && parked.next_steps.length > 0, 'next_steps populated');

      // The RECOVERY commit was created on HEAD but tagging failed. It must be
      // rolled back (git reset --hard HEAD~1) so it can't later be merged into
      // main as an unlabeled pollutant — so the dirty content does NOT survive.
      assert.ok(!fs.existsSync(dirtyFile),
        `Orphaned RECOVERY commit (and its dirty file) should be rolled back: ${dirtyFile}`);
      const headSubject = spawnSync('git', ['log', '-1', '--format=%s'], {
        cwd: worktree, encoding: 'utf-8',
      }).stdout.trim();
      assert.notStrictEqual(headSubject, 'RECOVERY: pre-hard-restart',
        'the untagged RECOVERY commit must not remain on the branch');

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const parkEvent = events.find((e) => e.event === 'agent_parked' && e.agent === 'agent-hardfail');
      assert.ok(parkEvent, 'agent_parked event appended');
      assert.match(parkEvent.reason, /hard restart recovery failed:/);
      assert.ok(parkEvent.data.attention_at && parkEvent.data.next_steps, 'event carries attention_at and next_steps');

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.ok(
        log.includes('Hard restart: recovery/reset failed'),
        `Log should mention recovery/reset failed\nlog:\n${log}`
      );
    } finally {
      if (project) project.cleanup();
    }
  });

  // 4. Hard restart recovery preserves declared nested git state.
  it('hard restart recovery preserves declared submodule worktrees during clean', () => {
    let project;
    try {
      project = createTempProject('hard-reset-submodule-');
      const worktree = project.root;
      const submodulePath = path.join(worktree, 'vendor', 'lib');
      fs.mkdirSync(submodulePath, { recursive: true });

      const git = (cwd, args) => {
        const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
        assert.strictEqual(result.status, 0,
          `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        return result;
      };

      git(submodulePath, ['init']);
      git(submodulePath, ['config', 'user.email', 'test@test.test']);
      git(submodulePath, ['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(submodulePath, 'nested.txt'), 'nested state\n', 'utf-8');
      git(submodulePath, ['add', 'nested.txt']);
      git(submodulePath, ['commit', '-m', 'Nested initial commit']);

      fs.writeFileSync(path.join(worktree, '.gitmodules'), [
        '[submodule "vendor/lib"]',
        '\tpath = vendor/lib',
        '\turl = ./vendor/lib',
        '',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'untracked parent state\n', 'utf-8');

      const result = captureRecoveryAndReset(worktree, 'agent-submodule', () => {}, 'run-test');
      assert.strictEqual(result.error, null);
      assert.ok(result.tag, 'dirty state should be preserved in a recovery tag');

      assert.ok(fs.existsSync(path.join(submodulePath, '.git')),
        'declared submodule git metadata should survive git clean');
      assert.strictEqual(fs.readFileSync(path.join(submodulePath, 'nested.txt'), 'utf-8'), 'nested state\n');
      assert.strictEqual(fs.existsSync(path.join(worktree, 'scratch.txt')), false,
        'ordinary untracked files should still be cleaned');
    } finally {
      if (project) project.cleanup();
    }
  });

  it('hard restart preserves a submodule path declared by staged .gitmodules', () => {
    let project;
    try {
      project = createTempProject('hard-restart-staged-submodule-');

      const cliPath = path.join(project.root, 'hard-submodule-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("hard-submodule-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map((r) => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Hard restart staged submodule test."',
        '  }));',
        '  const actions = requests.map((r) => ({',
        '    type: "hard_restart",',
        '    agent: r.agent,',
        '    instruction: "Restart after preserving staged submodule metadata."',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        'setTimeout(() => process.exit(0), 25);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "hard-submodule",',
        '  orchestrator_cli: "hard-submodule",',
        `  cli_templates: { "hard-submodule": 'node "${cliPath}" {prompt_file}' },`,
        '  cli_health_checks: { "hard-submodule": "node -e \\"process.exit(0)\\"" },',
        '  default_max_restarts: 1,',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Hard restart staged submodule test project');
      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-submodule': {
          description: 'Exercise hard restart recovery with staged .gitmodules.',
          cli: 'hard-submodule',
          allowed_paths: ['.gitmodules', 'vendor/**', 'scratch.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-submodule');
      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-submodule');
      const submodulePath = path.join(worktree, 'vendor', 'lib');
      fs.mkdirSync(submodulePath, { recursive: true });
      gitCommand(submodulePath, ['init']);
      gitCommand(submodulePath, ['config', 'user.email', 'test@test.test']);
      gitCommand(submodulePath, ['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(submodulePath, 'nested.txt'), 'nested state\n', 'utf-8');
      gitCommand(submodulePath, ['add', 'nested.txt']);
      gitCommand(submodulePath, ['commit', '-m', 'Nested initial commit']);

      fs.writeFileSync(path.join(worktree, '.gitmodules'), [
        '[submodule "vendor/lib"]',
        '\tpath = vendor/lib',
        '\turl = ./vendor/lib',
        '',
      ].join('\n'), 'utf-8');
      gitCommand(worktree, ['add', '.gitmodules']);
      assert.match(gitCommand(worktree, ['diff', '--staged', '--name-only']).stdout, /^\.gitmodules$/m,
        '.gitmodules should be staged before the hard restart runs');
      fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'untracked parent state\n', 'utf-8');

      const nowIso = new Date().toISOString();
      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-submodule': {
          task: 'Exercise hard restart recovery with staged .gitmodules.',
          status: 'running',
          pid: 0,
          cli: 'hard-submodule',
          process_match: 'node',
          worktree,
          started_at: nowIso,
          current_started_at: nowIso,
          last_spawned_at: nowIso,
          last_heartbeat: nowIso,
          restart_count: 0,
          base_ref: 'main',
        },
      }, null, 2) + '\n', 'utf-8');
      fs.writeFileSync(path.join(project.root, 'coord', 'requests.jsonl'), JSON.stringify({
        request_id: 'agent-submodule-hard-restart',
        agent: 'agent-submodule',
        type: 'question',
        priority: 'medium',
        status: 'pending',
        content: 'Trigger a hard restart.',
        created_at: nowIso,
      }) + '\n', 'utf-8');

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      assert.ok(fs.existsSync(path.join(submodulePath, '.git')),
        'declared submodule git metadata should survive hard restart clean');
      assert.strictEqual(fs.readFileSync(path.join(submodulePath, 'nested.txt'), 'utf-8'), 'nested state\n');
      assert.strictEqual(fs.existsSync(path.join(worktree, 'scratch.txt')), false,
        'ordinary untracked parent state should still be cleaned during hard restart');

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const recoveryEvent = events.find((event) =>
        event.event === 'recovery_tag_created' &&
        event.agent === 'agent-submodule'
      );
      assert.ok(recoveryEvent, 'hard restart should create a recovery tag for staged .gitmodules state');
    } finally {
      if (project) project.cleanup();
    }
  });

  it('discovers the default base ref for ownership when agent base_ref is missing', () => {
    let project;
    try {
      project = createTempProject('ownership-base-ref-');
      gitCommand(project.root, ['branch', '-M', 'trunk']);
      gitCommand(project.root, ['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
      gitCommand(project.root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
      gitCommand(project.root, ['checkout', '-b', 'agent-branch']);

      fs.writeFileSync(path.join(project.root, 'owned.txt'), 'owned change\n', 'utf-8');
      gitCommand(project.root, ['add', 'owned.txt']);
      gitCommand(project.root, ['commit', '-m', 'Agent change']);

      const logs = [];
      const changed = collectOwnershipChangedFiles(project.root, undefined, (message) => logs.push(message));
      assert.deepStrictEqual(changed.errors, []);
      assert.deepStrictEqual(changed.files, ['owned.txt']);
      assert.deepStrictEqual(logs, []);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('passes ownership when a worker writes coord/requests/foo.json through the coord symlink', () => {
    let project;
    const coordTarget = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'coord-target-'));
    try {
      project = createTempProject('ownership-coord-symlink-');
      gitCommand(project.root, ['branch', '-M', 'trunk']);
      fs.mkdirSync(path.join(project.root, 'coord', 'requests'), { recursive: true });
      fs.writeFileSync(path.join(project.root, 'coord', 'requests', 'old.json'), '{}\n', 'utf-8');
      gitCommand(project.root, ['add', 'coord/requests/old.json']);
      gitCommand(project.root, ['commit', '-m', 'Track prior coord file']);
      gitCommand(project.root, ['checkout', '-b', 'agent-coord']);

      fs.rmSync(path.join(project.root, 'coord'), { recursive: true, force: true });
      fs.mkdirSync(path.join(coordTarget, 'requests'), { recursive: true });
      fs.symlinkSync(coordTarget, path.join(project.root, 'coord'), 'dir');
      fs.writeFileSync(path.join(project.root, 'coord', 'requests', 'foo.json'), '{}\n', 'utf-8');
      assert.ok(fs.existsSync(path.join(coordTarget, 'requests', 'foo.json')),
        'worker-style write should land in the coord symlink target subtree');
      gitCommand(project.root, ['add', '-A']);

      const contextPath = path.join(coordTarget, 'context.json');
      fs.writeFileSync(contextPath, JSON.stringify({
        tasks: {
          'agent-coord': {
            description: 'Owns source files only.',
            allowed_paths: ['src/**'],
            forbidden_paths: ['coord/**'],
          },
        },
      }, null, 2), 'utf-8');

      const ownership = checkCompletionOwnership('agent-coord', {
        worktree: project.root,
        base_ref: 'trunk',
      }, { context: contextPath }, () => {});

      assert.strictEqual(ownership.ok, true, ownership.summary);
      assert.deepStrictEqual(ownership.changedFiles, []);
      assert.deepStrictEqual(ownership.forbiddenViolations, []);
      assert.deepStrictEqual(ownership.outsideAllowed, []);
    } finally {
      if (project) project.cleanup();
      fs.rmSync(coordTarget, { recursive: true, force: true });
    }
  });

  it('keeps only the most recent restart prompts for each agent', () => {
    const promptsDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'restart-prompts-'));
    try {
      for (let i = 0; i < 12; i++) {
        const file = path.join(promptsDir, `restart-agent-a-${i}.txt`);
        fs.writeFileSync(file, `prompt ${i}\n`, 'utf-8');
        const stamp = new Date(2026, 0, 1, 0, 0, i);
        fs.utimesSync(file, stamp, stamp);
      }
      for (let i = 0; i < 2; i++) {
        fs.writeFileSync(path.join(promptsDir, `restart-agent-b-${i}.txt`), `other ${i}\n`, 'utf-8');
      }

      sweepRestartPrompts(promptsDir, 'agent-a', 5);

      const remaining = fs.readdirSync(promptsDir).sort();
      assert.deepStrictEqual(
        remaining.filter((name) => name.startsWith('restart-agent-a-')),
        [
          'restart-agent-a-10.txt',
          'restart-agent-a-11.txt',
          'restart-agent-a-7.txt',
          'restart-agent-a-8.txt',
          'restart-agent-a-9.txt',
        ].sort(),
      );
      assert.deepStrictEqual(
        remaining.filter((name) => name.startsWith('restart-agent-b-')),
        ['restart-agent-b-0.txt', 'restart-agent-b-1.txt'],
      );
    } finally {
      fs.rmSync(promptsDir, { recursive: true, force: true });
    }
  });

  it('logs and events arbitration actions that target unknown agents', () => {
    let project;
    try {
      project = createTempProject('unknown-arbitration-action-');

      const cliPath = path.join(project.root, 'unknown-action-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const prompt = fs.readFileSync(process.argv[2], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  console.log(JSON.stringify({',
        '    approved: [{ request_id: "known-question", decision: "approved", reason: "test" }],',
        '    rejected: [],',
        '    actions: [{ type: "soft_restart", agent: "ghost-agent", instruction: "try again" }]',
        '  }));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) { console.log("Unknown action summary."); process.exit(0); }',
        'console.log("worker noop");',
      ].join('\n'), 'utf-8');
      writeProjectConfig(project.root, cliPath);
      bootstrapProject(project.root, 'Unknown arbitration action test');

      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      fs.writeFileSync(agentsPath, JSON.stringify({
        'known-agent': {
          task: 'Already complete.',
          status: 'completed',
          worktree: project.root,
          cli: 'fake',
          pid: 0,
        },
      }, null, 2) + '\n', 'utf-8');
      fs.writeFileSync(path.join(project.root, 'coord', 'requests.jsonl'), JSON.stringify({
        request_id: 'known-question',
        agent: 'known-agent',
        type: 'question',
        priority: 'medium',
        status: 'pending',
        content: 'Resolve this request.',
        created_at: new Date().toISOString(),
      }) + '\n', 'utf-8');

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /Arbitration action targeted unknown agent ghost-agent/);
      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const dropped = events.find((event) => event.event === 'arbitration_action_dropped');
      assert.ok(dropped, 'expected arbitration_action_dropped event');
      assert.strictEqual(dropped.agent, 'ghost-agent');
      assert.strictEqual(dropped.data.action.type, 'soft_restart');
    } finally {
      if (project) project.cleanup();
    }
  });

  // 5. Validation failure converts to soft restart and preserves validation command.
  it('validation failure triggers soft restart and preserves validate_cmd', () => {
    let project;
    try {
      project = createTempProject('val-fail-');

      const cliPath = path.join(project.root, 'val-fail-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("val-fail-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'const agentName = "agent-valfail";',
        '',
        '// Orchestrator mode: always return end_agent.',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Validation test."',
        '  }));',
        '  const actions = requests.map(r => ({',
        '    type: "end_agent",',
        '    agent: r.agent,',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        '// Summary mode.',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Validation test summary.");',
        '  process.exit(0);',
        '}',
        '',
        '// Worker mode — first run vs restart run.',
        'const isRestart = prompt.includes("## Restart Instruction");',
        '',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        '',
        'if (isRestart) {',
        '  // Restart run: write done.txt so validation passes on the next end_agent.',
        '  fs.writeFileSync("done.txt", "done\\n", "utf-8");',
        '  stageRequest({',
        '    request_id: agentName + "-done-now",',
        '    agent: agentName,',
        '    type: "review_request",',
        '    priority: "medium",',
        '    status: "pending",',
        '    content: "Fixed validation issue, done.txt now exists.",',
        '    created_at: new Date().toISOString()',
        '  });',
        '} else {',
        '  // First run: done.txt does NOT exist — validation will fail.',
        '  stageRequest({',
        '    request_id: agentName + "-ready-for-review",',
        '    agent: agentName,',
        '    type: "review_request",',
        '    priority: "medium",',
        '    status: "pending",',
        '    content: "Work complete, please validate.",',
        '    created_at: new Date().toISOString()',
        '  });',
        '}',
        '',
        'const maxTimer = setTimeout(() => process.exit(0), 50);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n'), 'utf-8');

      writeProjectConfig(project.root, cliPath);

      bootstrapProject(project.root, 'Validation failure test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-valfail': {
          description: 'Test validation failure → soft restart.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
          validation_command: ['test', '-f', 'done.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-valfail');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the agent.', 'utf-8');

      const validateArg = JSON.stringify(['test', '-f', 'done.txt']);
      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-valfail',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'fake',
        '--validate', validateArg,
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      // Increase the loop timeout to allow the restart to happen.
      const r = repoRoot();
      const loop = spawnSync('node', [
        path.join(r, 'scripts', 'orchestrator-loop.js'),
        '--coord', './coord',
        '--poll-interval', '250',
      ], {
        encoding: 'utf-8',
        cwd: project.root,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20000,
      });
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.ok(agents && agents['agent-valfail'], 'agents.json should contain agent-valfail');

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.strictEqual(agents['agent-valfail'].status, 'completed',
        `Expected "completed" but got "${agents['agent-valfail'].status}"\nlog:\n${log}`);

      assert.strictEqual(agents['agent-valfail'].restart_count, 1,
        `Expected restart_count 1 but got ${agents['agent-valfail'].restart_count}`);

      assert.deepStrictEqual(agents['agent-valfail'].validate_cmd, ['test', '-f', 'done.txt']);

      assert.ok(log.includes('Validation failed'),
        `Log should mention validation failure\nlog:\n${log}`);
      assert.ok(log.includes('Running validation: test -f done.txt'),
        `Log should contain the validation command\nlog:\n${log}`);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('times out validation commands and parks the agent for attention', () => {
    let project;
    try {
      project = createTempProject('val-timeout-');

      const cliPath = path.join(project.root, 'val-timeout-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("val-timeout-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'const agentName = "agent-valtimeout";',
        '',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Validation timeout test."',
        '  }));',
        '  const actions = requests.map(r => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Validation timeout summary.");',
        '  process.exit(0);',
        '}',
        '',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'stageRequest({',
        '  request_id: agentName + "-ready",',
        '  agent: agentName,',
        '  type: "review_request",',
        '  priority: "medium",',
        '  status: "pending",',
        '  content: "Ready for validation timeout test.",',
        '  created_at: new Date().toISOString()',
        '});',
        'setInterval(() => {}, 1000);',
        'process.on("SIGTERM", () => process.exit(0));',
      ].join('\n'), 'utf-8');

      const configPath = path.join(project.root, 'orchestrator.config.js');
      fs.writeFileSync(configPath, [
        'module.exports = {',
        '  default_cli: "fake",',
        '  orchestrator_cli: "fake",',
        '  cli_templates: {',
        `    fake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(cliPath)}, { prompt_file: true }] },`,
        '  },',
        '  cli_health_checks: {',
        '    fake: "node -e \\"process.exit(0)\\"",',
        '  },',
        '  default_max_restarts: 0,',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Validation timeout test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      const validateCmd = [process.execPath, '-e', 'setTimeout(() => {}, 5000);'];
      context.tasks = {
        'agent-valtimeout': {
          description: 'Test validation timeout.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
          validation_command: validateCmd,
          validation_timeout_mins: 0.001,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-valtimeout');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the validation timeout agent.', 'utf-8');

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-valtimeout',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'fake',
        '--validate', JSON.stringify(validateCmd),
        '--validation-timeout', '0.001',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-valtimeout'].status, 'needs_attention');
      assert.strictEqual(agents['agent-valtimeout'].validation_timeout_mins, 0.001);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requests.find((r) => r.request_id === 'agent-valtimeout-ready').status, 'resolved');

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /Validation timed out after 60ms \(0\.001 minutes\)\./);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('keeps supervising other agents while validation is running', () => {
    let project;
    try {
      project = createTempProject('async-validation-');

      const cliPath = path.join(project.root, 'async-validation-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("async-validation-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({ request_id: r.request_id, decision: "Approved " + r.request_id, reason: "Async validation test." }));',
        '  const actions = requests.map(r => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) { console.log("Async validation summary."); process.exit(0); }',
        'function stageRequest(agentName) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const request = {',
        '    request_id: agentName + "-done",',
        '    agent: agentName,',
        '    type: "review_request",',
        '    priority: "medium",',
        '    status: "pending",',
        '    content: agentName + " done",',
        '    created_at: new Date().toISOString()',
        '  };',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'const agentName = prompt.includes("agent-fast") ? "agent-fast" : "agent-slow";',
        'if (agentName === "agent-fast") setTimeout(() => stageRequest(agentName), 300);',
        'else stageRequest(agentName);',
        'setInterval(() => {}, 1000);',
        'process.on("SIGTERM", () => process.exit(0));',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "fake",',
        '  orchestrator_cli: "fake",',
        `  cli_templates: { fake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(cliPath)}, { prompt_file: true }] } },`,
        '  cli_health_checks: { fake: "node -e \\"process.exit(0)\\"" },',
        '  default_max_restarts: 1,',
        '  poll_min_ms: 100,',
        '  poll_max_ms: 150,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Async validation supervision test');
      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-slow': {
          description: 'Slow validation agent.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
          validation_command: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 1500);'],
          validation_timeout_mins: 0.05,
        },
        'agent-fast': {
          description: 'Fast completion agent.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-slow');
      addKiloWorktree(project.root, 'agent-fast');

      const slowPrompt = path.join(project.root, 'slow-prompt.txt');
      const fastPrompt = path.join(project.root, 'fast-prompt.txt');
      fs.writeFileSync(slowPrompt, 'ALLOWED PATHS: *.txt\nagent-slow', 'utf-8');
      fs.writeFileSync(fastPrompt, 'ALLOWED PATHS: *.txt\nagent-fast', 'utf-8');

      const slowValidation = JSON.stringify([process.execPath, '-e', 'setTimeout(() => process.exit(0), 1500);']);
      const slowSpawn = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-slow',
        '--prompt-file', slowPrompt,
        '--coord', './coord',
        '--cli', 'fake',
        '--validate', slowValidation,
        '--validation-timeout', '0.05',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(slowSpawn.status, 0, `spawn-agent.js failed: ${slowSpawn.stderr}`);

      const fastSpawn = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-fast',
        '--prompt-file', fastPrompt,
        '--coord', './coord',
        '--cli', 'fake',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(fastSpawn.status, 0, `spawn-agent.js failed: ${fastSpawn.stderr}`);

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-slow'].status, 'completed');
      assert.strictEqual(agents['agent-fast'].status, 'completed');

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      const fastCompleted = log.indexOf('Agent agent-fast status: running -> completed');
      const slowValidationPassed = log.indexOf('Validation passed for agent-slow.');
      assert.ok(fastCompleted !== -1, `fast completion should be logged\nlog:\n${log}`);
      assert.ok(slowValidationPassed !== -1, `slow validation pass should be logged\nlog:\n${log}`);
      assert.ok(fastCompleted < slowValidationPassed,
        `fast agent should complete while slow validation is still running\nlog:\n${log}`);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('resolves completion review requests before signaling the worker', async () => {
    let project;
    try {
      project = createTempProject('end-agent-resolve-');

      const cliPath = path.join(project.root, 'end-resolve-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("end-resolve-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'const agentName = "agent-endresolve";',
        '',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "End-agent resolution test."',
        '  }));',
        '  const actions = requests.map(r => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("End-agent resolution summary.");',
        '  process.exit(0);',
        '}',
        '',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'function requestStatus() {',
        '  try {',
        '    const lines = fs.readFileSync(path.join("coord", "requests.jsonl"), "utf-8").trim().split(/\\n/).filter(Boolean);',
        '    const requests = lines.map((line) => JSON.parse(line));',
        '    const request = requests.find((entry) => entry.request_id === agentName + "-done");',
        '    return request ? request.status : "missing";',
        '  } catch (err) {',
        '    return "error: " + err.message;',
        '  }',
        '}',
        'stageRequest({',
        '  request_id: agentName + "-done",',
        '  agent: agentName,',
        '  type: "review_request",',
        '  priority: "medium",',
        '  status: "pending",',
        '  content: "Done and waiting for end_agent.",',
        '  created_at: new Date().toISOString()',
        '});',
        'setInterval(() => {}, 1000);',
        'process.on("SIGTERM", () => {',
        '  fs.writeFileSync("sigterm-status.txt", requestStatus() + "\\n", "utf-8");',
        '  process.exit(0);',
        '});',
      ].join('\n'), 'utf-8');

      writeProjectConfig(project.root, cliPath);
      bootstrapProject(project.root, 'End-agent resolution test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-endresolve': {
          description: 'Test end_agent request resolution ordering.',
          cli: 'fake',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-endresolve');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the end-agent resolution agent.', 'utf-8');

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-endresolve',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'fake',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-endresolve'].status, 'completed');

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requests.find((r) => r.request_id === 'agent-endresolve-done').status, 'resolved');

      const statusPath = path.join(project.root, '.agents', 'worktrees', 'agent-endresolve', 'sigterm-status.txt');
      const statusAtSignal = await waitFor(
        () => fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf-8').trim() : null,
        { timeoutMs: 2000, intervalMs: 50 },
      );
      assert.strictEqual(statusAtSignal, 'resolved');
    } finally {
      if (project) project.cleanup();
    }
  });

  // 5. File ownership violations block completion and send the worker through a fix restart.
  it('rejects end_agent completion when changed files violate ownership', () => {
    let project;
    try {
      project = createTempProject('ownership-violation-');

      const cliPath = path.join(project.root, 'ownership-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("ownership-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'const agentName = "agent-owner";',
        '',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Ownership test approval."',
        '  }));',
        '  const actions = requests.map(r => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Ownership test summary.");',
        '  process.exit(0);',
        '}',
        '',
        'function stageRequest(requestId, content) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const request = {',
        '    request_id: requestId,',
        '    agent: agentName,',
        '    type: "review_request",',
        '    priority: "medium",',
        '    status: "pending",',
        '    content,',
        '    created_at: new Date().toISOString()',
        '  };',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        '',
        'if (prompt.includes("Completion was rejected because")) {',
        '  fs.rmSync("package.json", { force: true });',
        '  fs.rmSync("outside.txt", { force: true });',
        '  fs.mkdirSync("allowed", { recursive: true });',
        '  fs.writeFileSync(path.join("allowed", "result.txt"), "fixed within ownership\\n", "utf-8");',
        '  stageRequest(agentName + "-fixed", "Fixed ownership violation and kept only allowed files.");',
        '} else {',
        '  fs.writeFileSync("package.json", "{\\"private\\":true}\\n", "utf-8");',
        '  fs.writeFileSync("outside.txt", "outside allowed paths\\n", "utf-8");',
        '  stageRequest(agentName + "-violating", "Done, but with ownership violations.");',
        '}',
        '',
        'const maxTimer = setTimeout(() => process.exit(0), 50);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n'), 'utf-8');

      writeProjectConfig(project.root, cliPath);
      bootstrapProject(project.root, 'Ownership violation test project');

      const baseBranchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: project.root,
        encoding: 'utf-8',
      });
      assert.strictEqual(baseBranchResult.status, 0, baseBranchResult.stderr);
      const baseBranch = baseBranchResult.stdout.trim();

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-owner': {
          description: 'Test completion ownership enforcement.',
          cli: 'fake',
          allowed_paths: ['allowed/**'],
          forbidden_paths: ['package.json'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-owner');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the ownership test agent.', 'utf-8');

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-owner',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'fake',
        '--base-ref', baseBranch,
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-owner'].status, 'completed');
      assert.strictEqual(agents['agent-owner'].restart_count, 1);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requests.find((r) => r.request_id === 'agent-owner-violating').status, 'rejected');
      assert.strictEqual(requests.find((r) => r.request_id === 'agent-owner-fixed').status, 'resolved');

      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-owner');
      assert.strictEqual(fs.existsSync(path.join(worktree, 'package.json')), false);
      assert.strictEqual(fs.existsSync(path.join(worktree, 'outside.txt')), false);
      assert.strictEqual(fs.readFileSync(path.join(worktree, 'allowed', 'result.txt'), 'utf-8'), 'fixed within ownership\n');

      const changed = spawnSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`, '--'], {
        cwd: worktree,
        encoding: 'utf-8',
      });
      assert.strictEqual(changed.status, 0, changed.stderr);
      assert.deepStrictEqual(changed.stdout.trim().split('\n').filter(Boolean), ['allowed/result.txt']);

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /Completion rejected for agent-owner: file ownership violation/);
      assert.match(log, /Skipping soft-restart WIP commit for agent-owner/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('parks the agent and refunds restart budget when respawn fails', () => {
    let project;
    let workerChild;
    try {
      project = createTempProject('respawn-failure-park-');

      // Orchestrator CLI: approves the pending question AND emits a soft_restart
      // for the same agent. The soft_restart action is what triggers the respawn
      // attempt that the agent's broken `cli` setting will fail.
      const cliPath = path.join(project.root, 'respawn-fail-cli.js');
      fs.writeFileSync(cliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("respawn-fail-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({ request_id: r.request_id, decision: "ok", reason: "test" }));',
        '  const actions = requests.map(r => ({ type: "soft_restart", agent: r.agent, instruction: "retry" }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) { console.log("ok"); process.exit(0); }',
        'process.exit(0);',
      ].join('\n') + '\n', 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "respawn",',
        '  orchestrator_cli: "respawn",',
        // Only "respawn" is configured. The agent's `cli` is intentionally
        // pointed at "broken-cli", which has no template — spawn-agent.js will
        // exit 1 when bumpRestartAndRespawn invokes it.
        `  cli_templates: { respawn: ${JSON.stringify({ cmd: process.execPath, args: [cliPath, { prompt_file: true }] })} },`,
        '  cli_health_checks: { respawn: "node -e \\"process.exit(0)\\"" },',
        '  default_max_restarts: 3,',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Respawn-failure parking regression project');

      // Allowed paths is required, otherwise spawn-agent.js exits with the
      // "ALLOWED PATHS: (unspecified)" error before reaching the cli_templates
      // lookup — we'd still hit the respawn-failure branch, but for the wrong
      // reason. Set it so the test fails for the reason we care about.
      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-fail-respawn': {
          description: 'Simulate respawn failure',
          cli: 'broken-cli',
          allowed_paths: ['out/**'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-fail-respawn');
      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-fail-respawn');

      // Long-running node child stands in for the "running" worker. The loop's
      // process-liveness check uses process_match='node', which matches both
      // this child's cmdline and Node's safeKill expectations.
      workerChild = spawn(process.execPath, ['-e', [
        'setInterval(() => {}, 1000);',
        'process.on("SIGTERM", () => process.exit(0));',
      ].join('')], { stdio: 'ignore', detached: true });
      workerChild.unref();

      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      const nowIso = new Date().toISOString();
      fs.writeFileSync(agentsPath, JSON.stringify({
        'agent-fail-respawn': {
          task: 'Simulate respawn failure',
          status: 'running',
          pid: workerChild.pid,
          cli: 'broken-cli',
          process_match: 'node',
          worktree,
          started_at: nowIso,
          current_started_at: nowIso,
          last_spawned_at: nowIso,
          last_heartbeat: nowIso,
          restart_count: 0,
          base_ref: 'main',
        },
      }, null, 2) + '\n', 'utf-8');

      // One pending question. The orchestrator CLI approves it AND emits a
      // soft_restart for the same agent — the soft_restart action is what
      // exercises bumpRestartAndRespawn's respawn step.
      fs.writeFileSync(path.join(project.root, 'coord', 'requests.jsonl'), JSON.stringify({
        request_id: 'agent-fail-respawn-trigger',
        agent: 'agent-fail-respawn',
        type: 'question',
        priority: 'medium',
        status: 'pending',
        content: 'Should the orchestrator try to restart this agent?',
        created_at: nowIso,
      }) + '\n', 'utf-8');

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(agentsPath);
      const parked = agents['agent-fail-respawn'];
      assert.strictEqual(parked.status, 'needs_attention',
        `Expected "needs_attention" but got "${parked.status}"`);
      assert.match(parked.attention_reason, /respawn failed/);
      assert.ok(parked.attention_at && !Number.isNaN(Date.parse(parked.attention_at)),
        'attention_at is an ISO timestamp');
      assert.ok(typeof parked.next_steps === 'string' && parked.next_steps.length > 0,
        'next_steps populated');
      assert.match(parked.next_steps, /spawn-agent\.js failed/);
      // The crucial property: a respawn that never reached the worker must not
      // consume the restart budget. The bump was refunded back to its prior
      // value (0).
      assert.strictEqual(parked.restart_count, 0,
        `restart_count should have been refunded to 0 after the failed respawn, got ${parked.restart_count}`);

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const parkEvent = events.find((e) => e.event === 'agent_parked' && e.agent === 'agent-fail-respawn');
      assert.ok(parkEvent, 'agent_parked event should be appended');
      assert.match(parkEvent.reason, /respawn failed/);
      assert.ok(parkEvent.data && parkEvent.data.attention_at && parkEvent.data.next_steps,
        'parked event carries attention_at and next_steps');
    } finally {
      if (workerChild && !workerChild.killed) {
        try { process.kill(workerChild.pid, 'SIGKILL'); } catch {}
      }
      if (project) project.cleanup();
    }
  });
});

function gitCommand(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.strictEqual(result.status, 0,
    `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}
