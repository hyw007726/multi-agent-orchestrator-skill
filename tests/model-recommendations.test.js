'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatConfigTarget,
  formatNoConfigModelPrompt,
  formatPreflightFailureGuidance,
  inferProviderFamily,
  recommendationForCli,
} = require('../scripts/lib/model-recommendations');

describe('model recommendations', () => {
  it('infers provider families from CLI aliases, commands, and model ids', () => {
    assert.strictEqual(inferProviderFamily({ cli: 'claude-fast-worker' }), 'anthropic');
    assert.strictEqual(inferProviderFamily({
      cli: 'worker-fast',
      template: { cmd: 'gemini', args: ['--prompt', { prompt_text: true }] },
    }), 'google');
    assert.strictEqual(inferProviderFamily({
      cli: 'worker-fast',
      model: 'gpt-5.4-mini',
    }), 'openai');
    assert.strictEqual(inferProviderFamily({ cli: 'custom' }), null);
  });

  it('recommends provider-family second-tier worker models', () => {
    assert.strictEqual(recommendationForCli('claude', null).model, 'claude-sonnet-4-6');
    assert.strictEqual(recommendationForCli('codex', null).model, 'gpt-5.4-mini');
    assert.strictEqual(recommendationForCli('gemini', null).model, 'gemini-2.5-flash-lite');
  });

  it('formats config targets without inventing a generic default_model key', () => {
    assert.match(
      formatConfigTarget('claude-fast-worker', { cmd: 'claude', args: ['-p', { prompt_text: true }] }, recommendationForCli('claude')),
      /cli_templates\.claude-fast-worker/
    );
    assert.match(
      formatConfigTarget('codex-worker', { cmd: 'codex', args: ['exec', { prompt_text: true }] }, recommendationForCli('codex')),
      /cli_templates\.codex-worker/
    );
    assert.match(
      formatConfigTarget('kilo-worker', 'kilo run "$(cat {prompt_file})" --auto', recommendationForCli('kilo')),
      /Do not add a generic default_model key/
    );
  });

  it('prints a no-config worker model selection prompt', () => {
    const output = formatNoConfigModelPrompt({
      default_cli: 'codex',
      cli_templates: {
        codex: { cmd: 'codex', args: ['exec', { prompt_text: true }] },
      },
    });

    assert.match(output, /Worker model selection prompt/);
    assert.match(output, /orchestrator\.config\.local\.jsonc/);
    assert.match(output, /gpt-5\.4-mini/);
  });

  it('prints preflight fallback guidance as a user action', () => {
    const output = formatPreflightFailureGuidance([
      { cli: 'gemini-fast-worker', phase: 'auth', result: { ok: false, message: 'model unavailable' } },
    ], {
      cli_templates: {
        'gemini-fast-worker': { cmd: 'gemini', args: ['--prompt', { prompt_text: true }] },
      },
    });

    assert.match(output, /did not change any model or config automatically/);
    assert.match(output, /gemini-2\.5-flash/);
    assert.match(output, /Persist the accepted choice/);
  });
});
