'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  readJson,
  readJsonl,
  waitFor,
  cleanupProcess,
} = require('./helpers/temp-project');

const prepareRunScript = path.join(repoRoot(), 'scripts', 'prepare-run.js');
const launchAllScript = path.join(repoRoot(), 'scripts', 'launch-all.js');
const { parseArgs } = require('../scripts/prepare-run');

describe('prepare-run guided starter pipeline', () => {
  it('runs preflight, bootstraps coord, drafts a plan, and stops for approval', () => {
    let project;
    try {
      project = createTempProject('prepare-run-draft-');
      const cliPath = writePrepareCli(project.root);
      writePrepareConfig(project.root, cliPath);

      const result = runPrepare(project.root, [
        '--project',
        'Prepare run project',
        '--task',
        'Add starter automation safely',
        '--requirements',
        'Guided command,Approval loop',
        '--constraints',
        'No launch before approval',
        '--chat-context',
        'User prefers session boundaries',
        '--timeout-ms',
        '1000',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Prepare-run draft stage/);
      assert.match(result.stdout, /\[step\] Preflight configured CLIs/);
      assert.match(result.stdout, /\[step\] Bootstrap coordination files/);
      assert.match(result.stdout, /\[step\] Create caller-authored draft template/);
      assert.match(result.stdout, /Prepare-run stopped for caller approval/);
      assert.match(result.stdout, /Optional plan review:/);
      assert.match(result.stdout, /prepare-run\.js --approve-draft/);

      const context = readJson(path.join(project.root, 'coord', 'context.json'));
      assert.deepStrictEqual(context.tasks, {});
      assert.deepStrictEqual(context.requirements, ['Guided command', 'Approval loop']);
      assert.deepStrictEqual(context.constraints, ['No launch before approval']);

      const callerContext = fs.readFileSync(path.join(project.root, 'coord', 'CALLER_CONTEXT.md'), 'utf-8');
      assert.match(callerContext, /User prefers session boundaries/);

      const draft = readJson(path.join(project.root, 'coord', 'plan-reviews', 'draft-plan-v1.json'));
      assert.strictEqual(draft.project, 'Prepare run project');
      assert.match(draft.candidate_execution_topology.execution_mode, /^TODO:/);
      assert.match(draft.foundation.status, /^TODO:/);
      assert.strictEqual(draft._source.task, 'Add starter automation safely');
      assert.ok(fs.existsSync(path.join(project.root, 'coord', 'plan-reviews', 'draft-plan-v1.instructions.md')));
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));
      assert.ok(!fs.existsSync(path.join(project.root, '.kilocode', 'worktrees')));
    } finally {
      if (project) project.cleanup();
    }
  });

  it('materializes an approved draft, validates it, and prints the launch command', () => {
    let project;
    try {
      project = createTempProject('prepare-run-approval-');
      const cliPath = writePrepareCli(project.root);
      writePrepareConfig(project.root, cliPath);

      const draftResult = runPrepare(project.root, [
        '--project',
        'Prepare approval project',
        '--task',
        'Materialize after approval',
        '--timeout-ms',
        '1000',
      ]);
      assert.strictEqual(draftResult.status, 0, draftResult.stderr);
      writeApprovedDraft(project.root, {
        project: 'Prepare approval project',
        agentName: 'agent-prepare',
        description: 'Implement the fake prepare-run task.',
        allowedPaths: ['src/**', 'tests/**'],
        validationCommand: ['node', '--test'],
      });

      const approvalResult = runPrepare(project.root, [
        '--approve-draft',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
      ]);

      assert.strictEqual(approvalResult.status, 0, approvalResult.stderr);
      assert.match(approvalResult.stdout, /Prepare-run approval stage/);
      assert.match(approvalResult.stdout, /\[step\] Materialize approved draft/);
      assert.match(approvalResult.stdout, /\[step\] Validate materialized context/);
      assert.match(approvalResult.stdout, /Final launch command:/);
      assert.match(approvalResult.stdout, /launch-all\.js --coord \.\/coord/);

      const context = readJson(path.join(project.root, 'coord', 'context.json'));
      assert.strictEqual(context.execution_topology.execution_mode, 'single_worker');
      assert.deepStrictEqual(Object.keys(context.tasks), ['agent-prepare']);

      const decisions = fs.readFileSync(path.join(project.root, 'coord', 'DECISIONS.md'), 'utf-8');
      assert.match(decisions, /## File Ownership/);
      assert.match(decisions, /agent-prepare/);

      const callerContext = fs.readFileSync(path.join(project.root, 'coord', 'CALLER_CONTEXT.md'), 'utf-8');
      assert.match(callerContext, /Selected topology during draft planning: single_worker/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));
      assert.ok(!fs.existsSync(path.join(project.root, '.kilocode', 'worktrees')));
    } finally {
      if (project) project.cleanup();
    }
  });

  it('can prepare, approve, launch, arbitrate, validate, and summarize one worker', { timeout: 30000 }, async () => {
    let project;
    let loopPid = null;
    try {
      project = createTempProject('prepare-run-e2e-');
      const cliPath = writeEndToEndCli(project.root);
      writeEndToEndConfig(project.root, cliPath);

      const draftResult = runPrepare(project.root, [
        '--project',
        'Prepare launch project',
        '--task',
        'Prepare and launch a fake worker',
        '--timeout-ms',
        '1000',
      ]);
      assert.strictEqual(draftResult.status, 0, draftResult.stderr);
      writeApprovedDraft(project.root, {
        project: 'Prepare launch project',
        agentName: 'agent-one',
        description: 'Create worker-output.txt and request review.',
        allowedPaths: ['worker-output.txt'],
        validationCommand: ['test', '-f', 'worker-output.txt'],
      });

      const approvalResult = runPrepare(project.root, [
        '--approve-draft',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
      ]);
      assert.strictEqual(approvalResult.status, 0, approvalResult.stderr);

      const launchResult = spawnSync(process.execPath, [launchAllScript, '--coord', './coord'], {
        cwd: project.root,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      assert.strictEqual(
        launchResult.status,
        0,
        `launch-all failed\nstdout:\n${launchResult.stdout}\nstderr:\n${launchResult.stderr}`
      );
      assert.match(launchResult.stdout, /Agent 'agent-one' spawned/);

      const loopPidMatch = launchResult.stdout.match(/Orchestrator loop backgrounded \(PID:\s*(\d+)\)/);
      loopPid = loopPidMatch ? parseInt(loopPidMatch[1], 10) : null;

      const summaryPath = path.join(project.root, 'coord', 'review-summary.txt');
      await waitFor(() => {
        if (!fs.existsSync(summaryPath)) return false;
        const summary = fs.readFileSync(summaryPath, 'utf-8');
        return summary.includes('agent-one created worker-output.txt and is ready for validation.') ? summary : false;
      }, { timeoutMs: 20000, intervalMs: 250 });

      cleanupLoopLock(project.root, loopPid);
      loopPid = null;

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-one'].status, 'completed');
      assert.deepStrictEqual(agents['agent-one'].validate_cmd, ['test', '-f', 'worker-output.txt']);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.ok(
        requests.some((r) => r.request_id === 'agent-one-req-prepare-e2e' && r.status === 'resolved'),
        'requests.jsonl should contain a resolved agent-one-req-prepare-e2e request'
      );

      const workerOutput = path.join(project.root, '.agents', 'worktrees', 'agent-one', 'worker-output.txt');
      assert.ok(fs.existsSync(workerOutput), 'worker-output.txt should exist in the launched worktree');
    } finally {
      if (project && loopPid) cleanupLoopLock(project.root, loopPid);
      if (project) project.cleanup();
    }
  });

  it('preserves existing bootstrap context unless --force is used', () => {
    let project;
    try {
      project = createTempProject('prepare-run-existing-');
      const cliPath = writePrepareCli(project.root);
      writePrepareConfig(project.root, cliPath);
      fs.mkdirSync(path.join(project.root, 'coord'), { recursive: true });
      fs.writeFileSync(path.join(project.root, 'coord', 'context.json'), JSON.stringify({
        project: 'Existing project',
        chat_context: { summary: 'preserve me' },
        execution_topology: { execution_mode: '', reason: '', dependency_notes: [] },
        requirements: ['Existing requirement'],
        constraints: [],
        created_at: '2026-01-01T00:00:00.000Z',
        tasks: {},
      }, null, 2) + '\n');

      const result = runPrepare(project.root, [
        '--project',
        'New project name should not overwrite context',
        '--task',
        'Draft only',
        '--timeout-ms',
        '1000',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[skip\] Bootstrap/);
      assert.strictEqual(readJson(path.join(project.root, 'coord', 'context.json')).project, 'Existing project');

      const forced = runPrepare(project.root, [
        '--project',
        'Forced project name overwrites context',
        '--task',
        'Draft only',
        '--timeout-ms',
        '1000',
        '--force',
      ]);

      assert.strictEqual(forced.status, 0, forced.stderr);
      assert.match(forced.stdout, /\[step\] Bootstrap coordination files/);
      assert.strictEqual(
        readJson(path.join(project.root, 'coord', 'context.json')).project,
        'Forced project name overwrites context'
      );
    } finally {
      if (project) project.cleanup();
    }
  });

  it('parses args and rejects missing mode requirements', () => {
    assert.deepStrictEqual(parseArgs([
      '--project', 'Demo',
      '--task-file', 'task.md',
      '--coord', './state',
      '--requirements', 'A,B',
      '--constraints', 'C',
      '--chat-context', 'Nuance',
      '--repo-scan-summary', 'scan.json',
      '--timeout-ms', '25',
      '--skip-preflight-auth',
      '--force',
    ]), {
      coordDir: './state',
      project: 'Demo',
      task: '',
      taskFile: 'task.md',
      draftPlan: '',
      requirements: 'A,B',
      constraints: 'C',
      chatContext: 'Nuance',
      repoScanSummary: 'scan.json',
      timeoutMs: 25,
      skipPreflightAuth: true,
      approveDraft: false,
      force: true,
      help: false,
    });
    assert.strictEqual(parseArgs(['--help']).help, true);
    assert.strictEqual(parseArgs(['-h']).help, true);
    assert.throws(() => parseArgs(['--task', 'x', '--timeout-ms', '0']), /positive integer/);
    assert.throws(() => parseArgs(['--task']), /--task requires a value/);
    assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);

    const missingProject = runPrepare(process.cwd(), ['--task', 'x']);
    assert.notStrictEqual(missingProject.status, 0);
    assert.match(missingProject.stderr, /--project is required/);

    const missingDraft = runPrepare(process.cwd(), ['--approve-draft']);
    assert.notStrictEqual(missingDraft.status, 0);
    assert.match(missingDraft.stderr, /--draft-plan is required/);
  });
});

function runPrepare(cwd, args) {
  return spawnSync(process.execPath, [prepareRunScript, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 5 * 1024 * 1024,
  });
}

function writePrepareConfig(projectRoot, cliPath) {
  fs.writeFileSync(path.join(projectRoot, 'orchestrator.config.js'), [
    'module.exports = {',
    '  default_cli: "preparefake",',
    '  orchestrator_cli: "preparefake",',
    '  launch_dashboard: false,',
    '  cli_templates: {',
    `    preparefake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(cliPath)}, { prompt_file: true }] },`,
    '  },',
    '  cli_health_checks: {',
    '    preparefake: "node --version",',
    '  },',
    '};',
  ].join('\n') + '\n', 'utf-8');
}

function writePrepareCli(projectRoot) {
  const file = path.join(projectRoot, 'prepare-cli.js');
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("node:fs");',
    'const prompt = fs.readFileSync(process.argv[2], "utf-8");',
    'if (prompt.includes("Reply with the single word: OK")) {',
    '  process.stdout.write("OK\\n");',
    '  process.exit(0);',
    '}',
    'process.exit(7);',
  ].join('\n') + '\n', 'utf-8');
  return file;
}

