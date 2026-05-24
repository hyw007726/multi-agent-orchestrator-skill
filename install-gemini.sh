#!/usr/bin/env sh
set -eu

GEMINI_HOME="${GEMINI_HOME:-$HOME/.gemini}"
DEST="${DEST:-$GEMINI_HOME/extensions/multi-agent-orchestrator}"

. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/install-common.sh"

install_or_update_skill "$DEST" "multi-agent-orchestrator (Gemini extension)"
verify_skill_install "$DEST"

if command -v gemini >/dev/null 2>&1; then
  printf '%s\n' "Registering extension with Gemini CLI..."
  gemini extensions install "$DEST"
else
  printf '%s\n' "Gemini CLI not found on PATH; extension files are at $DEST"
  printf '%s\n' "After installing Gemini CLI, run: gemini extensions install $DEST"
fi

printf '\n%s\n' "Installed at $DEST"
printf '%s\n' "Canonical SKILL.md is loaded via GEMINI.md (not a bundled snapshot)."
printf '%s\n' "Tip: from a local checkout, run SOURCE_DIR=/path/to/this/repo ./install-gemini.sh"
