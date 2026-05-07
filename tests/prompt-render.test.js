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
      ALLOWED_PATHS_LIST: ['src/**'],
      FORBIDDEN_PATHS_LIST: ['package.json'],
    });

    assert.ok(prompt.includes('## Response Style'));
    assert.ok(prompt.includes(WORKER_CONCISION_PROMPT));
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
