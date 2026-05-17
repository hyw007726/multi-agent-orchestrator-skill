# Live Model Tests

The default test command stays hermetic:

```bash
node scripts/run-tests.js
```

Live model tests are opt-in because they call authenticated provider CLIs, may use paid model calls, and can fail due to provider, network, auth, or model behavior. They are not included in `node scripts/run-tests.js`.

Run all currently configured live tests:

```bash
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js
```

Run one provider:

```bash
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider claude
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider gemini
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider kilo
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider opencode
```

Run the mixed-provider smoke suite:

```bash
RUN_LIVE_MODEL_TESTS=1 RUN_MIXED_LIVE_TESTS=1 node scripts/run-live-tests.js --provider mixed
```

The live harness writes provider-specific aliases for worker, arbitrator, and reviewer roles. Claude, Codex, and Gemini pin the configured lower-model defaults below. Kilo and OpenCode use their own configured default model unless `LIVE_KILO_MODEL`, `LIVE_OPENCODE_MODEL`, or a role-specific model override is set.

Mixed-provider tests require the separate `RUN_MIXED_LIVE_TESTS=1` opt-in, remain outside `node scripts/run-tests.js`, and cover only named combos rather than an exhaustive provider matrix.

## Covered Flows

- `reviewer`: runs the real `review-plan.js` path and asserts valid reviewer JSON.
- `arbitrator`: stages a deterministic worker `question` request and asserts the live arbitrator resolves it through `requests.jsonl`, `decisions.json`, and `decisions.jsonl`.
- `worker`: launches a real lower-model worker through `launch-all.js`, uses a fake local arbitrator for completion approval, and asserts the worker writes `live-worker-output.txt`, submits a `review_request`, passes validation, and reaches `completed`.
- `all-live`: runs a live reviewer, then launches a live worker with a live arbitrator. The worker must submit `agent-live-req-output-text`, wait for an approved decision, write `live-worker-output.txt`, submit a final `review_request`, pass validation, and reach `completed`.
- `mixed`: runs the same protocol with role-specific provider aliases. The canonical combo is planner Claude, reviewer Codex, arbitrator Gemini, and worker Kilo. The second supported combo, selected with `LIVE_MIXED_COMBO=opencode-worker`, keeps Claude as planner, uses Gemini as reviewer, Codex as arbitrator, and OpenCode as worker.

## Default Live Models

- Claude: `claude-sonnet-4-6`
- Codex/OpenAI: `gpt-5.4-mini`
- Gemini: `gemini-2.5-flash-lite`
- Kilo: `cli-default`
- OpenCode: `cli-default`

Override them globally or per role:

```bash
LIVE_CLAUDE_MODEL=claude-sonnet-4-6 RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider claude
LIVE_ALL_LIVE_TIMEOUT_MS=1200000 RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider claude
LIVE_CODEX_MODEL=gpt-5.4-mini RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
LIVE_CODEX_WORKER_MODEL=gpt-5.4-mini RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
LIVE_CODEX_ARBITRATOR_MODEL=gpt-5.4-mini RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
LIVE_GEMINI_REVIEWER_MODEL=gemini-2.5-flash-lite RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider gemini
LIVE_KILO_MODEL=anthropic/claude-sonnet-4-6 RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider kilo
LIVE_OPENCODE_MODEL=moonshot/kimi-k2.6 RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider opencode
LIVE_MIXED_COMBO=opencode-worker RUN_LIVE_MODEL_TESTS=1 RUN_MIXED_LIVE_TESTS=1 node scripts/run-live-tests.js --provider mixed
```

Mixed provider and model overrides are role-specific. For example:

```bash
LIVE_MIXED_REVIEWER_PROVIDER=claude LIVE_MIXED_REVIEWER_MODEL=claude-sonnet-4-6 RUN_LIVE_MODEL_TESTS=1 RUN_MIXED_LIVE_TESTS=1 node scripts/run-live-tests.js --provider mixed
```

Set `LIVE_KEEP_ARTIFACTS=1` to preserve the temporary project and review artifacts for debugging failed live runs.

## Inspecting Runs