function writeApprovedDraft(projectRoot, options) {
  const draftPath = path.join(projectRoot, 'coord', 'plan-reviews', 'draft-plan-v1.json');
  const agentName = options.agentName;
  const draft = {
    project: options.project,
    user_requirements: ['Guided prepare-run flow'],
    constraints: ['Stop for caller approval before launch'],
    candidate_execution_topology: {
      execution_mode: 'single_worker',
      reason: 'The fake task is substantial but sequential.',
      rejected_alternatives: [
        { execution_mode: 'direct', reason: 'Needs generated coordination artifacts.' },
        { execution_mode: 'parallel', reason: 'No independent fake boundaries.' },
      ],
      dependency_notes: ['No shared foundation required.'],
      shared_foundation_notes: ['Bootstrap created coordination files.'],
      mode_specific_decomposition: ['One worker handles the fake implementation.'],
    },
    shared_foundation_assumptions: ['No package or lockfile changes.'],
    foundation: {
      status: 'not_required',
      paths: [],
      commit: '',
      owner: '',
    },
    known_risks: ['The caller must review before launching.'],
    tasks: {
      [agentName]: {
        description: options.description,
        allowed_paths: options.allowedPaths,
        forbidden_paths: ['coord/', 'package.json'],
        read_first: ['README.md'],
        validation_command: options.validationCommand,
        sequencing_notes: ['Run only after caller approval.'],
      },
    },
  };
  fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n', 'utf-8');
}

