#!/usr/bin/env bash
# scripts/new-worktree.sh <name>
#
# Create a new git worktree at .claude/worktrees/<name>/ on branch feat/<name>
# off the current main. Enforces the worktree convention documented in the
# Development workflow section of README.md.
#
# Usage:
#   bash scripts/new-worktree.sh <name>
#   bash scripts/new-worktree.sh --help
#
# Example:
#   bash scripts/new-worktree.sh my-feature
#   → creates .claude/worktrees/my-feature/ on branch feat/my-feature
#   → prints: cd .claude/worktrees/my-feature
#
# Exit codes:
#   0  Worktree created successfully
#   1  Pre-condition failed (dirty main, destination exists, etc.)
#   2  Usage error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREES_DIR="${REPO_ROOT}/.claude/worktrees"

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<'HELP'
new-worktree.sh — create a git worktree at .claude/worktrees/<name>/

USAGE
  bash scripts/new-worktree.sh <name>
  bash scripts/new-worktree.sh --help

ARGUMENTS
  <name>   Short snake_case or kebab-case identifier for the worktree.
           The worktree is created at .claude/worktrees/<name>/
           on a new branch feat/<name> off main.

PRECONDITIONS
  - Must be run from the main repo (not from inside a worktree).
  - The main repo working tree must be clean (no uncommitted changes).
  - .claude/worktrees/<name> must not already exist.
  - A branch named feat/<name> must not already exist.

AFTER CREATION
  The script prints the cd command, the branch name, and the pre-commit
  verification command to run in the new terminal.

HELP
}

# ── Argument handling ─────────────────────────────────────────────────────────
if [[ $# -eq 0 ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

NAME="$1"

# Validate name: alphanumeric, hyphens, underscores only
if ! printf '%s' "$NAME" | grep -qE '^[a-z0-9][a-z0-9_-]*$'; then
  echo "ERROR: name must be lowercase alphanumeric with hyphens/underscores, starting with a letter or digit" >&2
  echo "  Got: '${NAME}'" >&2
  exit 2
fi

BRANCH="feat/${NAME}"
DEST="${WORKTREES_DIR}/${NAME}"

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'; BOLD='\033[1m'
ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

# ── Guard: must be in main repo, not a sub-worktree ──────────────────────────
CURRENT_ROOT=$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ "$CURRENT_ROOT" != "$REPO_ROOT" ]]; then
  fail "Run new-worktree.sh from the main repo root, not from inside a worktree"
  exit 1
fi

# ── Guard: main repo must be clean ───────────────────────────────────────────
DIRTY=$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)
if [[ -n "$DIRTY" ]]; then
  fail "Main repo has uncommitted changes. Commit or stash before creating a worktree."
  printf "  Dirty files:\n" >&2
  printf '%s\n' "$DIRTY" | head -10 | sed 's/^/    /' >&2
  exit 1
fi

# ── Guard: destination must not exist ────────────────────────────────────────
if [[ -e "$DEST" ]]; then
  fail "Worktree destination already exists: ${DEST}"
  printf "  Use a different name, or remove the existing worktree first:\n" >&2
  printf "    git worktree remove %s\n" "$DEST" >&2
  exit 1
fi

# ── Guard: branch must not already exist ─────────────────────────────────────
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${BRANCH}" 2>/dev/null; then
  fail "Branch '${BRANCH}' already exists locally."
  printf "  Choose a different name, or delete the branch:\n" >&2
  printf "    git branch -d %s\n" "$BRANCH" >&2
  exit 1
fi

# ── Create .claude/worktrees/ if it doesn't exist ────────────────────────────
if [[ ! -d "$WORKTREES_DIR" ]]; then
  mkdir -p "$WORKTREES_DIR"
  ok "Created ${WORKTREES_DIR}/"
fi

# ── Create worktree ───────────────────────────────────────────────────────────
printf "\nCreating worktree: ${BOLD}${DEST}${RESET}\n"
printf "Branch:           ${BOLD}${BRANCH}${RESET}\n"
printf "Base:             %s\n\n" "$(git -C "$REPO_ROOT" rev-parse main)"

git -C "$REPO_ROOT" worktree add "$DEST" -b "$BRANCH" main

# ── Verify ────────────────────────────────────────────────────────────────────
ACTUAL_BRANCH=$(git -C "$DEST" branch --show-current)
ACTUAL_SHA=$(git -C "$DEST" rev-parse HEAD)
MAIN_SHA=$(git -C "$REPO_ROOT" rev-parse main)

if [[ "$ACTUAL_BRANCH" != "$BRANCH" ]]; then
  fail "Worktree created but branch mismatch: expected '${BRANCH}', got '${ACTUAL_BRANCH}'"
  exit 1
fi

if [[ "$ACTUAL_SHA" != "$MAIN_SHA" ]]; then
  fail "Worktree HEAD does not match main HEAD"
  exit 1
fi

ok "Worktree created at ${DEST}"
ok "Branch: ${BRANCH} (at $(printf '%s' "$ACTUAL_SHA" | head -c 8))"

# ── Print next steps ──────────────────────────────────────────────────────────
printf "\n${BOLD}═══════════════════════════════════════════${RESET}\n"
printf "${BOLD}Next steps — paste into a new terminal:${RESET}\n"
printf "${BOLD}═══════════════════════════════════════════${RESET}\n\n"

# Use relative path if DEST is under REPO_ROOT
REL_DEST="${DEST#${REPO_ROOT}/}"

cat <<NEXT
cd ${REL_DEST}

# Verify you're on the right branch before any work:
git status && git branch --show-current && git rev-parse HEAD

# Expected output:
#   On branch ${BRANCH}
#   nothing to commit, working tree clean
#   ${BRANCH}
#   ${ACTUAL_SHA}
NEXT

printf "\n"
