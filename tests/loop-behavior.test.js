'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('child_process');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  addKiloWorktree,
  runLoop,
  readJson,
  readJsonl,
} = require('./helpers/temp-project');

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

      // Create the abort flag.
      fs.writeFileSync(path.join(project.root, 'coord', 'abort.flag'), 'stop\n', 'utf-8');

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

  // 4. Validation failure converts to soft restart and preserves validation command.
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
});
