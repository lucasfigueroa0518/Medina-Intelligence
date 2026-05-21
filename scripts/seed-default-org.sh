#!/usr/bin/env bash
# scripts/seed-default-org.sh
#
# Resolves the DEFAULT_SIGNUP_ORG_ID chicken-and-egg: inserts a default
# organization row into the D1 database, then prints the UUID and the
# exact `wrangler secret put DEFAULT_SIGNUP_ORG_ID` command to run.
#
# Idempotent: if the org already exists (by ID or domain), it skips
# the insert and prints the existing ID.
#
# Usage:
#   bash scripts/seed-default-org.sh
#   bash scripts/seed-default-org.sh --db-name <name>
#   bash scripts/seed-default-org.sh --local       # target local D1 (.wrangler/state)
#   bash scripts/seed-default-org.sh --help
#
# Exit codes:
#   0  Org exists or was created; UUID and secret command printed
#   1  Insert or verification error
#   2  Usage / dependency error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
# Well-known fixed UUID committed in this script so it's reproducible.
# If you need a fresh UUID (e.g., multi-tenant dev with namespace prefixes),
# generate one: python3 -c "import uuid; print(uuid.uuid4())"
DEFAULT_ORG_ID="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
DEFAULT_ORG_NAME="Medina Ventures"
DEFAULT_ORG_DOMAIN="medinaventures.ai"
DB_NAME=""
DB_FLAG="--remote"

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<'HELP'
seed-default-org.sh — insert default org row into D1, print secret command

USAGE
  bash scripts/seed-default-org.sh
  bash scripts/seed-default-org.sh --db-name <name>
  bash scripts/seed-default-org.sh --local
  bash scripts/seed-default-org.sh --help

OPTIONS
  --db-name <name>   D1 database name (default: read from wrangler.toml)
  --local            Target the local D1 in .wrangler/state (default: --remote)
  --help             Show this message

WHAT IT DOES
  1. Determines the D1 database name (from wrangler.toml or --db-name)
  2. Checks if the default org UUID already exists — no-op if it does
  3. Inserts the org row (id, name, domain, settings, created_at, updated_at)
  4. Prints the org UUID and the wrangler secret put command

DEFAULT ORG VALUES
  id:     a1b2c3d4-e5f6-7890-abcd-ef1234567890 (fixed, reproducible)
  name:   Medina Ventures
  domain: medinaventures.ai

To use a custom UUID, edit DEFAULT_ORG_ID at the top of this script.

HELP
}

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)   usage; exit 0 ;;
    --local)     DB_FLAG="--local" ;;
    --db-name)
      shift
      [[ $# -eq 0 ]] && { echo "ERROR: --db-name requires a value" >&2; exit 2; }
      DB_NAME="$1"
      ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'; BOLD='\033[1m'
ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

# ── Resolve D1 database name from wrangler.toml ───────────────────────────────
WRANGLER_TOML="${REPO_ROOT}/wrangler.toml"

if [[ -z "$DB_NAME" ]]; then
  if [[ ! -f "$WRANGLER_TOML" ]]; then
    fail "wrangler.toml not found at ${WRANGLER_TOML}"
    exit 2
  fi
  DB_NAME=$(grep -E '^database_name\s*=' "$WRANGLER_TOML" | head -1 | grep -oE '"[^"]+"' | tr -d '"' || echo "")
  if [[ -z "$DB_NAME" ]]; then
    fail "Could not parse database_name from wrangler.toml"
    exit 2
  fi
fi

ok "D1 database: ${DB_NAME} (${DB_FLAG})"
ok "Org UUID:    ${DEFAULT_ORG_ID}"

# ── wrangler d1 execute helper ────────────────────────────────────────────────
d1_exec() {
  local sql="$1"
  cd "$REPO_ROOT" && npx wrangler d1 execute "${DB_NAME}" "${DB_FLAG}" \
    --command "$sql" 2>&1 | grep -v "^npm notice" | grep -v "^[[:space:]]*$" || true
}

# ── Check if org already exists ───────────────────────────────────────────────
printf "\nChecking if org already exists...\n"
EXISTING=$(d1_exec "SELECT id FROM organizations WHERE id = '${DEFAULT_ORG_ID}' LIMIT 1;" 2>/dev/null || true)

if echo "$EXISTING" | grep -qF "${DEFAULT_ORG_ID}"; then
  warn "Org ${DEFAULT_ORG_ID} already exists — skipping insert"
else
  # Also check by domain to catch partial state
  EXISTING_DOMAIN=$(d1_exec "SELECT id FROM organizations WHERE domain = '${DEFAULT_ORG_DOMAIN}' LIMIT 1;" 2>/dev/null || true)
  if echo "$EXISTING_DOMAIN" | grep -qE '[0-9a-f-]{36}'; then
    EXISTING_ID=$(echo "$EXISTING_DOMAIN" | grep -oE '[0-9a-f-]{36}' | head -1)
    warn "Domain '${DEFAULT_ORG_DOMAIN}' already has an org with ID: ${EXISTING_ID}"
    warn "Using existing ID instead of ${DEFAULT_ORG_ID}"
    DEFAULT_ORG_ID="$EXISTING_ID"
  else
    printf "Inserting org row...\n"
    INSERT_SQL="INSERT INTO organizations (id, name, domain, settings, created_at, updated_at)
      VALUES (
        '${DEFAULT_ORG_ID}',
        '${DEFAULT_ORG_NAME}',
        '${DEFAULT_ORG_DOMAIN}',
        '{}',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      ON CONFLICT(id) DO NOTHING;"

    OUTPUT=$(d1_exec "$INSERT_SQL")
    printf '%s\n' "$OUTPUT"

    # Verify
    VERIFY=$(d1_exec "SELECT id, name, domain FROM organizations WHERE id = '${DEFAULT_ORG_ID}' LIMIT 1;")
    if echo "$VERIFY" | grep -qF "${DEFAULT_ORG_ID}"; then
      ok "Org row inserted and verified"
    else
      fail "Insert appeared to succeed but verification SELECT returned no rows"
      printf "  Verify output: %s\n" "$VERIFY" >&2
      exit 1
    fi
  fi
fi

# ── Print the secret command ───────────────────────────────────────────────────
printf "\n${BOLD}═══════════════════════════════════════════════════════════${RESET}\n"
printf "${BOLD}Run these commands to set the secret on both Workers:${RESET}\n"
printf "${BOLD}═══════════════════════════════════════════════════════════${RESET}\n\n"

printf "  ${GREEN}Org UUID:${RESET} ${DEFAULT_ORG_ID}\n\n"

printf "  # Set on api Worker:\n"
printf "  echo '%s' | npx wrangler secret put DEFAULT_SIGNUP_ORG_ID\n\n" "$DEFAULT_ORG_ID"

printf "  # Set on pipelines Worker:\n"
printf "  echo '%s' | npx wrangler secret put DEFAULT_SIGNUP_ORG_ID --config wrangler.pipelines.toml\n\n" "$DEFAULT_ORG_ID"

printf "  # Or add to .dev.vars for local dev:\n"
printf "  echo 'DEFAULT_SIGNUP_ORG_ID=%s' >> .dev.vars\n\n" "$DEFAULT_ORG_ID"

printf "${BOLD}After setting the secret, new users who sign up will be assigned to this org.${RESET}\n\n"
