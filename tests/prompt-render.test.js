'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  WORKER_CONCISION_PROMPT,
  renderWorkerPrompt,
  renderWorkerRestartPrompt,
} = require('../scripts/lib/prompt-render');
const { buildOrchestratorPrompt } = require('../scripts/orchestrator-loop');
const { renderReviewerPrompt } = require('../scripts/review-plan');

describe('worker prompt rendering', () => {
  it('includes concise response instructions in initial worker prompts', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'references', 'worker-prompt-template.md'),
      'utf-8'
    );

    const prompt = renderWorkerPrompt(template, {
      ASSIGNED_TASK: 'Build the thing',
      PROJECT_DESCRIPTION: 'Test project',
      AGENT_NAME: 'agent-test',
      WORKTREE_PATH: '.agents/worktrees/agent-test',
      READ_FIRST_LIST: ['src/index.js', 'tests/index.test.js'],
      ALLOWED_PATHS_LIST: ['src/**'],
      FORBIDDEN_PATHS_LIST: ['package.json'],
    });

    assert.ok(prompt.includes('## Response Style'));
    assert.ok(prompt.includes(WORKER_CONCISION_PROMPT));
    assert.ok(prompt.includes('src/index.js, tests/index.test.js'));
    assert.ok(prompt.includes('Use `coord/context.json` only as the compact run index'));
    assert.ok(prompt.includes('coord/CALLER_CONTEXT.md'));
    assert.ok(prompt.includes('approved and rejected request dispositions'));
  });

  it('keeps worker-specific data out of the stable worker prompt prefix', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'references', 'worker-prompt-template.md'),
      'utf-8'
    );

    const prompt = renderWorkerPrompt(template, {
      ASSIGNED_TASK: 'Build the thing',
      PROJECT_DESCRIPTION: 'Test project',
      AGENT_NAME: 'agent-test',
      WORKTREE_PATH: '.agents/worktrees/agent-test',
      READ_FIRST_LIST: ['src/index.js'],
      ALLOWED_PATHS_LIST: ['src/**'],
      FORBIDDEN_PATHS_LIST: ['package.json'],
    });

    const dynamicStart = prompt.indexOf('## Dynamic Assignment');
    assert.ok(dynamicStart > prompt.indexOf('### Request Format'));
    assert.strictEqual(prompt.slice(0, dynamicStart).includes('Build the thing'), false);
    assert.strictEqual(prompt.slice(0, dynamicStart).includes('agent-test'), false);
    assert.strictEqual(prompt.includes('"agent" : "<agent-name>"'), true);
    assert.ok(prompt.indexOf('Build the thing') > dynamicStart);
    assert.ok(prompt.indexOf('agent-test') > dynamicStart);
  });

  it('includes concise response instructions in restart prompts', () => {
    const prompt = renderWorkerRestartPrompt('Fix the failing validation.');

    assert.ok(prompt.includes(WORKER_CONCISION_PROMPT));
    assert.ok(prompt.includes('Fix the failing validation.'));
  });

  it('appends restart instructions to a full worker contract when provided', () => {
    const contractPrompt = [
      '# Worker Agent Prompt Template',
      '## Response Style',
      WORKER_CONCISION_PROMPT,
      '## Your Constraints',
      'ALLOWED PATHS: src/**',
      '### Request Format',
    ].join('\n');

    const prompt = renderWorkerRestartPrompt('Fix the failing validation.', contractPrompt);

    assert.ok(prompt.startsWith(contractPrompt));
    assert.ok(prompt.includes('### Request Format'));
    assert.ok(prompt.endsWith('## Restart Instruction\nFix the failing validation.'));
  });
});

describe('orchestrator arbitration prompt rendering', () => {
  it('places stable arbitration instructions before dynamic request data', () => {
    const prompt = buildOrchestratorPrompt(
      [{ request_id: 'req-1', agent: 'agent-a', content: 'Finish me.' }],
      { project: 'Dynamic project' },
      'Durable dynamic decision',
      [{ request_id: 'old-1', decision: 'Existing dynamic decision' }],
      { 'agent-a': 'Dynamic worktree state' },
      'Caller nuance from the starter session',
    );

    const dynamicStart = prompt.indexOf('## Dynamic Inputs');
    assert.ok(prompt.indexOf('## Responsibilities') < prompt.indexOf('## Response Format'));
    assert.ok(prompt.indexOf('## Response Format') < dynamicStart);
    assert.strictEqual(prompt.slice(0, dynamicStart).includes('Dynamic project'), false);
    assert.strictEqual(prompt.slice(0, dynamicStart).includes('req-1'), false);
    assert.ok(prompt.indexOf('## New Requests from Agents') < prompt.indexOf('## Your Responsibilities'));
    assert.ok(prompt.indexOf('req-1') > dynamicStart);
    assert.ok(prompt.indexOf('## Caller Session Context from coord/CALLER_CONTEXT.md') > dynamicStart);
    assert.ok(prompt.indexOf('Caller nuance from the starter session') > dynamicStart);
  });
});

describe('plan reviewer prompt rendering', () => {
  it('places stable review rules before reviewer-specific data', () => {
    const prompt = renderReviewerPrompt({
      reviewer: {
        name: 'architecture',
        review_focus: 'api-surface-review',
      },
      config: {
        max_plan_review_iterations: 'auto',
      },
      iteration: 1,
      draftPlan: { project: 'Dynamic review project', tasks: { worker: { description: 'do it' } } },
      draftPlanPath: '/tmp/draft.json',
      draftPlanAuditPath: '/tmp/audit.json',
      previousReconciliation: null,
      previousReconciliationPath: null,
    });

    const dynamicStart = prompt.indexOf('## Dynamic Review Constants');
    assert.ok(prompt.indexOf('Rules:') < dynamicStart);
    assert.ok(prompt.indexOf('Required JSON fields:') < dynamicStart);
    assert.strictEqual(prompt.slice(0, dynamicStart).includes('architecture'), false);
    assert.strictEqual(prompt.slice(0, dynamicStart).includes('api-surface-review'), false);
    assert.ok(prompt.indexOf('Reviewer name: architecture') > dynamicStart);
    assert.ok(prompt.indexOf('Latest draft plan JSON:') > dynamicStart);
  });
});
