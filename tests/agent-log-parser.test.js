'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseAgentState } = require('../scripts/lib/agent-log-parser');

describe('agent log parser', () => {
  it('keeps legacy text log summaries working', () => {
    assert.strictEqual(parseAgentState([
      'Starting work',
      'Tool Use: read_file README.md',
      'Editing file: src/app.js',
    ]), 'Editing: src/app.js');
  });

  it('summarizes Claude stream-json tool use events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } },
        ],
      },
    });

    assert.strictEqual(parseAgentState([line]), 'Reading: src/app.js');
  });

  it('summarizes Gemini-style stream-json tool calls', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      name: 'write_file',
      args: { absolute_path: 'src/app.js' },
    });

    assert.strictEqual(parseAgentState([line]), 'Editing: src/app.js');
  });

  it('summarizes Codex-style function call events', () => {
    const line = JSON.stringify({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'npm test -- --runInBand' }),
      },
    });

    assert.strictEqual(parseAgentState([line]), 'Running: npm test -- --runInBand...');
  });

  it('falls back to assistant text embedded in JSON events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running command: npm run build' },
        ],
      },
    });

    assert.strictEqual(parseAgentState([line]), 'Running: npm run build...');
  });
});
