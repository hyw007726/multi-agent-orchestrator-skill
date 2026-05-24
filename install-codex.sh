#!/usr/bin/env sh
set -eu

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
DEST="${DEST:-$CODEX_HOME/skills/multi-agent-orchestrator}"

. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/install-common.sh"

install_or_update_skill "$DEST" "multi-agent-orchestrator"
verify_skill_install "$DEST"

printf '\n%s\n' "Installed at $DEST"
printf '%s\n' "Canonical SKILL.md and scripts are synced from the repository (not a bundled snapshot)."
printf '%s\n' "Restart Codex to pick up the skill."
printf '%s\n' "Tip: from a local checkout, run SOURCE_DIR=/path/to/this/repo ./install-codex.sh"
