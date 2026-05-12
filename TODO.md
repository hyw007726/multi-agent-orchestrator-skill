# TODO

Each item is tagged with a complexity rating:

- **[C1]** - small surgical change, single file, clear logic, low risk.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

Review the local/default configuration strategy (claude)

Lower model role play testing

## Worker Model Selection and Fallbacks

- **[C2] Add conditional worker-model selection prompt**
  - If no `orchestrator.config.js` exists, prompt the user before launch with a default recommendation: use a secondary-tier model from the caller's provider family for worker agents.
  - If preflight fails because the configured worker CLI/model is unavailable, prompt the user to switch to a secondary-tier same-provider worker model or edit config manually.
  - Make the prompt explicit about what will be used, which config field will be written, and that workers run autonomously.
  - Persist the accepted choice into local `orchestrator.config.js`; do not keep an invisible in-memory model choice.
  - Rerun preflight after writing the choice and only proceed if it passes.
  - Skip the prompt when the user already has an explicit working `default_cli` / `cli_templates` setup.

- **[C2] Define provider-family secondary-tier recommendations**
  - Maintain a small provider-family mapping for recommendations, refreshed in docs over time: OpenAI/Codex, Anthropic/Claude, and Gemini.
  - Prefer secondary-tier coding-capable models over the absolute cheapest models.
  - Keep the mapping advisory; users can override it in config.
  - If the caller/provider cannot be inferred, fall back to asking the user to choose or edit config rather than guessing.

- **[C2] Add provider-aware preflight fallback guidance**
  - When preflight auth/model checks fail for configured worker or reviewer CLIs, print targeted guidance instead of silently changing models.
  - Detect provider family from the CLI name and/or pinned model id when possible (`openai`, `anthropic`/`claude`, `gemini`).
  - Suggest a faster or more cost-efficient model from the same provider family only as a user action, not as an automatic runtime mutation.
  - Keep suggestions conservative: prefer balanced coding models before the cheapest tier.
  - Include the exact config location to edit, such as `cli_templates.<cli>` for inline-flag CLIs or the external CLI's own model picker/provider settings for CLIs like `kilo`, `codex`, and `opencode`.
  - If provider cannot be inferred, print generic guidance to pick a configured, non-interactive, cost-efficient worker model and rerun preflight.

- **[C2] Document local config override as the source of truth**
  - Explain that built-in defaults avoid surprise, while project-local `orchestrator.config.js` should control worker CLI/model choices.
  - Document example overrides for OpenAI/Codex, Claude, and Gemini workers.
  - Warn that automatic "use the caller's lower model" inference is unreliable unless the caller writes the resolved choice into config.
  - Consider a future user-level config path such as `~/.opencabinet/config.js`, with project config taking precedence.
