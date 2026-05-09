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

  // Optional: the CLI used by the background loop itself for request arbitration.
  // If omitted, arbitration uses default_cli. Set this only when arbitration should
  // use a different CLI/model from the workers.
  // orchestrator_cli: "claude",

  // Optional Phase 1.5 plan reviewers. When configured, the caller can run
  // scripts/review-plan.js after drafting an initial decomposition and before
  // writing the final coord/context.json task map. Reviewers are read-only plan
  // critics: they do not spawn worker agents, create worktrees, or edit repo files.
  // Every reviewer CLI must also have matching cli_templates.<cli> and
  // cli_health_checks.<cli> entries.
  // reviewers: [
  //   {
  //     name: "architecture",
  //     cli: "claude",
  //     model: "claude-sonnet-4-6", // optional; appends --model <id> by default
  //     // model_flag: "--model",    // optional if the CLI uses a different flag
  //     // template_args: ["--some-cli-specific-flag"],
  //     review_focus: "ownership boundaries, shared foundation work, and sequencing risks",
  //   },
  // ],
  // max_plan_review_iterations: "auto", // or a positive integer

  // Command templates for supported CLIs.
  // Use {prompt_file} as a placeholder for the generated prompt text file.
  // By centralizing these here you can adapt if a tool changes its CLI flags, and
  // the same template is reused for the worker spawn, the orchestrator-CLI call,
  // and the AI-Review course-correction call.
  //
  // Prefer structured argv templates when the CLI accepts a prompt file or prompt
  // argument. They run with shell:false, so prompt paths and extra args are not
  // shell-expanded:
  //   aider: { cmd: "aider", args: ["--message-file", { prompt_file: true }, "--yes"] }
  //   codex: { cmd: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox", { prompt_text: true }] }
  //
  // Keep string templates only when you intentionally need shell behavior. String
  // templates still work as the shell escape hatch and are logged as shell mode.
  //
  // Model selection — two patterns depending on the CLI:
  //   (a) Inline flag CLIs (claude, aider, gemini): add the CLI's --model flag
  //       inside the template args/string. Examples:
  //         claude: { cmd: "claude", args: ["-p", { prompt_text: true }, "--dangerously-skip-permissions", "--model", "claude-haiku-4-5-20251001"] }
  //         aider:  { cmd: "aider", args: ["--message-file", { prompt_file: true }, "--yes", "--model", "gpt-4o-mini"] }
  //         gemini: { cmd: "gemini", args: ["--prompt", { prompt_text: true }, "--yolo", "--model", "gemini-2.0-flash"] }
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
    aider: { cmd: "aider", args: ["--message-file", { prompt_file: true }, "--yes"] },
    // claude is the one CLI that should usually have --model pinned in this template. The other CLIs
    // (kilo / aider / gemini / codex / opencode) read their model from their own
    // independent config — env vars, BYOK providers, model files — so spawning them
    // as workers picks up the user's existing setup. The `claude` CLI is different:
    // without --model, the spawned worker silently inherits the model of the parent
    // parent Claude Code session when this runtime is launched from Claude Code —
    // typically your interactive orchestrator session's model, which is far too
    // expensive for bulk worker coding.
    // Pinning Sonnet 4.6 keeps workers on a fast, cheap, capable model regardless
    // of what your interactive orchestrator session is using. Swap the id for a
    // different one (claude-haiku-4-5-20251001 to go even cheaper, or claude-opus-4-7
    // if you want this template to be used as an explicit `orchestrator_cli`).
    claude: { cmd: "claude", args: ["-p", { prompt_text: true }, "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6"] },
    gemini: { cmd: "gemini", args: ["--prompt", { prompt_text: true }, "--yolo"] },
    codex: { cmd: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox", { prompt_text: true }] },
    opencode: { cmd: "opencode", args: ["run", { prompt_text: true }, "--yes"] },
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

  // Base branch for computing agent diffs. Detected automatically from the main
  // worktree at launch time; set this to override it (e.g. "master", "develop").
  // base_branch: "main",

  // Consecutive orchestrator-CLI failures (per cycle) before writing
  // coord/orchestrator-stalled.flag, which the dashboard surfaces as a red banner.
  // `claude_failure_threshold` is still accepted as a deprecated alias.
  // orchestrator_failure_threshold: 5,

  // Adaptive polling bounds. The loop polls fast right after seeing pending
  // requests, then exponentially backs off (×1.5 per idle cycle) up to poll_max_ms.
  // Pass `--poll-interval <ms>` to the loop to disable the heuristic and force a
  // fixed cadence.
  // poll_min_ms: 1000,
  // poll_max_ms: 15000,

  // Dashboard auto-launch defaults to "auto": open a new Terminal window on local
  // macOS, skip auto-launch in CI/SSH/non-macOS, and always print the manual command.
  // Set false to disable or true to force an attempt.
  // launch_dashboard: "auto",
  // Review summary terminal remains opt-in.
  // launch_review_terminal: true,
};
