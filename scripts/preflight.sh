#!/usr/bin/env bash
# scripts/preflight.sh
#
# Validate a fresh local development environment before running `npm run dev`.
# Each check is independent — one failure does not skip later checks.
# Exits 0 only if every required check passes; exits 1 otherwise.
#
# Usage:
#   npm run preflight              # via package.json script
#   bash scripts/preflight.sh
#   bash scripts/preflight.sh --help
#
# Provider API checks require real keys in .dev.vars. They are skipped (with a
# warning) if the key is absent or empty.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<'HELP'
preflight.sh — validate local dev environment before first run

USAGE
  bash scripts/preflight.sh       Run all checks
  bash scripts/preflight.sh --help

CHECKS PERFORMED
  1. Node version (20.x required, 22.x warn)
  2. npx wrangler whoami (Cloudflare auth)
  3. .dev.vars has every key from .env.example
  4. frontend/.env.local has NEXT_PUBLIC_API_URL
  5. Root .env.local detection (warn if worker keys found — rename to .dev.vars)
  6. Provider API reachability (Anthropic, Gemini, ReverseContact, Slack, MS Graph)

EXIT CODES
  0  All required checks pass
  1  One or more required checks failed

HELP
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
BOLD='\033[1m'
ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*"; }
info() { printf "  %s\n" "$*"; }

PASS=true
WARNINGS=()

require_pass() { PASS=false; }

# ── Check 1: Node version ─────────────────────────────────────────────────────
printf "\n${BOLD}Check 1: Node version${RESET}\n"
NODE_VERSION=$(node --version 2>/dev/null || echo "not found")
MAJOR=$(echo "$NODE_VERSION" | grep -oE '^v([0-9]+)' | tr -d 'v' || echo "0")

if [[ "$NODE_VERSION" == "not found" ]]; then
  fail "Node not found — install Node 20.x from https://nodejs.org"
  require_pass
elif [[ "$MAJOR" == "20" ]]; then
  ok "Node $NODE_VERSION (20.x)"
elif [[ "$MAJOR" == "22" ]]; then
  warn "Node $NODE_VERSION (22.x) — tested on 20.x; 22.x may work but is unsupported"
  WARNINGS+=("Node 22.x: switch to 20.x if you hit compatibility issues")
elif [[ "$MAJOR" -lt "20" ]]; then
  fail "Node $NODE_VERSION — 20.x required (found older version)"
  require_pass
else
  warn "Node $NODE_VERSION — expected 20.x; newer versions are untested"
  WARNINGS+=("Node $NODE_VERSION: expected 20.x")
fi

# ── Check 2: Wrangler auth ────────────────────────────────────────────────────
printf "\n${BOLD}Check 2: Wrangler authentication${RESET}\n"
WHOAMI_OUT=$(cd "$REPO_ROOT" && npx wrangler whoami 2>&1 || true)
if echo "$WHOAMI_OUT" | grep -q "You are logged in"; then
  ACCOUNT_LINE=$(echo "$WHOAMI_OUT" | grep -E "Account Name|account_id" | head -2 || true)
  ok "Wrangler authenticated"
  info "$ACCOUNT_LINE"
elif echo "$WHOAMI_OUT" | grep -qi "not authenticated\|not logged in\|You are not"; then
  fail "Wrangler not authenticated — run: npx wrangler login"
  require_pass
else
  warn "Could not determine Wrangler auth state"
  info "$(echo "$WHOAMI_OUT" | head -3)"
  WARNINGS+=("Wrangler auth unclear — run 'npx wrangler whoami' manually")
fi

# ── Check 3: .dev.vars completeness ──────────────────────────────────────────
printf "\n${BOLD}Check 3: .dev.vars completeness${RESET}\n"
DEV_VARS="${REPO_ROOT}/.dev.vars"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"

if [[ ! -f "$ENV_EXAMPLE" ]]; then
  warn ".env.example not found — skipping .dev.vars check"
  WARNINGS+=(".env.example missing — run: bash scripts/generate-env-example.sh")
elif [[ ! -f "$DEV_VARS" ]]; then
  fail ".dev.vars not found — create it with secrets from .env.example"
  info "See README 'Local setup' step 5 for the full list."
  require_pass
