#!/usr/bin/env sh
set -eu

REPO_URL="${REPO_URL:-https://github.com/hyw007726/claud-multi-agent-orchestrator-skill.git}"
REF="${REF:-main}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
DEST="${DEST:-$CODEX_HOME/skills/multi-agent-orchestrator}"

if ! command -v git >/dev/null 2>&1; then
  printf '%s\n' "Error: git is required to install multi-agent-orchestrator." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"

if [ -d "$DEST/.git" ]; then
  printf '%s\n' "Updating multi-agent-orchestrator at $DEST"
  git -C "$DEST" pull --ff-only
elif [ -e "$DEST" ]; then
  if [ -f "$DEST/SKILL.md" ]; then
    printf '%s\n' "multi-agent-orchestrator is already installed at $DEST"
  else
    printf '%s\n' "Error: $DEST already exists and does not look like this skill." >&2
    printf '%s\n' "Move it aside, or set DEST=/some/other/path and run this installer again." >&2
    exit 1
  fi
else
  printf '%s\n' "Installing multi-agent-orchestrator to $DEST"
  git clone --depth=1 --branch "$REF" "$REPO_URL" "$DEST"
fi

printf '\n%s\n' "Installed. Restart Codex to pick up the skill."
