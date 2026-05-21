#!/usr/bin/env bash
# scripts/generate-env-example.sh
#
# Parse the "Environment variables and secrets" table in README.md and
# verify that .env.example agrees on the key set. Prevents README and
# .env.example from drifting silently.
#
# Usage:
#   bash scripts/generate-env-example.sh           # verify sync, exit 0 if good
#   bash scripts/generate-env-example.sh --check   # same; alias for CI pipelines
#   bash scripts/generate-env-example.sh --help
#
# Exit codes:
#   0  in sync
#   1  drift detected (keys in README but not .env.example, or vice versa)
#   2  usage / dependency error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
README="${REPO_ROOT}/README.md"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<'HELP'
generate-env-example.sh — keep .env.example in sync with README

USAGE
  bash scripts/generate-env-example.sh           Verify README ↔ .env.example sync
  bash scripts/generate-env-example.sh --check   Same (CI-friendly alias), exit 1 if out of sync
  bash scripts/generate-env-example.sh --help    Show this message

DESCRIPTION
  Parses the "Environment variables and secrets" table in README.md and
  extracts every key whose "Where" column is "secret" or
  "frontend/.env.local". Static [vars] entries (ENVIRONMENT,
  CLOUDFLARE_ACCOUNT_ID, etc.) live in wrangler.toml and are excluded.

  Compares that key set against the keys present in .env.example.
  Exits 1 and prints a diff if they diverge.

  To regenerate .env.example from scratch, delete it and re-run.
  The script will create a minimal stub; then replace it with the
  hand-authored version that includes comments and grouping.
HELP
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --check)   ;;   # accepted for CI compatibility; behaviour is the same
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

# ── Dependencies ──────────────────────────────────────────────────────────────
if [[ ! -f "$README" ]]; then
  echo "ERROR: README.md not found at $README" >&2
  exit 2
fi

# ── Extract secret keys from README table ─────────────────────────────────────
# Match table rows whose second column (Where) is "secret" or "`frontend/.env.local`".
# Rows with "wrangler `[vars]`" are deliberately excluded — they live in wrangler.toml.
EXTRACTED_KEYS=()
while IFS= read -r line; do
  if printf '%s' "$line" | grep -qE '\|\s*(secret|`frontend/\.env\.local`)\s*\|'; then
    key=$(printf '%s' "$line" | grep -oE '`[A-Z_][A-Z_0-9]+`' | head -1 | tr -d '`')
    if [[ -n "$key" ]]; then
      EXTRACTED_KEYS+=("$key")
    fi
  fi
done < "$README"

if [[ ${#EXTRACTED_KEYS[@]} -eq 0 ]]; then
  echo "ERROR: no secret keys found in README table — check the table format" >&2
  exit 2
fi

echo "README table: ${#EXTRACTED_KEYS[@]} secret keys found"

# ── Handle missing .env.example ───────────────────────────────────────────────
if [[ ! -f "$ENV_EXAMPLE" ]]; then
  echo "INFO: .env.example does not exist — creating minimal stub..."
  {
    printf '# .env.example — auto-generated stub\n'
    printf '# Replace with the hand-authored version from the repo.\n'
    printf '# Copy to .dev.vars for local wrangler dev. Do not commit .dev.vars.\n\n'
    for key in "${EXTRACTED_KEYS[@]}"; do
      printf '%s=\n' "$key"
    done
  } > "$ENV_EXAMPLE"
  echo "Created ${ENV_EXAMPLE} with ${#EXTRACTED_KEYS[@]} keys"
  echo "NOTE: Replace with the annotated version that includes comments and grouping."
  exit 0
fi

# ── Extract keys from .env.example ────────────────────────────────────────────
EXAMPLE_KEYS=()
while IFS= read -r line; do
  key=$(printf '%s' "$line" | grep -oE '^[A-Z_][A-Z_0-9]+=' | tr -d '=') || true
  if [[ -n "$key" ]]; then
    EXAMPLE_KEYS+=("$key")
  fi
done < "$ENV_EXAMPLE"

echo ".env.example:  ${#EXAMPLE_KEYS[@]} keys found"

# ── Compare key sets ──────────────────────────────────────────────────────────
# Write both sorted lists to temp files to avoid subshell + set -e interactions.
TMP_README=$(mktemp)
TMP_EXAMPLE=$(mktemp)
trap 'rm -f "$TMP_README" "$TMP_EXAMPLE"' EXIT

printf '%s\n' "${EXTRACTED_KEYS[@]}" | sort > "$TMP_README"
printf '%s\n' "${EXAMPLE_KEYS[@]}"   | sort > "$TMP_EXAMPLE"

MISSING_FROM_EXAMPLE=$(comm -23 "$TMP_README" "$TMP_EXAMPLE" || true)
EXTRA_IN_EXAMPLE=$(comm -13 "$TMP_README" "$TMP_EXAMPLE" || true)

if [[ -n "$MISSING_FROM_EXAMPLE" ]] || [[ -n "$EXTRA_IN_EXAMPLE" ]]; then
  echo ""
  echo "FAIL: .env.example is out of sync with README table" >&2
  if [[ -n "$MISSING_FROM_EXAMPLE" ]]; then
    echo "  Keys in README but missing from .env.example:" >&2
    printf '%s\n' "$MISSING_FROM_EXAMPLE" | sed 's/^/    + /' >&2
  fi
  if [[ -n "$EXTRA_IN_EXAMPLE" ]]; then
    echo "  Keys in .env.example but not in README table:" >&2
    printf '%s\n' "$EXTRA_IN_EXAMPLE" | sed 's/^/    - /' >&2
  fi
  echo "" >&2
  echo "To fix: update both README.md and .env.example to agree, then re-run." >&2
  exit 1
fi

echo "OK: .env.example is in sync with README (${#EXAMPLE_KEYS[@]} keys)"