Every live test prints a copyable session id and inspect command:

```text
[live-harness] Session ID: live-gemini-arbitrator--DhQwch
[live-harness] Inspect: node /path/to/multi-agent-orchestrator/scripts/inspect-live-test.js /tmp/live-gemini-arbitrator--DhQwch
[live-harness] Tail: tail -F /tmp/live-gemini-arbitrator--DhQwch/coord/orchestrator.log
```

For a stuck run, inspect the latest provider workspace from another terminal:

```bash
node scripts/inspect-live-test.js --latest gemini
node scripts/inspect-live-test.js --latest gemini --id-only
```

The inspector reports the live workspace, provider, test role, recorded models, orchestrator PID, agent PIDs, pending requests, recent decisions, relevant log paths, and common stuck states such as browser-auth prompts.

## Environment Variables

- `LIVE_TEST_TIMEOUT_MS`: default timeout for each live role test.
- `LIVE_REVIEWER_TIMEOUT_MS`, `LIVE_ARBITRATOR_TIMEOUT_MS`, `LIVE_WORKER_TIMEOUT_MS`, `LIVE_ALL_LIVE_TIMEOUT_MS`: role-specific timeout overrides.
- `LIVE_<PROVIDER>_MODEL`: provider-wide model override, where provider is `CODEX`, `CLAUDE`, `GEMINI`, `KILO`, or `OPENCODE`.
- `LIVE_<PROVIDER>_<ROLE>_MODEL`: role-specific model override, where role is `WORKER`, `ARBITRATOR`, `REVIEWER`, or `PLANNER`.
- `LIVE_MIXED_COMBO`: named mixed combo. Supported values are `canonical` and `opencode-worker`.
- `LIVE_MIXED_<ROLE>_PROVIDER`: role-specific mixed provider override. Provider values are `claude`, `codex`, `gemini`, `kilo`, or `opencode`.
- `LIVE_MIXED_<ROLE>_MODEL`: role-specific mixed model override.
- `LIVE_SKIP_TRANSIENT_PROVIDER_ERRORS`: defaults to skipping live assertions when logs show rate-limit, quota, or temporary provider-capacity signals. Set to `0` to make those conditions fail the test.

## Common Expected Failures

- provider CLI is missing from `PATH`;
- provider CLI is installed but not authenticated in the current environment;
- requested model is unavailable, renamed, rate-limited, or not enabled for the account;
- provider or network calls time out;
- a lower model returns invalid reviewer or arbitration JSON;
- a live worker writes the wrong file content, skips the required request, or fails to submit its final `review_request`.

## Mixed-Provider Troubleshooting

- Kilo and OpenCode can use their configured default model, so the exact model is invisible unless you set `LIVE_KILO_MODEL`, `LIVE_OPENCODE_MODEL`, or a mixed role-specific model override.
- Gemini reviewer or arbitrator roles need the generated `coord` directory as an include directory; the live harness writes absolute include paths.
- OpenCode worker smoke tests use the local JSON-text wrapper so worker logs are under the project `coord/logs/` directory even though the underlying CLI may emit structured JSON.
- Rate limits, exhausted quota, `429`, and temporary provider-capacity errors are treated as skippable transient provider conditions by default. Inspect the preserved workspace with `node scripts/inspect-live-test.js <workspace>` and rerun with `LIVE_SKIP_TRANSIENT_PROVIDER_ERRORS=0` when you need a hard failure.

## GitHub Actions

The repository includes a manual GitHub Actions workflow at `.github/workflows/live-model-tests.yml` that can run one provider at a time through `workflow_dispatch`. The workflow sets `RUN_LIVE_MODEL_TESTS=1`, accepts `claude`, `codex`, `gemini`, `kilo`, `opencode`, or `mixed` as an input, sets `RUN_MIXED_LIVE_TESTS=1` only for the manual `mixed` provider selection, and uploads preserved `/tmp/live-*` projects when artifact collection is enabled.

The workflow does not install or log in to provider CLIs because those setup steps are account-specific. Use a self-hosted runner with the CLIs already authenticated, or add provider-specific install/auth steps and configure the needed secrets such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`.
