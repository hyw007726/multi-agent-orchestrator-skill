'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractModelFromTemplate,
  formatModelHeadsUp,
  summarizeCliModel,
} = require('../scripts/lib/model-headsup');

describe('model heads-up', () => {
  it('extracts pinned models from argv templates', () => {
    const summary = summarizeCliModel('claude', {
      cmd: 'claude',
      args: ['-p', { prompt_text: true }, '--model', 'claude-sonnet-4-6'],
    });

    assert.strictEqual(summary.known, true);
    assert.strictEqual(summary.model, 'claude-sonnet-4-6');
    assert.match(summary.message, /claude-sonnet-4-6/);
  });

  it('extracts pinned models from shell templates', () => {
    const extracted = extractModelFromTemplate('aider --message-file {prompt_file} --model "gpt-4o-mini" --yes');

    assert.deepStrictEqual(extracted, {
      flag: '--model',
      model: 'gpt-4o-mini',
    });
  });

  it('reports unpinned CLIs without pretending the exact model is visible', () => {
    const summary = summarizeCliModel('kilo', 'kilo run "$(cat {prompt_file})" --auto');

    assert.strictEqual(summary.known, false);
    assert.strictEqual(summary.model, null);
    assert.match(summary.message, /CLI config\/default/);
  });

  it('formats worker and orchestrator model assumptions', () => {
    const config = {
      default_cli: 'kilo',
      orchestrator_cli: 'claude',
      cli_templates: {
        kilo: 'kilo run "$(cat {prompt_file})" --auto',
        aider: { cmd: 'aider', args: ['--message-file', { prompt_file: true }, '--yes', '--model=gpt-4o-mini'] },
        claude: { cmd: 'claude', args: ['-p', { prompt_text: true }, '--model', 'claude-sonnet-4-6'] },
      },
    };

    const output = formatModelHeadsUp(config, { workerClis: ['kilo', 'aider'] });

    assert.match(output, /Model heads-up:/);
    assert.match(output, /kilo: model selected by kilo's CLI config\/default/);
    assert.match(output, /aider: model gpt-4o-mini/);
    assert.match(output, /claude: model claude-sonnet-4-6/);
  });

  it('formats configured plan reviewer model and template overrides', () => {
    const config = {
      default_cli: 'kilo',
      orchestrator_cli: 'kilo',
      reviewers: [
        {
          name: 'architecture',
          cli: 'claude',
          model: 'claude-opus-4-7',
          model_flag: '--model',
          template_args: ['--json'],
          review_focus: 'shared foundations',
        },
      ],
      cli_templates: {
        kilo: 'kilo run "$(cat {prompt_file})" --auto',
        claude: { cmd: 'claude', args: ['-p', { prompt_text: true }, '--model', 'claude-sonnet-4-6'] },
      },
    };

    const output = formatModelHeadsUp(config, { checkedClis: ['kilo', 'claude'] });

    assert.match(output, /Plan reviewer CLI\(s\):/);
    assert.match(output, /architecture \(claude\): model claude-sonnet-4-6/);
    assert.match(output, /reviewer override claude-opus-4-7 via --model/);
    assert.match(output, /template args --json/);
    assert.match(output, /shared foundations/);
    assert.doesNotMatch(output, /Additional checked CLI/);
  });

  it('shows recommendations for unpinned provider aliases', () => {
    const config = {
      default_cli: 'codex-fast-worker',
      orchestrator_cli: 'gemini-fast-worker',
      cli_templates: {
        'codex-fast-worker': { cmd: 'codex', args: ['exec', { prompt_text: true }] },
        'gemini-fast-worker': { cmd: 'gemini', args: ['--prompt', { prompt_text: true }, '--yolo'] },
      },
    };

    const output = formatModelHeadsUp(config, {
      workerClis: ['codex-fast-worker'],
      orchestratorCli: 'gemini-fast-worker',
    });

    assert.match(output, /codex-fast-worker: model selected by codex-fast-worker's CLI config\/default/);
    assert.match(output, /Recommended worker tier: gpt-5\.4-mini/);
    assert.match(output, /Pin gpt-5\.4-mini by adding or replacing the CLI model flag in cli_templates\.codex-fast-worker/);
    assert.match(output, /gemini-fast-worker:/);
    assert.match(output, /Recommended worker tier: gemini-2\.5-flash/);
  });
});
