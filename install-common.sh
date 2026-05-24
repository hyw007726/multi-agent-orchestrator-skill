#!/usr/bin/env sh
# Shared install/sync logic for Codex and Gemini extension installs.
# Sourced by install-codex.sh and install-gemini.sh — do not execute directly.

REPO_URL="${REPO_URL:-https://github.com/hyw007726/multi-agent-orchestrator-skill.git}"
REF="${REF:-main}"

# When set, copy the full skill tree from a local checkout instead of cloning.
# Example: SOURCE_DIR=/path/to/multi-agent-orchestrator ./install-codex.sh
SOURCE_DIR="${SOURCE_DIR:-}"

sync_from_source() {
  src="$1"
  dest="$2"
  if [ ! -f "$src/SKILL.md" ]; then
    printf '%s\n' "Error: $src does not look like the multi-agent-orchestrator repo (missing SKILL.md)." >&2
    return 1
  fi
  mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git/' \
      --exclude 'node_modules/' \
      --exclude '.agents/' \
      --exclude '.kilocode/' \
      --exclude 'coord/' \
      "$src/" "$dest/"
  else
    # Portable fallback when rsync is unavailable.
    rm -rf "${dest}.tmp"
    mkdir -p "${dest}.tmp"
    (cd "$src" && tar cf - \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='.agents' \
      --exclude='.kilocode' \
      --exclude='coord' \
      .) | (cd "${dest}.tmp" && tar xf -)
    rm -rf "$dest"
    mv "${dest}.tmp" "$dest"
  fi
  return 0
}

install_or_update_skill() {
  dest="$1"
  label="${2:-multi-agent-orchestrator}"

  if [ -n "$SOURCE_DIR" ]; then
    printf '%s\n' "Syncing $label from $SOURCE_DIR to $dest"
    sync_from_source "$SOURCE_DIR" "$dest"
    return $?
  fi

  if ! command -v git >/dev/null 2>&1; then
    printf '%s\n' "Error: git is required to install $label." >&2
    return 1
  fi

  mkdir -p "$(dirname "$dest")"

  if [ -d "$dest/.git" ]; then
    printf '%s\n' "Updating $label at $dest"
    git -C "$dest" fetch origin "$REF" 2>/dev/null || git -C "$dest" fetch origin
    git -C "$dest" checkout "$REF" 2>/dev/null || true
    git -C "$dest" pull --ff-only origin "$REF" 2>/dev/null || git -C "$dest" pull --ff-only
    return $?
  fi

  if [ -e "$dest" ]; then
    if [ -f "$dest/SKILL.md" ]; then
      printf '%s\n' "Upgrading legacy $label install at $dest (replacing snapshot with full repo clone)"
      legacy_backup="${dest}.legacy.$(date +%s)"
      mv "$dest" "$legacy_backup"
      printf '%s\n' "  Previous install moved to $legacy_backup"
    else
      printf '%s\n' "Error: $dest already exists and does not look like this skill." >&2
      printf '%s\n' "Move it aside, or set DEST=/some/other/path and run the installer again." >&2
      return 1
    fi
  fi

  printf '%s\n' "Installing $label to $dest"
  git clone --depth=1 --branch "$REF" "$REPO_URL" "$dest"
}

verify_skill_install() {
  dest="$1"
  if [ ! -f "$dest/SKILL.md" ]; then
    printf '%s\n' "Error: install at $dest is missing SKILL.md after sync." >&2
    return 1
  fi
  if [ ! -f "$dest/scripts/status.js" ]; then
    printf '%s\n' "Error: install at $dest is missing scripts/status.js (incomplete tree)." >&2
    return 1
  fi
  return 0
}
