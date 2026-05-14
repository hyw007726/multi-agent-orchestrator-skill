# TODO

Each item is tagged with a complexity rating:

- **[C1]** - small surgical change, single file, clear logic, low risk.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

## Lower Model Live Testing

- **[C1] Stage 1 - Live test harness (implemented)**
  - Add an opt-in live test runner or documented command path that is excluded from `node scripts/run-tests.js`.
  - Gate live tests behind `RUN_LIVE_MODEL_TESTS=1`.
  - Add shared helpers for temp project setup, live provider config generation, long timeouts, process cleanup, and artifact collection.
  - Document that these tests require authenticated CLIs, may use paid model calls, and may be flaky due to provider/network behavior.

- **[C2] Stage 2 - Provider-specific configuration (implemented)**
  - Add provider-specific live test config builders for Codex/OpenAI, Claude, and Gemini.
  - Support separate lower-model aliases for worker, arbitrator, and reviewer roles.
  - Make model IDs configurable through env vars, with recommended defaults:
    - Codex/OpenAI: `gpt-5.1-codex-mini` or `gpt-5-mini`
    - Claude: `claude-sonnet-4-6`
    - Gemini: `gemini-2.5-flash`
  - Skip each provider test with a clear message when the required CLI/model config is unavailable.

- **[C2] Stage 3 - Live reviewer smoke tests (implemented)**
  - Add one live reviewer smoke test per provider.
  - Feed the reviewer a tiny draft plan and assert it returns valid reviewer JSON.
  - Assert required fields are present: `summary`, `execution_mode_issues`, `blockers`, `overlaps`, `validation_gaps`, and `suggested_changes`.
  - Keep this isolated from worker launch so reviewer failures are easy to diagnose.

- **[C2] Stage 4 - Live arbitrator smoke tests (implemented)**
  - Add one live arbitrator smoke test per provider.
  - Use a fake worker or seeded request to submit a deterministic `question` request.
  - Assert the lower-model arbitrator returns valid arbitration JSON with every request explicitly approved or rejected.
  - Assert `requests.jsonl`, `decisions.json`, and `decisions.jsonl` are updated correctly.

- **[C2] Stage 5 - Live worker smoke tests (implemented)**
  - Add one live worker smoke test per provider.
  - Use a real lower-model worker with a fake/local arbitrator.
  - Give the worker a simple task: create `live-worker-output.txt` containing exactly `live worker smoke ok`, then submit a `review_request`.
  - Assert the worker launches, writes the expected file in its worktree, validation passes, and the agent reaches `completed`.

- **[C3] Stage 6 - All-live role tests**
  - Add one all-live smoke test per provider using lower models for reviewer, arbitrator, and worker.
  - Force a real worker question before the simple task:
    - Worker must submit `agent-live-req-output-text` asking approval for the exact output text.
    - Worker must wait for `decisions.json` or `decisions.jsonl` before writing the file.
    - Arbitrator must approve or reject the request through the normal arbitration path.
    - Worker must continue after approval, write `live-worker-output.txt`, and submit a final `review_request`.
  - Assert the full protocol: reviewer JSON, worker request staging, arbitration, decision persistence, worker continuation, final review request, validation, and completion.

- **[C2] Stage 7 - Documentation and CI posture**
  - Add README documentation for live test setup, env vars, provider-specific commands, cost warnings, and expected failure modes.
  - Keep live tests out of default CI unless explicitly enabled.
  - Consider a separate CI/manual workflow that can run one provider at a time with secrets configured.