else
  MISSING_KEYS=()
  OPTIONAL_KEYS=(GOOGLE_GEMINI_API_KEY DEFAULT_SIGNUP_ORG_ID ALLOWED_SIGNUP_DOMAINS NEXT_PUBLIC_API_URL)

  while IFS= read -r line; do
    key=$(printf '%s' "$line" | grep -oE '^[A-Z_][A-Z_0-9]+=' | tr -d '=') || true
    [[ -z "$key" ]] && continue
    # Skip optional keys and the frontend key (belongs in frontend/.env.local)
    is_optional=false
    for opt in "${OPTIONAL_KEYS[@]}"; do
      [[ "$key" == "$opt" ]] && is_optional=true && break
    done
    [[ "$is_optional" == true ]] && continue

    # Check presence without reading values — grep for the key name only
    if ! grep -qE "^${key}=" "$DEV_VARS"; then
      MISSING_KEYS+=("$key")
    fi
  done < "$ENV_EXAMPLE"

  if [[ ${#MISSING_KEYS[@]} -eq 0 ]]; then
    ok ".dev.vars has all required keys"
  else
    fail ".dev.vars is missing ${#MISSING_KEYS[@]} required key(s):"
    for k in "${MISSING_KEYS[@]}"; do info "  - $k"; done
    require_pass
  fi
fi

# ── Check 4: frontend/.env.local ─────────────────────────────────────────────
printf "\n${BOLD}Check 4: frontend/.env.local${RESET}\n"
FRONTEND_ENV="${REPO_ROOT}/frontend/.env.local"

if [[ ! -f "$FRONTEND_ENV" ]]; then
  fail "frontend/.env.local not found"
  info "Create it: echo \"NEXT_PUBLIC_API_URL=http://127.0.0.1:8787\" > frontend/.env.local"
  require_pass
elif ! grep -qE '^NEXT_PUBLIC_API_URL=' "$FRONTEND_ENV"; then
  fail "frontend/.env.local exists but NEXT_PUBLIC_API_URL is not set"
  info "Add: NEXT_PUBLIC_API_URL=http://127.0.0.1:8787"
  require_pass
else
  ok "frontend/.env.local has NEXT_PUBLIC_API_URL"
fi

# ── Check 5: Root .env.local detection (misnamed .dev.vars) ──────────────────
printf "\n${BOLD}Check 5: Root .env.local detection${RESET}\n"
ROOT_ENV_LOCAL="${REPO_ROOT}/.env.local"
WORKER_KEYS=(JWT_SECRET ANTHROPIC_API_KEY TOKEN_ENCRYPTION_KEY AZURE_CLIENT_ID SLACK_CLIENT_ID FIREFLY_WEBHOOK_SECRET)

if [[ -f "$ROOT_ENV_LOCAL" ]]; then
  FOUND_WORKER_KEY=false
  for k in "${WORKER_KEYS[@]}"; do
    if grep -qE "^${k}=" "$ROOT_ENV_LOCAL" 2>/dev/null; then
      FOUND_WORKER_KEY=true
      break
    fi
  done

  if [[ "$FOUND_WORKER_KEY" == true ]]; then
    warn "Detected .env.local at repo root containing Worker secrets."
    info "Wrangler reads .dev.vars, NOT .env.local. Your secrets are invisible to wrangler dev."
    info "Fix: mv .env.local .dev.vars"
    WARNINGS+=("Root .env.local contains Worker secrets — rename to .dev.vars")
  else
    ok "Root .env.local exists but contains no Worker secrets (OK)"
  fi
else
  ok "No root .env.local detected"
fi

# ── Check 6: Provider API reachability ───────────────────────────────────────
printf "\n${BOLD}Check 6: Provider API reachability${RESET}\n"

# Helper: read a key from .dev.vars without printing the value
get_secret() {
  local key="$1"
  local file="${DEV_VARS:-}"
  [[ -z "$file" || ! -f "$file" ]] && echo "" && return
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || echo ""
}

PROVIDER_RESULTS=()

# Anthropic: GET /v1/models
ANTHROPIC_KEY=$(get_secret ANTHROPIC_API_KEY)
if [[ -z "$ANTHROPIC_KEY" ]]; then
  PROVIDER_RESULTS+=("Anthropic   | SKIP  | ANTHROPIC_API_KEY not in .dev.vars")
else
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-api-key: ${ANTHROPIC_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    "https://api.anthropic.com/v1/models" 2>/dev/null || echo "ERR")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    PROVIDER_RESULTS+=("Anthropic   | PASS  | HTTP 200")
  elif [[ "$HTTP_STATUS" == "401" ]]; then
    PROVIDER_RESULTS+=("Anthropic   | FAIL  | HTTP 401 — invalid API key")
    PASS=false
  else
    PROVIDER_RESULTS+=("Anthropic   | WARN  | HTTP ${HTTP_STATUS}")
  fi
fi

# Gemini: GET /v1beta/models
GEMINI_KEY=$(get_secret GOOGLE_GEMINI_API_KEY)
if [[ -z "$GEMINI_KEY" ]]; then
  PROVIDER_RESULTS+=("Gemini      | SKIP  | GOOGLE_GEMINI_API_KEY not in .dev.vars (optional)")
else
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}" 2>/dev/null || echo "ERR")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    PROVIDER_RESULTS+=("Gemini      | PASS  | HTTP 200")
  elif [[ "$HTTP_STATUS" == "400" || "$HTTP_STATUS" == "403" ]]; then
    PROVIDER_RESULTS+=("Gemini      | FAIL  | HTTP ${HTTP_STATUS} — check API key and billing")
    PASS=false
  else
    PROVIDER_RESULTS+=("Gemini      | WARN  | HTTP ${HTTP_STATUS}")
  fi
fi

# ReverseContact: quota-cheap endpoint (HEAD on base URL to check reachability)
RC_KEY=$(get_secret REVERSECONTACT_API_KEY)
if [[ -z "$RC_KEY" ]]; then
  PROVIDER_RESULTS+=("ReverseContact | SKIP | REVERSECONTACT_API_KEY not in .dev.vars")
else
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: ${RC_KEY}" \
    "https://api.reversecontact.com/enrichment?linkedin_url=https://linkedin.com/in/test" \
    2>/dev/null || echo "ERR")
  if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "404" || "$HTTP_STATUS" == "422" ]]; then
    PROVIDER_RESULTS+=("ReverseContact | PASS | HTTP ${HTTP_STATUS} (authenticated)")
  elif [[ "$HTTP_STATUS" == "401" || "$HTTP_STATUS" == "403" ]]; then
    PROVIDER_RESULTS+=("ReverseContact | FAIL | HTTP ${HTTP_STATUS} — invalid API key")
    PASS=false
  else
    PROVIDER_RESULTS+=("ReverseContact | WARN | HTTP ${HTTP_STATUS}")
  fi
