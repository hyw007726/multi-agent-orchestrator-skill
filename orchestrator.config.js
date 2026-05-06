// Multi-Agent Orchestrator Configuration
// --------------------------------------
// Uncomment and set these values to override the Orchestrator's dynamic defaults.

module.exports = {
  // The background CLI worker that executes coding tasks inside each agent worktree.
  // Recommended default combination: kilo + DeepSeek V4 Pro (1M context, cheap, fast).
  // Model selection for kilo happens inside Kilo's BYOK provider settings (UI / one-time
  // setup), NOT via a CLI flag — so the kilo template below stays simple and the model
  // id `deepseek-v4-pro` is selected in Kilo's model picker. After setup, run:
  //   node scripts/preflight.js
  // to confirm the API key + provider + model chain is wired up (a bare --version check
  // only proves the binary is installed; it does not exercise the API).
  default_cli: "kilo",

  // The CLI used by the background loop itself for request arbitration (Phase 5).
  // This is separate from the worker CLI: arbitration benefits from a stronger
  // reasoning model, while the worker CLI can stay cheap and fast. Defaults to "claude".
  // orchestrator_cli: "claude",

  // Command templates for supported CLIs.
  // Use {prompt_file} as a placeholder for the generated prompt text file.
  // By centralizing these here you can adapt if a tool changes its CLI flags, and
  // the same template is reused for the worker spawn, the orchestrator-CLI call,
  // and the AI-Review course-correction call.
  //
  // Model selection — two patterns depending on the CLI:
  //   (a) Inline flag CLIs (claude, aider, gemini): the template is executed
  //       verbatim, so add the CLI's --model flag inline. Examples:
  //         claude:  'claude -p "$(cat {prompt_file})" --dangerously-skip-permissions --model claude-haiku-4-5-20251001'
  //         aider:   'aider --message-file {prompt_file} --yes --model gpt-4o-mini'
  //         gemini:  'gemini --prompt "$(cat {prompt_file})" --yolo --model gemini-2.0-flash'
  //   (b) External-config CLIs (kilo, opencode, codex): model selection lives in
  //       the CLI's own settings (BYOK provider + model picker), not in the
  //       template. Leave the template simple — e.g. for the recommended kilo +
  //       DeepSeek V4 Pro combo, pick `deepseek-v4-pro` in Kilo's model selector
  //       and the existing template will use it.
  // Common pattern: keep the WORKER (`default_cli`) on a cheap fast model and
  // use a stronger model for `orchestrator_cli`, since arbitration weighs
  // cross-cutting decisions while workers do narrower coding.
  cli_templates: {
    // kilo's documented headless form is `kilo run "<message>" --auto`. The CLI accepts
    // the prompt only as a positional argument — there is no --message-file flag and no
    // stdin input — so the prompt rides through the shell argv and is bounded by ARG_MAX
    // (~1MB on macOS, typically 128KB–2MB on Linux). Plenty for normal task descriptions,
    // but if you encounter "Argument list too long", split the task into smaller boundaries
    // rather than trying to fit a single mega-prompt through the shell.
    kilo: 'kilo run "$(cat {prompt_file})" --auto',
    aider: "aider --message-file {prompt_file} --yes",
    // claude is the one CLI that NEEDS --model pinned in this template. The other CLIs
    // (kilo / aider / gemini / codex / opencode) read their model from their own
    // independent config — env vars, BYOK providers, model files — so spawning them
    // as workers picks up the user's existing setup. The `claude` CLI is different:
    // without --model, the spawned worker silently inherits the model of the parent
    // Claude Code session running this skill — typically Opus 4.7 (your orchestrator
    // session's model), which is far too expensive for bulk worker coding.
    // Pinning Sonnet 4.6 keeps workers on a fast, cheap, capable model regardless
    // of what your interactive orchestrator session is using. Swap the id for a
    // different one (claude-haiku-4-5-20251001 to go even cheaper, or claude-opus-4-7
    // if you want this template to double as `orchestrator_cli`).
    claude: 'claude -p "$(cat {prompt_file})" --dangerously-skip-permissions --model claude-sonnet-4-6',
    gemini: 'gemini --prompt "$(cat {prompt_file})" --yolo',
    codex: 'codex --exec "$(cat {prompt_file})"',
    opencode: 'opencode run "$(cat {prompt_file})" --yes',
  },

  // Health-check probes used by scripts/preflight.js to fail fast when a CLI
  // isn't installed or is hanging on an interactive prompt. Defaults to
  // `<cli> --version` for every supported CLI; override here if a tool prefers
  // a different lightweight diagnostic command.
  // cli_health_checks: {
  //   kilo: "kilo --version",
  //   aider: "aider --version",
  // },

  // How many minutes of NO logs before the agent is killed.
  // default_timeout_mins: 10,

  // How many minutes of NO code changes before triggering AI review.
  // default_progress_timeout_mins: 15,

  // Maximum times the loop will respawn the same agent before marking it errored.
  // Restarts are counted across both validation-failure restarts and AI-Review restarts.
  // default_max_restarts: 3,

  // Consecutive orchestrator-CLI failures (per cycle) before writing
  // coord/orchestrator-stalled.flag, which the dashboard surfaces as a red banner.
  // claude_failure_threshold: 5,

  // Adaptive polling bounds. The loop polls fast right after seeing pending
  // requests, then exponentially backs off (×1.5 per idle cycle) up to poll_max_ms.
  // Pass `--poll-interval <ms>` to the loop to disable the heuristic and force a
  // fixed cadence.
  // poll_min_ms: 1000,
  // poll_max_ms: 15000,

  // Terminal auto-launch is disabled by default in built-in config so the MVP works
  // in headless/sandboxed terminals. Set these to true if your local macOS/Linux
  // terminal environment allows GUI terminal spawning.
  // launch_dashboard: true,
  // launch_review_terminal: true,
};
