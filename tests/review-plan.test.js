'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { repoRoot } = require('./helpers/temp-project');

const reviewPlanPath = path.join(repoRoot(), 'scripts', 'review-plan.js');

describe('plan review runner', () => {
  it('runs configured reviewers, streams markdown, and stores parsed JSON artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-success-'));
    try {
      const reviewerScript = writeScript(tmp, 'reviewer.js', [
        'const fs = require("node:fs");',
        'const reviewer = process.argv[2];',
        'const promptFile = process.argv[3];',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'if (!prompt.includes("Do not edit files, create git worktrees, launch workers")) process.exit(4);',
        'if (!prompt.includes("\\"tasks\\"")) process.exit(5);',
        'if (!prompt.includes("whether `parallel` should really be `phased`")) process.exit(6);',
        'console.error("checking " + reviewer);',
        'process.stdout.write(JSON.stringify({',
        '  iteration: 1,',
        '  reviewer,',
        '  summary: "ok",',
        '  execution_mode_issues: [],',
        '  blockers: [],',
        '  overlaps: [],',
        '  missing_foundation_work: [],',
        '  sequencing_risks: [],',
        '  validation_gaps: [],',
        '  suggested_changes: []',
        '}));',
      ]);
      writeReviewerConfig(tmp, [
        reviewerEntry('architecture', 'reviewA', 'ownership'),
        reviewerEntry('validation', 'reviewB', 'test coverage'),
      ], {
        reviewA: reviewerTemplate(reviewerScript, 'architecture'),
        reviewB: reviewerTemplate(reviewerScript, 'validation'),
      });
      writeDraft(tmp, 1, { project: 'demo', tasks: { worker: { description: 'do work' } } });

      const result = runReviewPlan(tmp, [
        '--iteration',
        '1',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
        '--coord',
        './coord',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /2 succeeded, 0 failed/);

      const architectureJson = readJson(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1', 'architecture.json'));
      assert.strictEqual(architectureJson.reviewer, 'architecture');
      assert.deepStrictEqual(architectureJson.validation_gaps, []);

      const markdown = fs.readFileSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1', 'architecture.md'), 'utf-8');
      assert.match(markdown, /\[stdout\]/);
      assert.match(markdown, /\[stderr\]/);
      assert.match(markdown, /checking architecture/);

      const draftAudit = readJson(path.join(tmp, 'coord', 'plan-reviews', 'draft-plan-v1.json'));
      assert.strictEqual(draftAudit.project, 'demo');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('treats invalid reviewer JSON as one reviewer failure while keeping successful reviews usable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-invalid-'));
    try {
      const validScript = writeScript(tmp, 'valid.js', [
        'const reviewer = process.argv[2];',
        'process.stdout.write(JSON.stringify({',
        '  iteration: 1, reviewer, summary: "ok", execution_mode_issues: [], blockers: [], overlaps: [],',
        '  missing_foundation_work: [], sequencing_risks: [], validation_gaps: [], suggested_changes: []',
        '}));',
      ]);
      const invalidScript = writeScript(tmp, 'invalid.js', [
        'process.stdout.write("not json");',
      ]);
      writeReviewerConfig(tmp, [
        reviewerEntry('valid', 'validcli', 'valid output'),
        reviewerEntry('invalid', 'invalidcli', 'invalid output'),
      ], {
        validcli: reviewerTemplate(validScript, 'valid'),
        invalidcli: reviewerTemplate(invalidScript, 'invalid'),
      });
      writeDraft(tmp, 1, { project: 'demo', tasks: {} });

      const result = runReviewPlan(tmp, [
        '--iteration',
        '1',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 succeeded, 1 failed/);
      assert.match(result.stderr, /Some plan reviewers failed/);
      assert.ok(fs.existsSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1', 'valid.json')));
      assert.ok(!fs.existsSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1', 'invalid.json')));
      assert.match(fs.readFileSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1', 'invalid.md'), 'utf-8'), /parseable JSON/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails the iteration when every reviewer fails or times out', () => {
    const tmpInvalid = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-all-invalid-'));
    const tmpTimeout = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-timeout-'));
    try {
      const invalidScript = writeScript(tmpInvalid, 'invalid.js', [
        'process.stdout.write("not json");',
      ]);
      writeReviewerConfig(tmpInvalid, [
        reviewerEntry('invalid', 'invalidcli', 'invalid output'),
      ], {
        invalidcli: reviewerTemplate(invalidScript, 'invalid'),
      });
      writeDraft(tmpInvalid, 1, { project: 'demo', tasks: {} });

      const invalidResult = runReviewPlan(tmpInvalid, [
        '--iteration',
        '1',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
      ]);

      assert.notStrictEqual(invalidResult.status, 0);
      assert.match(invalidResult.stderr, /All configured plan reviewers failed/);

      const slowScript = writeScript(tmpTimeout, 'slow.js', [
        'setTimeout(() => {}, 1000);',
      ]);
      writeReviewerConfig(tmpTimeout, [
        reviewerEntry('slow', 'slowcli', 'timeout handling'),
      ], {
        slowcli: reviewerTemplate(slowScript, 'slow'),
      });
      writeDraft(tmpTimeout, 1, { project: 'demo', tasks: {} });

      const timeoutResult = runReviewPlan(tmpTimeout, [
        '--iteration',
        '1',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
        '--timeout-ms',
        '25',
      ]);

      assert.notStrictEqual(timeoutResult.status, 0);
      assert.match(fs.readFileSync(path.join(tmpTimeout, 'coord', 'plan-reviews', 'iteration-1', 'slow.md'), 'utf-8'), /Timed out after 25ms/);
      assert.ok(!fs.existsSync(path.join(tmpTimeout, 'coord', 'plan-reviews', 'iteration-1', 'slow.json')));
    } finally {
      fs.rmSync(tmpInvalid, { recursive: true, force: true });
      fs.rmSync(tmpTimeout, { recursive: true, force: true });
    }
  });

  it('passes updated drafts, prior reconciliation notes, and reviewer template args to later iterations', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-iteration-'));
    try {
      const reviewerScript = writeScript(tmp, 'iteration-check.js', [
        'const fs = require("node:fs");',
        'const reviewer = process.argv[2];',
        'const promptFile = process.argv[3];',
        'const args = process.argv.slice(4);',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'if (!prompt.includes("\\"version\\": 2")) process.exit(10);',
        'if (prompt.includes("\\"version\\": 1")) process.exit(11);',
        'if (!prompt.includes("accepted_feedback")) process.exit(12);',
        'if (!args.includes("--model") || !args.includes("review-model") || !args.includes("--json")) process.exit(13);',
        'process.stdout.write(JSON.stringify({',
        '  iteration: 2, reviewer, summary: "ok", execution_mode_issues: [], blockers: [], overlaps: [],',
        '  missing_foundation_work: [], sequencing_risks: [], validation_gaps: [], suggested_changes: []',
        '}));',
      ]);
      writeReviewerConfig(tmp, [
        '{ name: "architecture", cli: "reviewcli", model: "review-model", template_args: ["--json"], review_focus: "later pass" }',
      ], {
        reviewcli: reviewerTemplate(reviewerScript, 'architecture'),
      }, '2');
      writeDraft(tmp, 1, { version: 1, tasks: {} });
      writeDraft(tmp, 2, { version: 2, tasks: { worker: { description: 'updated' } } });
      fs.mkdirSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1', 'reconciliation.json'), JSON.stringify({
        iteration: 1,
        accepted_feedback: [{ reviewer: 'architecture', item: 'tighten ownership', rationale: 'needed' }],
        rejected_feedback: [],
        next_iteration: { run: true, rationale: 'verify changes' },
      }, null, 2), 'utf-8');

      const result = runReviewPlan(tmp, [
        '--iteration',
        '2',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v2.json',
        '--previous-reconciliation',
        './coord/plan-reviews/iteration-1/reconciliation.json',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-2', 'architecture.json')));

      const missingReconciliation = runReviewPlan(tmp, [
        '--iteration',
        '2',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v2.json',
      ]);
      assert.notStrictEqual(missingReconciliation.status, 0);
      assert.match(missingReconciliation.stderr, /previous-reconciliation is required/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs reviewers from the review artifact directory without creating worker worktrees', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-safety-'));
    try {
      const reviewerScript = writeScript(tmp, 'safety.js', [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const reviewer = process.argv[2];',
        'fs.writeFileSync("attempted-write.txt", process.cwd());',
        'if (process.cwd() === process.argv[4]) process.exit(20);',
        'process.stdout.write(JSON.stringify({',
        '  iteration: 1, reviewer, summary: "ok", execution_mode_issues: [], blockers: [], overlaps: [],',
        '  missing_foundation_work: [], sequencing_risks: [], validation_gaps: [], suggested_changes: []',
        '}));',
      ]);
      writeReviewerConfig(tmp, [
        reviewerEntry('safety', 'safetycli', 'read-only guardrails'),
      ], {
        safetycli: `{ cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(reviewerScript)}, "safety", { prompt_file: true }, ${JSON.stringify(tmp)}] }`,
      });
      writeDraft(tmp, 1, { project: 'demo', tasks: {} });

      const result = runReviewPlan(tmp, [
        '--iteration',
        '1',
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(!fs.existsSync(path.join(tmp, 'attempted-write.txt')), 'reviewer cwd should not be project root');
      assert.ok(fs.existsSync(path.join(tmp, 'coord', 'plan-reviews', 'iteration-1', 'attempted-write.txt')));
      assert.ok(!fs.existsSync(path.join(tmp, '.agents', 'worktrees')), 'review runner must not create worker worktrees');
      assert.ok(!fs.existsSync(path.join(tmp, '.kilocode', 'worktrees')), 'review runner must not create Kilo worktrees');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function runReviewPlan(cwd, args) {
  return spawnSync(process.execPath, [reviewPlanPath, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
    timeout: 5000,
  });
}

function writeReviewerConfig(dir, reviewerEntries, templates, maxIterations = '"auto"') {
  const templateLines = Object.entries(templates).map(([cli, template]) => `    ${cli}: ${template},`);
  fs.writeFileSync(path.join(dir, 'orchestrator.config.js'), [
    'module.exports = {',
    '  default_cli: "reviewA",',
    '  orchestrator_cli: "reviewA",',
    `  max_plan_review_iterations: ${maxIterations},`,
    '  reviewers: [',
    ...reviewerEntries.map((entry) => `    ${entry},`),
    '  ],',
    '  cli_templates: {',
    ...templateLines,
    '  },',
    '  cli_health_checks: {',
    ...Object.keys(templates).map((cli) => `    ${cli}: ${JSON.stringify(`${shellQuote(process.execPath)} --version`)},`),
    '  },',
    '};',
  ].join('\n') + '\n', 'utf-8');
}

function reviewerEntry(name, cli, focus) {
  return `{ name: ${JSON.stringify(name)}, cli: ${JSON.stringify(cli)}, review_focus: ${JSON.stringify(focus)} }`;
}

function reviewerTemplate(scriptPath, reviewerName) {
  return `{ cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(scriptPath)}, ${JSON.stringify(reviewerName)}, { prompt_file: true }] }`;
}

function writeDraft(dir, version, value) {
  const planDir = path.join(dir, 'coord', 'plan-reviews');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, `draft-plan-v${version}.json`), JSON.stringify(value, null, 2), 'utf-8');
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
