'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

  it('marks a live but idle agent errored on liveness timeout', () => {
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
      assert.strictEqual(agents['agent-idle'].status, 'errored');
      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.match(log, /Agent agent-idle idle .* Killing/);
      assert.match(log, /liveness timeout/);
      assert.match(log, /Run ended incomplete/);
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
        'if (prompt.includes("reviewing the completed output")) { console.log("Recovered summary."); process.exit(0); }',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const countFile = path.join(process.cwd(), "orchestrator-count.txt");',
        '  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf-8")) : 0;',
        '  fs.writeFileSync(countFile, String(count + 1), "utf-8");',
        '  if (count < 3) { console.log("not json yet"); process.exit(0); }',
        '  const requests = parseRequests(prompt);',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "approved", reason: "recovered" }));',
        '  const actions = requests.map((r) => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'console.log("worker noop");',
        'function parseRequests(prompt) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities");',
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
      assert.match(fs.readFileSync(path.join(project.root, 'coord', 'review-summary.txt'), 'utf-8'), /Recovered summary/);
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
        'if (prompt.includes("reviewing the completed output")) { console.log("Terminated summary."); process.exit(0); }',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const requests = parseRequests(prompt);',
        '  const approved = requests.map((r) => ({ request_id: r.request_id, decision: "restart accepted", reason: "missing instruction path" }));',
        '  const actions = requests.map((r) => ({ type: "soft_restart", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }));',
        '  process.exit(0);',
        '}',
        'function parseRequests(prompt) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities");',
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
