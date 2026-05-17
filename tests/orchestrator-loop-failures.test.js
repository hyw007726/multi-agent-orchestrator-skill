'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  bootstrapProject,
  addKiloWorktree,
  readJson,
  readJsonl,
} = require('./helpers/temp-project');

const loopPath = path.join(repoRoot(), 'scripts', 'orchestrator-loop.js');

describe('orchestrator loop failure paths', () => {
  it('fails fast when coordination files are missing', () => {
    let project;
    try {
      project = createTempProject('missing-coord-');

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Missing coordination files\. Run bootstrap first\./);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('parks a live but idle agent for attention on liveness timeout', () => {
    let project;
    try {
      project = createTempProject('liveness-timeout-');
      const cliPath = writeScript(project.root, 'idle-cli.js', [
        'const fs = require("node:fs");',
        'const promptFile = process.argv[2];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'if (prompt.includes("reviewing the completed output")) { console.log("summary"); process.exit(0); }',
        'setInterval(() => {}, 10000);',
        'process.on("SIGTERM", () => process.exit(0));',
      ]);
      writeProjectConfig(project.root, cliPath, 'idlefake');
      bootstrapProject(project.root, 'Liveness timeout test project');
      addKiloWorktree(project.root, 'agent-idle');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Stay alive without progress.', 'utf-8');
      const spawnResult = spawnSync(process.execPath, [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent',
        'agent-idle',
        '--prompt-file',
        promptFile,
        '--coord',
        './coord',
        '--cli',
        'idlefake',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, spawnResult.stderr);

      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      const agentsBefore = readJson(agentsPath);
      agentsBefore['agent-idle'].timeout_mins = -1;
      fs.writeFileSync(agentsPath, JSON.stringify(agentsBefore, null, 2), 'utf-8');

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      const agents = readJson(agentsPath);
      const parked = agents['agent-idle'];
      assert.strictEqual(parked.status, 'needs_attention');
      assert.match(parked.attention_reason, /liveness timeout - idle .* mins/);
      assert.ok(!Number.isNaN(Date.parse(parked.attention_at)), 'attention_at is an ISO timestamp');
      assert.ok(parked.next_steps && parked.next_steps.length > 0, 'next_steps populated');
      // Worktree pointer is left intact for a human to resume.
      assert.ok(parked.worktree && fs.existsSync(parked.worktree), 'worktree preserved');

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const parkEvent = events.find((e) => e.event === 'agent_parked' && e.agent === 'agent-idle');
      assert.ok(parkEvent, 'agent_parked event appended');
      assert.match(parkEvent.reason, /liveness timeout/);
      assert.ok(parkEvent.data.attention_at && parkEvent.data.next_steps, 'event carries attention_at and next_steps');

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /Agent agent-idle idle .* Killing/);
      assert.match(log, /running -> needs_attention \(liveness timeout/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('treats a live PID with a mismatched CLI as a vanished worker', () => {
    let project;
    let unrelated;
    try {
      project = createTempProject('recycled-pid-');
      bootstrapProject(project.root, 'Recycled PID liveness test project');

      unrelated = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 10000); process.on("SIGTERM", () => process.exit(0));',
      ], {
        cwd: project.root,
        detached: true,
        stdio: 'ignore',
      });
      assert.ok(unrelated.pid, 'unrelated live process should have a pid');

      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      const logPath = path.join(project.root, 'coord', 'logs', 'agent-recycled.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old worker log line\n', 'utf-8');
      fs.writeFileSync(agentsPath, JSON.stringify({
        'agent-recycled': {
          task: 'PID now belongs to an unrelated process.',
          status: 'running',
          worktree: path.join(project.root, 'missing-worktree'),
          cli: 'zzzz-mismatched-cli-zzzz',
          pid: unrelated.pid,
          timeout_mins: -1,
          progress_timeout_mins: 60,
          started_at: new Date().toISOString(),
          current_started_at: new Date().toISOString(),
        },
      }, null, 2), 'utf-8');

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      const agents = readJson(agentsPath);
      assert.strictEqual(agents['agent-recycled'].status, 'exited');
      assert.strictEqual(agents['agent-recycled'].exit_log_tail, 'old worker log line\n');
      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /process vanished without review request/);
    } finally {
      if (unrelated?.pid) {
        try { process.kill(-unrelated.pid, 'SIGTERM'); } catch {}
        try { process.kill(unrelated.pid, 'SIGTERM'); } catch {}
      }
      if (project) project.cleanup();
    }
  });

  it('refreshes stale log freshness when a respawned worker is initially silent', () => {
    let project;
    try {
      project = createTempProject('stale-log-respawn-');
      const cliPath = writeScript(project.root, 'stale-log-cli.js', [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const promptFile = process.argv[2];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'const agentName = "agent-stale";',
        'if (prompt.includes("reviewing the completed output")) { console.log("Stale log summary."); process.exit(0); }',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const requests = parseRequests(prompt);',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "approved", reason: "stale log test" }));',
        '  const actions = requests.map((r) => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'setTimeout(() => {',
        '  console.log("first worker output after quiet start");',
        '  fs.writeFileSync("stale-log-recovered.txt", "ok\\n", "utf-8");',
        '  stageRequest({',
        '    request_id: agentName + "-done",',
        '    agent: agentName,',
        '    type: "review_request",',
        '    priority: "medium",',
        '    status: "pending",',
        '    content: "Recovered after a silent respawn.",',
        '    created_at: new Date().toISOString()',
        '  });',
        '  setTimeout(() => process.exit(0), 50);',
        '}, 250);',
        'setInterval(() => {}, 10000);',
        'process.on("SIGTERM", () => process.exit(0));',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'function parseRequests(value) {',
        '  const start = value.indexOf("## New Requests from Agents");',
        '  const end = value.indexOf("## Your Responsibilities");',
        '  const section = value.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  return match ? JSON.parse(match[0]) : [];',
        '}',
      ]);
      writeProjectConfig(project.root, cliPath, 'node');
      bootstrapProject(project.root, 'Stale log respawn test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-stale': {
          description: 'Test stale log refresh on respawn.',
          cli: 'node',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-stale');
      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-stale');
      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      fs.writeFileSync(agentsPath, JSON.stringify({
        'agent-stale': {
          task: 'Existing assignment before respawn.',
          status: 'running',
          worktree,
          cli: 'node',
          pid: 999999,
          started_at: '2020-01-01T00:00:00.000Z',
          current_started_at: '2020-01-01T00:00:00.000Z',
          last_spawned_at: '2020-01-01T00:00:00.000Z',
          restart_count: 1,
        },
      }, null, 2), 'utf-8');

      const logPath = path.join(project.root, 'coord', 'logs', 'agent-stale.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log line\n', 'utf-8');
      const staleDate = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(logPath, staleDate, staleDate);

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Respawn silently before writing output.', 'utf-8');
      const spawnResult = spawnSync(process.execPath, [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent',
        'agent-stale',
        '--prompt-file',
        promptFile,
        '--coord',
        './coord',
        '--cli',
        'node',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, spawnResult.stderr);
      assert.ok(fs.statSync(logPath).mtimeMs > staleDate.getTime(),
        'spawn-agent should refresh the existing log mtime immediately');

      const agentsBeforeLoop = readJson(agentsPath);
      agentsBeforeLoop['agent-stale'].timeout_mins = 0.01;
      fs.writeFileSync(agentsPath, JSON.stringify(agentsBeforeLoop, null, 2), 'utf-8');

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      const agents = readJson(agentsPath);
      assert.strictEqual(agents['agent-stale'].status, 'completed');
      assert.notStrictEqual(agents['agent-stale'].current_started_at, agents['agent-stale'].started_at);
      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.doesNotMatch(log, /Agent agent-stale idle .* Killing/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('converts progress timeout into a synthetic arbitration request', () => {
    let project;
    try {
      project = createTempProject('progress-timeout-');
      const cliPath = writeScript(project.root, 'progress-cli.js', [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const promptFile = process.argv[2];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'const agentName = "agent-progress";',
        'if (prompt.includes("This agent is stuck.")) {',
        '  fs.writeFileSync(path.join(process.cwd(), "unexpected-ai-review.txt"), prompt, "utf-8");',
        '  process.exit(2);',
        '}',
        'if (prompt.includes("reviewing the completed output")) { console.log("Progress timeout summary."); process.exit(0); }',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const requests = parseRequests(prompt);',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "approved " + r.type, reason: "test arbitration" }));',
        '  const actions = requests.map((r) => r.type === "progress_timeout"',
        '    ? ({ type: "soft_restart", agent: r.agent, instruction: r.suggested_instruction || "deterministic restart" })',
        '    : ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("## Restart Instruction")) {',
        '  fs.writeFileSync("recovered.txt", "made progress after deterministic timeout\\n", "utf-8");',
        '  writeHeartbeat("done", "Recovered after progress timeout.");',
        '  stageRequest({',
        '    request_id: agentName + "-done",',
        '    agent: agentName,',
        '    type: "review_request",',
        '    priority: "medium",',
        '    status: "pending",',
        '    content: "Progress timeout recovery completed.",',
        '    created_at: new Date().toISOString()',
        '  });',
        '  setTimeout(() => process.exit(0), 50);',
        '} else {',
        '  writeHeartbeat("reading", "Inspecting context before making changes.");',
        '  setInterval(() => console.log("still thinking without changing files"), 50);',
        '}',
        'process.on("SIGTERM", () => process.exit(0));',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'function writeHeartbeat(phase, summary) {',
        '  const progressDir = path.join("coord", "progress");',
        '  fs.mkdirSync(progressDir, { recursive: true });',
        '  const heartbeat = { agent: agentName, phase, summary, last_action: summary, blocker: "", updated_at: new Date().toISOString() };',
        '  const tmpFile = path.join(progressDir, agentName + ".tmp");',
        '  const finalFile = path.join(progressDir, agentName + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(heartbeat) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'function parseRequests(value) {',
        '  const start = value.indexOf("## New Requests from Agents");',
        '  const end = value.indexOf("## Your Responsibilities");',
        '  const section = value.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  return match ? JSON.parse(match[0]) : [];',
        '}',
      ]);
      writeProjectConfig(project.root, cliPath, 'node');
      bootstrapProject(project.root, 'Progress timeout test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-progress': {
          description: 'Test synthetic progress-timeout arbitration.',
          cli: 'node',
          read_first: ['README.md'],
          allowed_paths: ['*.txt'],
          forbidden_paths: ['package.json'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      addKiloWorktree(project.root, 'agent-progress');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the agent without changing files.', 'utf-8');
      const spawnResult = spawnSync(process.execPath, [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent',
        'agent-progress',
        '--prompt-file',
        promptFile,
        '--coord',
        './coord',
        '--cli',
        'node',
        '--progress-timeout',
        '-1',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, spawnResult.stderr);

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(project.root, 'unexpected-ai-review.txt')), false);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-progress'].status, 'completed');
      assert.strictEqual(agents['agent-progress'].restart_count, 1);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      const timeoutRequest = requests.find((request) => request.type === 'progress_timeout');
      assert.ok(timeoutRequest, 'expected a synthetic progress_timeout request');
      assert.strictEqual(timeoutRequest.status, 'resolved');
      assert.strictEqual(timeoutRequest.source, 'orchestrator-loop');
      assert.strictEqual(timeoutRequest.escalation_level, 'first_timeout');
      assert.strictEqual(timeoutRequest.progress_timeout_count, 1);
      assert.strictEqual(timeoutRequest.suggested_action, 'soft_restart');
      assert.match(timeoutRequest.content, /Suggested instruction/);
      assert.match(timeoutRequest.content, /Progress heartbeat/);
      assert.match(timeoutRequest.content, /"phase": "reading"/);
      assert.match(timeoutRequest.content, /Last 50 log lines/);

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /Writing progress-timeout request for arbitration/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('escalates repeated progress timeouts to a hard-restart candidate', () => {
    let project;
    try {
      project = createTempProject('progress-ladder-');
      const cliPath = writeScript(project.root, 'ladder-cli.js', [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const promptFile = process.argv[2];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'const agentName = "agent-ladder";',
        'if (prompt.includes("reviewing the completed output")) { console.log("Progress ladder summary."); process.exit(0); }',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const requests = parseRequests(prompt);',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "approved " + r.type, reason: "ladder test" }));',
        '  const actions = requests.map((r) => {',
        '    if (r.type === "progress_timeout") return { type: r.suggested_action === "hard_restart" ? "hard_restart" : "soft_restart", agent: r.agent, instruction: r.suggested_instruction };',
        '    return { type: "end_agent", agent: r.agent };',
        '  });',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("## Restart Instruction")) {',
        '  fs.writeFileSync("ladder-recovered.txt", "made progress after escalated restart\\n", "utf-8");',
        '  stageRequest({',
        '    request_id: agentName + "-done",',
        '    agent: agentName,',
        '    type: "review_request",',
        '    priority: "medium",',
        '    status: "pending",',
        '    content: "Progress ladder recovery completed.",',
        '    created_at: new Date().toISOString()',
        '  });',
        '  setTimeout(() => process.exit(0), 50);',
        '} else {',
        '  setInterval(() => console.log("still looping before ladder escalation"), 50);',
        '}',
        'process.on("SIGTERM", () => process.exit(0));',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'function parseRequests(value) {',
        '  const start = value.indexOf("## New Requests from Agents");',
        '  const end = value.indexOf("## Your Responsibilities");',
        '  const section = value.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  return match ? JSON.parse(match[0]) : [];',
        '}',
      ]);
      writeProjectConfig(project.root, cliPath, 'node');
      bootstrapProject(project.root, 'Progress ladder test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-ladder': {
          description: 'Test repeated progress timeout escalation.',
          cli: 'node',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      writeRequests(project.root, [
        {
          request_id: 'progress-timeout-agent-ladder-old-1',
          agent: 'agent-ladder',
          type: 'progress_timeout',
          priority: 'high',
          status: 'resolved',
          content: 'Historical timeout 1.',
          created_at: new Date().toISOString(),
        },
        {
          request_id: 'progress-timeout-agent-ladder-old-2',
          agent: 'agent-ladder',
          type: 'progress_timeout',
          priority: 'high',
          status: 'resolved',
          content: 'Historical timeout 2.',
          created_at: new Date().toISOString(),
        },
      ]);

      addKiloWorktree(project.root, 'agent-ladder');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the agent without changing files.', 'utf-8');
      const spawnResult = spawnSync(process.execPath, [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent',
        'agent-ladder',
        '--prompt-file',
        promptFile,
        '--coord',
        './coord',
        '--cli',
        'node',
        '--progress-timeout',
        '-1',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, spawnResult.stderr);

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-ladder'].status, 'completed');
      assert.strictEqual(agents['agent-ladder'].restart_count, 1);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      const freshTimeout = requests.find((request) =>
        request.type === 'progress_timeout' &&
        request.agent === 'agent-ladder' &&
        request.status === 'resolved' &&
        request.source === 'orchestrator-loop'
      );
      assert.ok(freshTimeout, 'expected a new progress_timeout request');
      assert.strictEqual(freshTimeout.previous_progress_timeouts, 2);
      assert.strictEqual(freshTimeout.progress_timeout_count, 3);
      assert.strictEqual(freshTimeout.escalation_level, 'hard_restart_candidate');
      assert.strictEqual(freshTimeout.suggested_action, 'hard_restart');
      assert.match(freshTimeout.content, /Escalation rationale/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('surfaces repeated orchestrator CLI failures and clears the stalled flag after recovery', () => {
    let project;
    try {
      project = createTempProject('cli-stalled-');
      const cliPath = writeScript(project.root, 'recovering-cli.js', [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const promptFile = process.argv[2];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const countFile = path.join(process.cwd(), "orchestrator-count.txt");',
        '  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf-8")) : 0;',
        '  fs.writeFileSync(countFile, String(count + 1), "utf-8");',
        '  if (count < 3) { console.log("not json yet"); process.exit(0); }',
        '  const requests = [{ request_id: "req-stalled", agent: "agent-cli" }];',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "approved", reason: "recovered" }));',
        '  const actions = requests.map((r) => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) { console.log("Recovered summary."); process.exit(0); }',
        'console.log("worker noop");',
        'function parseRequests(prompt) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  return match ? JSON.parse(match[0]) : [];',
        '}',
      ]);
      writeProjectConfig(project.root, cliPath, 'recoverfake', [
        '  orchestrator_failure_threshold: 1,',
      ]);
      bootstrapProject(project.root, 'CLI recovery test project');
      writeAgents(project.root, {
        'agent-cli': {
          status: 'completed',
          task: 'Await orchestration.',
          pid: 0,
          cli: 'recoverfake',
          worktree: path.join(project.root, 'missing-worktree'),
        },
      });
      writeRequests(project.root, [{
        request_id: 'req-stalled',
        agent: 'agent-cli',
        type: 'review_request',
        priority: 'high',
        status: 'pending',
        content: 'Please end this agent.',
      }]);

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /No JSON object in CLI output/);
      assert.match(log, /Wrote stalled flag/);
      assert.match(log, /Cleared stalled flag/);
      assert.strictEqual(fs.existsSync(path.join(project.root, 'coord', 'orchestrator-stalled.flag')), false);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requests.find((r) => r.request_id === 'req-stalled').status, 'resolved');
      const summary = fs.readFileSync(path.join(project.root, 'coord', 'review-summary.txt'), 'utf-8');
      assert.match(summary, /ALL AGENTS COMPLETED/);
      assert.match(summary, /Please end this agent/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('times out hanging orchestrator CLI calls and still writes the stalled flag', () => {
    let project;
    try {
      project = createTempProject('cli-timeout-stalled-');
      const cliPath = writeScript(project.root, 'timeout-cli.js', [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const promptFile = process.argv[2];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const countFile = path.join(process.cwd(), "orchestrator-timeout-count.txt");',
        '  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf-8")) : 0;',
        '  fs.writeFileSync(countFile, String(count + 1), "utf-8");',
        '  if (count < 3) { setInterval(() => {}, 10000); return; }',
        '  const requests = [{ request_id: "req-timeout-stalled", agent: "agent-timeout" }];',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "approved after timeout", reason: "recovered" }));',
        '  const actions = requests.map((r) => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) { console.log("Timeout summary."); process.exit(0); }',
        'function parseRequests(prompt) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  return match ? JSON.parse(match[0]) : [];',
        '}',
      ]);
      writeProjectConfig(project.root, cliPath, 'timeoutfake', [
        '  orchestrator_failure_threshold: 1,',
        '  orchestrator_cli_timeout_ms: 100,',
      ]);
      bootstrapProject(project.root, 'CLI timeout stalled test project');
      writeAgents(project.root, {
        'agent-timeout': {
          status: 'completed',
          task: 'Await orchestration after a hung arbitrator.',
          pid: 0,
          cli: 'timeoutfake',
          worktree: path.join(project.root, 'missing-worktree'),
        },
      });
      writeRequests(project.root, [{
        request_id: 'req-timeout-stalled',
        agent: 'agent-timeout',
        type: 'review_request',
        priority: 'high',
        status: 'pending',
        content: 'Please end this agent after timeout recovery.',
      }]);

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /timed out after 100ms/i);
      assert.match(log, /Orchestrator CLI failed: Timed out after 100ms/);
      assert.match(log, /Wrote stalled flag/);
      assert.match(log, /Cleared stalled flag/);
      assert.strictEqual(fs.existsSync(path.join(project.root, 'coord', 'orchestrator-stalled.flag')), false);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requests.find((r) => r.request_id === 'req-timeout-stalled').status, 'resolved');
    } finally {
      if (project) project.cleanup();
    }
  });

  it('terminates an agent when a restart action has no follow-up instruction', () => {
    let project;
    try {
      project = createTempProject('restart-no-instruction-');
      const cliPath = writeScript(project.root, 'no-instruction-cli.js', [
        'const fs = require("node:fs");',
        'const promptFile = process.argv[2];',
        'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const requests = [{ request_id: "req-no-instruction", agent: "agent-noinst" }];',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "restart accepted", reason: "missing instruction path" }));',
        '  const actions = requests.map((r) => ({ type: "soft_restart", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) { console.log("Terminated summary."); process.exit(0); }',
        'function parseRequests(prompt) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  return match ? JSON.parse(match[0]) : [];',
        '}',
      ]);
      writeProjectConfig(project.root, cliPath, 'norestartfake');
      bootstrapProject(project.root, 'No instruction restart test project');
      writeAgents(project.root, {
        'agent-noinst': {
          status: 'completed',
          task: 'Needs a restart decision.',
          pid: 0,
          cli: 'norestartfake',
          worktree: path.join(project.root, 'missing-worktree'),
        },
      });
      writeRequests(project.root, [{
        request_id: 'req-no-instruction',
        agent: 'agent-noinst',
        type: 'review_request',
        priority: 'medium',
        status: 'pending',
        content: 'Please restart me.',
      }]);

      const result = runLoop(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-noinst'].status, 'terminated');
      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /no follow-up instruction/);
      assert.match(log, /Agent agent-noinst terminated/);
      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requests.find((r) => r.request_id === 'req-no-instruction').status, 'resolved');
    } finally {
      if (project) project.cleanup();
    }
  });
});

function runLoop(projectRoot) {
  return spawnSync(process.execPath, [
    loopPath,
    '--coord',
    './coord',
    '--poll-interval',
    '100',
  ], {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10000,
  });
}

function writeProjectConfig(projectRoot, cliPath, cliName, extraLines = []) {
  fs.writeFileSync(path.join(projectRoot, 'orchestrator.config.js'), [
    'module.exports = {',
    `  default_cli: ${JSON.stringify(cliName)},`,
    `  orchestrator_cli: ${JSON.stringify(cliName)},`,
    '  cli_templates: {',
    `    ${JSON.stringify(cliName)}: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(cliPath)}, { prompt_file: true }] },`,
    '  },',
    '  cli_health_checks: {',
    `    ${JSON.stringify(cliName)}: ${JSON.stringify(`${shellQuote(process.execPath)} -e "process.exit(0)"`)},`,
    '  },',
    '  poll_min_ms: 100,',
    '  poll_max_ms: 100,',
    '  launch_dashboard: false,',
    '  launch_review_terminal: false,',
    ...extraLines,
    '};',
  ].join('\n') + '\n', 'utf-8');
}

function writeAgents(projectRoot, agents) {
  fs.writeFileSync(path.join(projectRoot, 'coord', 'agents.json'), JSON.stringify(agents, null, 2), 'utf-8');
}

function writeRequests(projectRoot, requests) {
  fs.writeFileSync(
    path.join(projectRoot, 'coord', 'requests.jsonl'),
    requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    'utf-8'
  );
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