function writeEndToEndConfig(projectRoot, cliPath) {
  fs.writeFileSync(path.join(projectRoot, 'orchestrator.config.js'), [
    'module.exports = {',
    '  default_cli: "e2efake",',
    '  orchestrator_cli: "e2efake",',
    '  poll_min_ms: 250,',
    '  poll_max_ms: 500,',
    '  launch_dashboard: false,',
    '  launch_review_terminal: false,',
    '  cli_templates: {',
    `    e2efake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(cliPath)}, { prompt_file: true }] },`,
    '  },',
    '  cli_health_checks: {',
    '    e2efake: "node --version",',
    '  },',
    '};',
  ].join('\n') + '\n', 'utf-8');
}

function writeEndToEndCli(projectRoot) {
  const file = path.join(projectRoot, 'prepare-e2e-cli.js');
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const prompt = fs.readFileSync(process.argv[2], "utf-8");',
    'if (prompt.includes("Reply with the single word: OK")) {',
    '  process.stdout.write("OK\\n");',
    '  process.exit(0);',
    '}',
    'if (prompt.includes("read-only initial decomposition planner")) {',
    '  process.stdout.write(JSON.stringify({',
    '    project: "Prepare launch project",',
    '    user_requirements: ["Guided prepare-run launches only after caller approval"],',
    '    constraints: ["Keep generated coordination context explicit"],',
    '    candidate_execution_topology: {',
    '      execution_mode: "single_worker",',
    '      reason: "The fake launch task is sequential and needs one isolated worker.",',
    '      rejected_alternatives: [',
    '        { execution_mode: "direct", reason: "This smoke test must exercise worker launch." },',
    '        { execution_mode: "parallel", reason: "There is only one independent output file." },',
    '        { execution_mode: "phased", reason: "No shared foundation phase is needed." }',
    '      ],',
    '      dependency_notes: ["No dependencies between workers."],',
    '      shared_foundation_notes: ["No package or lockfile changes are needed."],',
    '      mode_specific_decomposition: ["One worker writes worker-output.txt and requests review."]',
    '    },',
    '    shared_foundation_assumptions: ["README.md is read-only context for this run."],',
    '    foundation: { status: "not_required", paths: [], commit: "", owner: "" },',
    '    known_risks: ["The background loop must receive caller context from files, not chat."],',
    '    tasks: {',
    '      "agent-one": {',
    '        description: "Create worker-output.txt and request review.",',
    '        allowed_paths: ["worker-output.txt"],',
    '        forbidden_paths: ["coord/", "package.json"],',
    '        read_first: ["README.md"],',
    '        validation_command: ["test", "-f", "worker-output.txt"],',
    '        sequencing_notes: ["Run after the caller approves the draft plan."]',
    '      }',
    '    }',
    '  }));',
    '  process.exit(0);',
    '}',
    'if (prompt.includes("system orchestrator for a multi-agent project")) {',
    '  const requestsStart = prompt.indexOf("## New Requests from Agents");',
    '  const requestsSection = requestsStart === -1 ? prompt : prompt.slice(requestsStart);',
    '  const requestId = (requestsSection.match(/"request_id":\\s*"([^"]+)"/) || [])[1] || "agent-one-req-prepare-e2e";',
    '  const agent = (requestsSection.match(/"agent":\\s*"([^"]+)"/) || [])[1] || "agent-one";',
    '  process.stdout.write(JSON.stringify({',
    '    approved: [{ request_id: requestId, decision: "Prepare-run e2e completion approved.", reason: "The fake worker created the expected output file." }],',
    '    rejected: [],',
    '    actions: [{ type: "end_agent", agent }]',
    '  }));',
    '  process.exit(0);',
    '}',
    'if (prompt.includes("reviewing the completed output")) {',
    '  process.stdout.write("Prepare-run e2e summary complete.\\n");',
    '  process.exit(0);',
    '}',
    'fs.writeFileSync("worker-output.txt", "Prepare-run e2e worker output.\\n", "utf-8");',
    'const request = {',
    '  request_id: "agent-one-req-prepare-e2e",',
    '  agent: "agent-one",',
    '  type: "review_request",',
    '  priority: "medium",',
    '  status: "pending",',
    '  content: "agent-one created worker-output.txt and is ready for validation.",',
    '  created_at: new Date().toISOString()',
    '};',
    'const requestsDir = path.join("coord", "requests");',
    'fs.mkdirSync(requestsDir, { recursive: true });',
    'const tmpFile = path.join(requestsDir, "agent-one-prepare-e2e.tmp");',
    'const finalFile = path.join(requestsDir, "agent-one-prepare-e2e.json");',
    'fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
    'fs.renameSync(tmpFile, finalFile);',
    'const maxTimer = setTimeout(() => process.exit(0), 100);',
    'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
  ].join('\n') + '\n', 'utf-8');
  return file;
}

function cleanupLoopLock(projectRoot, loopPid) {
  if (loopPid) cleanupProcess(loopPid);
  const lockDir = path.join(projectRoot, 'coord', 'orchestrator.instance.lock');
  const lockPidFile = path.join(lockDir, 'pid');
  if (fs.existsSync(lockPidFile)) {
    try {
      const lockPid = parseInt(fs.readFileSync(lockPidFile, 'utf-8'), 10);
      cleanupProcess(lockPid);
    } catch {}
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {}
}
