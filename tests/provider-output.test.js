'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractJsonObject,
  extractTextFromJsonStream,
} = require('../scripts/lib/provider-output');

describe('provider output parsing', () => {
  it('extracts JSON objects from normal text and fenced responses', () => {
    assert.deepStrictEqual(extractJsonObject('prefix {"ok": true} suffix'), { ok: true });
    assert.deepStrictEqual(extractJsonObject('```json\n{"ok": true}\n```'), { ok: true });
  });

  it('extracts assistant text from Claude-style stream JSON', () => {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ approved: [{ request_id: 'req-1' }], rejected: [], actions: [] }),
            },
          ],
        },
      }),
    ].join('\n');

    assert.deepStrictEqual(extractJsonObject(raw), {
      approved: [{ request_id: 'req-1' }],
      rejected: [],
      actions: [],
    });
  });

  it('extracts fenced JSON from content-oriented stream events', () => {
    const raw = JSON.stringify({
      type: 'content',
      content: '```json\n{"iteration":1,"reviewer":"architecture","summary":"ok"}\n```',
    });

    assert.deepStrictEqual(extractJsonObject(raw), {
      iteration: 1,
      reviewer: 'architecture',
      summary: 'ok',
    });
  });

  it('does not treat tool result payloads as assistant output', () => {
    const raw = [
      JSON.stringify({ type: 'tool_result', content: '{"wrong":true}' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: '{"right":true}' }),
    ].join('\n');

    assert.deepStrictEqual(extractJsonObject(raw), { right: true });
    assert.strictEqual(extractTextFromJsonStream(raw), '{"right":true}');
  });
});
