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

  it('reports external-config CLIs without pretending the exact model is visible', () => {
    const summary = summarizeCliModel('kilo', 'kilo run "$(cat {prompt_file})" --auto');

    assert.strictEqual(summary.known, false);
    assert.strictEqual(summary.model, null);
    assert.match(summary.message, /own config\/provider/);
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
    assert.match(output, /kilo: model selected by kilo's own config\/provider/);
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
});