fi

# Microsoft Graph: token endpoint reachability (no credentials needed, just TCP)
AZURE_TENANT=$(get_secret AZURE_TENANT_ID)
if [[ -z "$AZURE_TENANT" ]]; then
  PROVIDER_RESULTS+=("MS Graph    | SKIP  | AZURE_TENANT_ID not in .dev.vars")
else
  TENANT="${AZURE_TENANT:-common}"
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 10 \
    "https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration" \
    2>/dev/null || echo "ERR")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    PROVIDER_RESULTS+=("MS Graph    | PASS  | Token endpoint reachable (HTTP 200)")
  else
    PROVIDER_RESULTS+=("MS Graph    | WARN  | HTTP ${HTTP_STATUS} — tenant endpoint unreachable")
  fi
fi

# Slack: auth.test
SLACK_TOKEN=$(get_secret SLACK_BOT_TOKEN)
if [[ -z "$SLACK_TOKEN" ]]; then
  PROVIDER_RESULTS+=("Slack       | SKIP  | SLACK_BOT_TOKEN not in .dev.vars")
else
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${SLACK_TOKEN}" \
    "https://slack.com/api/auth.test" 2>/dev/null || echo "ERR")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    # Check the JSON ok field
    BODY=$(curl -s \
      -H "Authorization: Bearer ${SLACK_TOKEN}" \
      "https://slack.com/api/auth.test" 2>/dev/null || echo '{}')
    if echo "$BODY" | grep -q '"ok":true'; then
      PROVIDER_RESULTS+=("Slack       | PASS  | auth.test ok:true")
    else
      ERROR=$(echo "$BODY" | grep -oE '"error":"[^"]+"' | head -1 || echo "unknown error")
      PROVIDER_RESULTS+=("Slack       | FAIL  | auth.test ok:false — ${ERROR}")
      PASS=false
    fi
  else
    PROVIDER_RESULTS+=("Slack       | WARN  | HTTP ${HTTP_STATUS}")
  fi
fi

# ── Provider summary table ────────────────────────────────────────────────────
printf "\n  %-20s %-8s %s\n" "Provider" "Result" "Detail"
printf "  %-20s %-8s %s\n" "────────────────────" "──────" "──────────────────────────────────────────"
for row in "${PROVIDER_RESULTS[@]}"; do
  IFS='|' read -r provider result detail <<< "$row"
  provider=$(printf '%s' "$provider" | xargs)
  result=$(printf '%s' "$result" | xargs)
  detail=$(printf '%s' "$detail" | xargs)
  case "$result" in
    PASS) color="$GREEN" ;;
    SKIP) color="$YELLOW" ;;
    WARN) color="$YELLOW" ;;
    FAIL) color="$RED" ;;
    *)    color="$RESET" ;;
  esac
  printf "  %-20s ${color}%-8s${RESET} %s\n" "$provider" "$result" "$detail"
done

# ── Final summary ─────────────────────────────────────────────────────────────
printf "\n${BOLD}═══════════════════════════════════════════${RESET}\n"

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  printf "${YELLOW}Warnings:${RESET}\n"
  for w in "${WARNINGS[@]}"; do
    warn "$w"
  done
  printf "\n"
fi

if [[ "$PASS" == true ]]; then
  printf "${GREEN}${BOLD}Preflight passed.${RESET} You're ready to run: npm run dev\n\n"
  exit 0
else
  printf "${RED}${BOLD}Preflight failed.${RESET} Fix the issues above, then re-run: npm run preflight\n\n"
  exit 1
fi
