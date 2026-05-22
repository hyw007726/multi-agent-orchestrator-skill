'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  repoRoot,
  createTempProject,
  bootstrapProject,
  readJsonl,
} = require('./helpers/temp-project');

const { consolidateStagedRequests } = require(path.join(repoRoot(), 'scripts', 'lib', 'staged-requests.js'));
const { getPaths } = require(path.join(repoRoot(), 'scripts', 'lib', 'paths.js'));

describe('staged request quarantine', () => {
  it('quarantines a malformed staged request while still consolidating the valid ones', () => {
    let project;
    try {
      project = createTempProject('staged-quarantine-');
      bootstrapProject(project.root, 'Quarantine test project');

      const coordDir = path.join(project.root, 'coord');
      const paths = getPaths(coordDir);
      const requestsDir = paths.requestsDir;
      fs.mkdirSync(requestsDir, { recursive: true });

      const validRequest = (id) => ({
        request_id: id,
        agent: 'agent-one',
        type: 'question',
        priority: 'medium',
        status: 'pending',
        content: `content for ${id}`,
        created_at: new Date().toISOString(),
      });

      fs.writeFileSync(
        path.join(requestsDir, 'agent-one-a.json'),
        JSON.stringify(validRequest('req-a')),
      );
      fs.writeFileSync(
        path.join(requestsDir, 'agent-one-b.json'),
        JSON.stringify(validRequest('req-b')),
      );
      // Picked up (ends in .json) but unparseable.
      fs.writeFileSync(path.join(requestsDir, 'agent-one-bad.json'), '{notJson');

      consolidateStagedRequests(paths);

      // Valid ones consolidated into requests.jsonl and removed from staging.
      const consolidated = readJsonl(paths.requests);
      const ids = consolidated.map((r) => r.request_id).sort();
      assert.deepStrictEqual(ids, ['req-a', 'req-b']);
      assert.ok(!fs.existsSync(path.join(requestsDir, 'agent-one-a.json')));
      assert.ok(!fs.existsSync(path.join(requestsDir, 'agent-one-b.json')));

      // Malformed one moved to malformed/ with a sibling .error.txt.
      const malformedDir = path.join(requestsDir, 'malformed');
      assert.ok(fs.existsSync(path.join(malformedDir, 'agent-one-bad.json')));
      const errorText = fs.readFileSync(
        path.join(malformedDir, 'agent-one-bad.json.error.txt'),
        'utf-8',
      );
      assert.match(errorText, /Invalid JSON/);
      assert.ok(!fs.existsSync(path.join(requestsDir, 'agent-one-bad.json')));
    } finally {
      if (project) project.cleanup();
    }
  });

  it('survives a crash-replay: same request_id staged twice across consolidate passes is appended exactly once', () => {
    let project;
    try {
      project = createTempProject('staged-replay-');
      bootstrapProject(project.root, 'Crash-replay test project');

      const coordDir = path.join(project.root, 'coord');
      const paths = getPaths(coordDir);
      const requestsDir = paths.requestsDir;
      fs.mkdirSync(requestsDir, { recursive: true });

      const requestId = 'req-replay-1';
      const stagedFile = path.join(requestsDir, 'agent-one-replay.json');
      const requestContent = {
        request_id: requestId,
        agent: 'agent-one',
        type: 'question',
        priority: 'medium',
        status: 'pending',
        content: 'staged once, ingested once',
        created_at: new Date().toISOString(),
      };

      // First consolidate: appends to requests.jsonl and unlinks the staged file.
      fs.writeFileSync(stagedFile, JSON.stringify(requestContent));
      consolidateStagedRequests(paths);
      const first = readJsonl(paths.requests);
      assert.strictEqual(first.length, 1, 'first pass appends the request');
      assert.strictEqual(first[0].request_id, requestId);
      assert.ok(!fs.existsSync(stagedFile), 'staged file unlinked on success');

      // Crash-replay simulation: a process restart that missed the unlink leaves
      // the staged .json on disk while requests.jsonl already contains the row.
      fs.writeFileSync(stagedFile, JSON.stringify(requestContent));
      consolidateStagedRequests(paths);

      const after = readJsonl(paths.requests);
      const matchingIds = after.filter((r) => r.request_id === requestId);
      assert.strictEqual(matchingIds.length, 1, 'request_id appears exactly once across crash-replay');
      // The replayed staged file is still consumed (unlinked) so the loop
      // doesn't re-process it on the next cycle either.
      assert.ok(!fs.existsSync(stagedFile), 'replayed staged file unlinked');
    } finally {
      if (project) project.cleanup();
    }
  });
});
