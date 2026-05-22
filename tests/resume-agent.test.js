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

const resumePath = path.join(repoRoot(), 'scripts', 'resume-agent.js');

describe('resume-agent primitive', () => {
  it('resumes a parked agent: clears attention_*, flips to running, resets restart_count, relaunches, logs the event', () => {
    let project;
    try {
      project = setupParkedProject('resume-ok-');

      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      const parkedBefore = readJson(agentsPath)['agent-park'];
      assert.strictEqual(parkedBefore.status, 'needs_attention');
      assert.ok(parkedBefore.attention_reason && parkedBefore.attention_at && parkedBefore.next_steps);

      const result = runResume(project.root, ['--agent', 'agent-park', '--coord', './coord']);
      assert.strictEqual(result.status, 0, result.stderr);

      const resumed = readJson(agentsPath)['agent-park'];
      assert.strictEqual(resumed.status, 'running');
      assert.strictEqual(resumed.attention_reason, undefined);
      assert.strictEqual(resumed.attention_at, undefined);
      assert.strictEqual(resumed.next_steps, undefined);
      assert.strictEqual(resumed.restart_count, 0, 'restart_count reset to 0 by default');
      assert.notStrictEqual(resumed.pid, parkedBefore.pid, 'spawn-agent re-registered with a fresh pid');
      assert.ok(resumed.worktree && fs.existsSync(resumed.worktree), 'worktree preserved');
      assert.strictEqual(resumed.progress_timeout_reset_kind, 'resume', 'progress-timeout window reset on resume');
      assert.ok(
        !Number.isNaN(Date.parse(resumed.progress_timeout_reset_at)),
        'progress_timeout_reset_at is an ISO timestamp',
      );

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const resumeEvent = events.find((e) => e.event === 'agent_resumed' && e.agent === 'agent-park');
      assert.ok(resumeEvent, 'agent_resumed event appended');
      assert.strictEqual(resumeEvent.reason, 'manual resume');
      assert.strictEqual(resumeEvent.data.reset_restart_count, true);
      assert.match(resumeEvent.data.prior_attention_reason, /liveness timeout - idle/);
      assert.ok(!Number.isNaN(Date.parse(resumeEvent.data.prior_attention_at)));

      const promptsDir = path.join(project.root, 'coord', 'prompts');
      const promptFile = fs.readdirSync(promptsDir).find((f) => f.startsWith('resume-agent-park-'));
      assert.ok(promptFile, 'a resume prompt file was rendered');
      const promptText = fs.readFileSync(path.join(promptsDir, promptFile), 'utf-8');
      assert.match(promptText, /## Restart Instruction/);
      assert.match(promptText, /Resume the parked liveness-timeout work\./, 'reused agent.task as the instruction');
      assert.match(promptText, /Fix the wedged worker and continue\./, 'worker contract rebuilt from context.tasks');
    } finally {
      if (project) project.cleanup();
    }
  });

  it('preserves restart_count and adopts an explicit instruction with the documented flags', () => {
    let project;
    try {
      project = setupParkedProject('resume-flags-');
      const agentsPath = path.join(project.root, 'coord', 'agents.json');

      const result = runResume(project.root, [
        '--agent', 'agent-park',
        '--coord', './coord',
        '--preserve-restart-count',
        '--instruction', 'Re-run only the failing integration test.',
      ]);
      assert.strictEqual(result.status, 0, result.stderr);

      const resumed = readJson(agentsPath)['agent-park'];
      assert.strictEqual(resumed.status, 'running');
      assert.strictEqual(resumed.restart_count, 5, 'restart_count preserved with --preserve-restart-count');

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const resumeEvent = events.find((e) => e.event === 'agent_resumed');
      assert.strictEqual(resumeEvent.data.reset_restart_count, false);

      const promptsDir = path.join(project.root, 'coord', 'prompts');
      const promptFile = fs.readdirSync(promptsDir).find((f) => f.startsWith('resume-agent-park-'));
      const promptText = fs.readFileSync(path.join(promptsDir, promptFile), 'utf-8');
      assert.match(promptText, /Re-run only the failing integration test\./);
      assert.doesNotMatch(promptText, /Resume the parked liveness-timeout work\./);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('refuses to resume an agent that is not parked and leaves the record untouched', () => {
    let project;
    try {
      project = setupParkedProject('resume-refuse-');
      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      const agents = readJson(agentsPath);
      agents['agent-park'].status = 'running';
      delete agents['agent-park'].attention_reason;
      delete agents['agent-park'].attention_at;
      delete agents['agent-park'].next_steps;
      fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2), 'utf-8');

      const result = runResume(project.root, ['--agent', 'agent-park', '--coord', './coord']);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /is 'running', not 'needs_attention'/);

      const after = readJson(agentsPath)['agent-park'];
      assert.strictEqual(after.status, 'running');
      assert.strictEqual(after.restart_count, 5, 'record left untouched on refusal');
      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      assert.strictEqual(events.find((e) => e.event === 'agent_resumed'), undefined);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('re-parks the agent when spawn-agent.js fails so the operator sees the running flip and the failure cause', () => {
    let project;
    try {
      project = setupParkedProject('resume-spawn-fail-');
      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      const before = readJson(agentsPath)['agent-park'];

      // Point the agent at a CLI name that the project config does not declare.
      // spawn-agent.js will reject with a non-zero exit before registering
      // anything, leaving resume-agent.js to either restore the parked state or
      // (the bug we're guarding against) leave a stale RUNNING record.
      const agents = readJson(agentsPath);
      agents['agent-park'].cli = 'no-such-cli-template';
      fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2), 'utf-8');

      const result = runResume(project.root, ['--agent', 'agent-park', '--coord', './coord']);
      assert.strictEqual(result.status, 1, 'resume should exit non-zero when spawn-agent fails');
      assert.match(result.stderr, /failed to relaunch 'agent-park'/);

      const after = readJson(agentsPath)['agent-park'];
      assert.strictEqual(after.status, 'needs_attention', 're-parked, not left as running');
      assert.ok(after.attention_at && !Number.isNaN(Date.parse(after.attention_at)),
        'attention_at is a fresh ISO timestamp');
      assert.match(
        after.attention_reason,
        /manual resume relaunch failed:/,
        'attention_reason names the relaunch failure',
      );
      assert.match(
        after.attention_reason,
        /\(was: liveness timeout - idle 30 mins\)/,
        'attention_reason preserves the original park cause',
      );
      assert.strictEqual(after.next_steps, before.next_steps, 'prior next_steps restored');

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const failEvent = events.find((e) => e.event === 'agent_resume_failed' && e.agent === 'agent-park');
      assert.ok(failEvent, 'agent_resume_failed event appended');
      assert.match(failEvent.reason, /spawn-agent\.js exited/);
      assert.match(failEvent.data.prior_attention_reason, /liveness timeout - idle/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('errors clearly when the agent name is unknown', () => {
    let project;
    try {
      project = setupParkedProject('resume-missing-');
      const result = runResume(project.root, ['--agent', 'no-such-agent', '--coord', './coord']);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /agent 'no-such-agent' not found/);
    } finally {
      if (project) project.cleanup();
    }
  });
});

// Shared — used by every test above. Builds a temp project whose only agent is
// parked into needs_attention with a spent restart budget, mirroring the state
// the liveness-timeout park site leaves behind.
function setupParkedProject(prefix) {
  const project = createTempProject(prefix);
  const cliPath = writeScript(project.root, 'resume-fake-cli.js', [
    'const fs = require("node:fs");',
    'const promptFile = process.argv[2];',
    'const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";',
    'fs.writeFileSync("resume-marker.txt", prompt, "utf-8");',
    'process.exit(0);',
  ]);
  writeProjectConfig(project.root, cliPath, 'resumefake');
  bootstrapProject(project.root, 'Resume primitive test project');
  addKiloWorktree(project.root, 'agent-park');

  const contextPath = path.join(project.root, 'coord', 'context.json');
  const context = readJson(contextPath);
  context.tasks = {
    'agent-park': {
      description: 'Fix the wedged worker and continue.',
      cli: 'resumefake',
      allowed_paths: ['*.txt'],
    },
  };
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

  const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-park');
  const parkedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
    'agent-park': {
      task: 'Resume the parked liveness-timeout work.',
      status: 'needs_attention',
      worktree,
      cli: 'resumefake',
      pid: 999999,
      restart_count: 5,
      started_at: parkedAt,
      current_started_at: parkedAt,
      last_spawned_at: parkedAt,
      last_heartbeat: parkedAt,
      attention_reason: 'liveness timeout - idle 30 mins',
      attention_at: parkedAt,
      next_steps: 'Inspect the log and worktree, fix the CLI/auth issue, then resume.',
    },
  }, null, 2), 'utf-8');

  return project;
}

function runResume(projectRoot, args) {
  return spawnSync(process.execPath, [resumePath, ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10000,
  });
}

function writeProjectConfig(projectRoot, cliPath, cliName) {
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
    '};',
  ].join('\n') + '\n', 'utf-8');
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
