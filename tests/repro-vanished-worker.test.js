'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  addKiloWorktree,
  runLoop,
  readJson,
} = require('./helpers/temp-project');

describe('vanished worker', () => {
  it('marks worker as exited (not completed) when process vanishes without review_request', async () => {
    let project;
    try {
      project = createTempProject('vanish-');

      // Create a suicidal fake CLI that exits immediately without writing a review_request.
      const suicidalCliPath = path.join(project.root, 'suicidal-cli.js');
      fs.writeFileSync(suicidalCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("suicidal-cli 1.0.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        '// Do NOT write a review_request — just exit immediately so the loop sees a vanished process.',
        'const maxTimer = setTimeout(() => process.exit(0), 50);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n'), 'utf-8');

      // Write project config pointing to the suicidal CLI.
      const configPath = path.join(project.root, 'orchestrator.config.js');
      fs.writeFileSync(configPath, [
        'module.exports = {',
        '  default_cli: "suicidal",',
        '  orchestrator_cli: "suicidal",',
        `  cli_templates: { suicidal: 'node "${suicidalCliPath}" {prompt_file}' },`,
        '  cli_health_checks: { suicidal: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Vanished worker test project');

      // Write context with a task so launch-all or manual spawn knows what to do.
      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
      context.tasks = {
        'agent-vanish': {
          description: 'This agent will exit without submitting work',
          cli: 'suicidal',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

      addKiloWorktree(project.root, 'agent-vanish');

      // Spawn the worker manually (like spawnWorker but using the suicidal CLI config).
      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'You will exit without submitting a review_request.');

      const { spawnSync } = require('child_process');
      const spawnArgs = [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-vanish',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'suicidal',
      ];
      const spawnResult = spawnSync('node', spawnArgs, { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      // Run the loop — the suicidal CLI exits after 50ms, so the loop should detect it as vanished.
      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      // The agent should be marked 'exited', not 'completed'.
      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.ok(agents && agents['agent-vanish'], 'agents.json should contain agent-vanish');
      assert.strictEqual(agents['agent-vanish'].status, 'exited',
        `Expected status "exited" but got "${agents['agent-vanish'].status}"`);
      assert.ok(agents['agent-vanish'].exit_log_tail !== undefined,
        'exit_log_tail should be set on the vanished agent');

      // The summary should contain the "RUN INCOMPLETE" fallback, not the AI summary.
      const summaryPath = path.join(project.root, 'coord', 'review-summary.txt');
      assert.ok(fs.existsSync(summaryPath), 'review-summary.txt should exist');
      const summaryContent = fs.readFileSync(summaryPath, 'utf-8');
      assert.ok(summaryContent.includes('RUN INCOMPLETE'),
        'review-summary.txt should contain "RUN INCOMPLETE" fallback');
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});
