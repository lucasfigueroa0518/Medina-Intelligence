#!/usr/bin/env bash
# scripts/smoke-test-integrations.sh
#
# Fire known payloads at each webhook/admin endpoint and assert the
# expected response. Tests are independent — one failing does not skip
# others. Prints a summary table at the end.
#
# Usage:
#   bash scripts/smoke-test-integrations.sh
#   bash scripts/smoke-test-integrations.sh --target https://my-worker.workers.dev
#   bash scripts/smoke-test-integrations.sh --help
#
# The Worker must be running locally (`npm run dev:api`) or a --target
# URL must be provided.
#
# Exit codes:
#   0  All tests passed
#   1  One or more tests failed
#   2  Usage error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="http://127.0.0.1:8787"
ADMIN_JWT=""
FIREFLY_SECRET=""

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<'HELP'
smoke-test-integrations.sh — fire test payloads at Worker endpoints

USAGE
  bash scripts/smoke-test-integrations.sh [OPTIONS]

OPTIONS
  --target <url>     Worker base URL (default: http://127.0.0.1:8787)
  --jwt <token>      Admin JWT for authenticated endpoints (optional;
                     admin endpoints are skipped if not provided)
  --firefly-secret <s>  HMAC-SHA256 secret for Firefly webhook signing.
                     Falls back to reading FIREFLY_WEBHOOK_SECRET from .dev.vars.
  --help             Show this message

TESTS
  1. GET  /health                     → {"ok":true}
  2. POST /webhooks/slack (challenge)  → echoes challenge field
  3. POST /webhooks/firefly           → signed test payload, asserts 200
  4. POST /api/admin/run-daily-cron   → 200, no error in body (requires --jwt)
  5. GET  /api/admin/system-status    → 200 with JSON (requires --jwt)

All tests run independently. A summary table is printed at the end.
EXIT CODES
  0  All tests passed
  1  One or more tests failed

HELP
}

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)      usage; exit 0 ;;
    --target)       shift; TARGET="$1" ;;
    --jwt)          shift; ADMIN_JWT="$1" ;;
    --firefly-secret) shift; FIREFLY_SECRET="$1" ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'; BOLD='\033[1m'

# ── Test result tracking ──────────────────────────────────────────────────────
RESULTS=()
FAIL=false

record() {
  local name="$1" result="$2" detail="$3"
  RESULTS+=("${name}|${result}|${detail}")
  if [[ "$result" == "FAIL" ]]; then FAIL=true; fi
}

# ── Helpers ───────────────────────────────────────────────────────────────────
# Read a key from .dev.vars (value only, no logging)
get_devvar() {
  local key="$1"
  local devvars="${REPO_ROOT}/.dev.vars"
  [[ ! -f "$devvars" ]] && echo "" && return
  grep -E "^${key}=" "$devvars" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || echo ""
}

# HMAC-SHA256 of a message using a secret key, hex-encoded
hmac_sha256() {
  local secret="$1" message="$2"
  if command -v openssl &>/dev/null; then
    printf '%s' "$message" | openssl dgst -sha256 -hmac "$secret" -hex 2>/dev/null | awk '{print $NF}'
  else
    echo "NO_OPENSSL"
  fi
}

# ── Resolve Firefly secret ────────────────────────────────────────────────────
if [[ -z "$FIREFLY_SECRET" ]]; then
  FIREFLY_SECRET=$(get_devvar FIREFLY_WEBHOOK_SECRET)
fi

printf "\n${BOLD}Smoke tests → ${TARGET}${RESET}\n\n"

# ── Test 1: /health ───────────────────────────────────────────────────────────
printf "Test 1: GET /health\n"
BODY=$(curl -sf --max-time 10 "${TARGET}/health" 2>/dev/null || echo "CURL_FAIL")

if [[ "$BODY" == "CURL_FAIL" ]]; then
  record "/health" "FAIL" "Connection refused — is the Worker running? (npm run dev:api)"
elif echo "$BODY" | grep -q '"ok":true'; then
  record "/health" "PASS" "$(echo "$BODY" | head -c 80)"
else
  record "/health" "FAIL" "Unexpected response: $(echo "$BODY" | head -c 80)"
fi

# ── Test 2: /webhooks/slack URL verification challenge ────────────────────────
printf "Test 2: POST /webhooks/slack (challenge)\n"
CHALLENGE_VALUE="smoke_test_challenge_$(date +%s)"
SLACK_PAYLOAD="{\"type\":\"url_verification\",\"challenge\":\"${CHALLENGE_VALUE}\"}"

SLACK_BODY=$(curl -sf --max-time 10 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$SLACK_PAYLOAD" \
  "${TARGET}/webhooks/slack" 2>/dev/null || echo "CURL_FAIL")

if [[ "$SLACK_BODY" == "CURL_FAIL" ]]; then
  record "/webhooks/slack" "FAIL" "Connection refused"
elif echo "$SLACK_BODY" | grep -qF "$CHALLENGE_VALUE"; then
  record "/webhooks/slack" "PASS" "Challenge echoed correctly"
else
  record "/webhooks/slack" "FAIL" "Challenge not echoed. Response: $(echo "$SLACK_BODY" | head -c 80)"
fi

# ── Test 3: /webhooks/firefly (signed test payload) ───────────────────────────
printf "Test 3: POST /webhooks/firefly (HMAC-signed)\n"

FF_PAYLOAD='{"event":"Transcribed","meeting_id":"smoke-test-001","title":"Smoke Test Meeting"}'

if [[ -z "$FIREFLY_SECRET" ]]; then
  record "/webhooks/firefly" "SKIP" "FIREFLY_WEBHOOK_SECRET not available — pass --firefly-secret or add to .dev.vars"
elif [[ "$FIREFLY_SECRET" == "NO_OPENSSL" ]] || ! command -v openssl &>/dev/null; then
  record "/webhooks/firefly" "SKIP" "openssl not available — cannot sign payload"
else
  FF_SIG=$(hmac_sha256 "$FIREFLY_SECRET" "$FF_PAYLOAD")
  FF_HTTP=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-Hub-Signature-256: sha256=${FF_SIG}" \
    -d "$FF_PAYLOAD" \
    "${TARGET}/webhooks/firefly" 2>/dev/null || echo "ERR")

  if [[ "$FF_HTTP" == "200" ]] || [[ "$FF_HTTP" == "202" ]]; then
    record "/webhooks/firefly" "PASS" "HTTP ${FF_HTTP}"
  elif [[ "$FF_HTTP" == "401" ]]; then
    record "/webhooks/firefly" "FAIL" "HTTP 401 — HMAC signature rejected (check FIREFLY_WEBHOOK_SECRET matches)"
  else
    record "/webhooks/firefly" "FAIL" "HTTP ${FF_HTTP}"
  fi
fi

# ── Test 4: POST /api/admin/run-daily-cron ────────────────────────────────────
printf "Test 4: POST /api/admin/run-daily-cron (requires --jwt)\n"

if [[ -z "$ADMIN_JWT" ]]; then
  record "/api/admin/run-daily-cron" "SKIP" "No --jwt provided — skipping admin endpoint"
else
  CRON_HTTP=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 30 \
    -X POST \
    -H "Authorization: Bearer ${ADMIN_JWT}" \
    -H "Content-Type: application/json" \
    "${TARGET}/api/admin/run-daily-cron" 2>/dev/null || echo "ERR")
  CRON_BODY=$(curl -sf --max-time 30 \
    -X POST \
    -H "Authorization: Bearer ${ADMIN_JWT}" \
    -H "Content-Type: application/json" \
    "${TARGET}/api/admin/run-daily-cron" 2>/dev/null || echo "{}")

  if [[ "$CRON_HTTP" == "200" ]]; then
    if echo "$CRON_BODY" | grep -qi '"error"'; then
      record "/api/admin/run-daily-cron" "FAIL" "HTTP 200 but error in body: $(echo "$CRON_BODY" | head -c 80)"
    else
      record "/api/admin/run-daily-cron" "PASS" "HTTP 200, no error in body"
    fi
  elif [[ "$CRON_HTTP" == "401" ]]; then
    record "/api/admin/run-daily-cron" "FAIL" "HTTP 401 — JWT invalid or expired"
  else
    record "/api/admin/run-daily-cron" "FAIL" "HTTP ${CRON_HTTP}"
  fi
fi

# ── Test 5: GET /api/admin/system-status ─────────────────────────────────────
printf "Test 5: GET /api/admin/system-status (requires --jwt)\n"

if [[ -z "$ADMIN_JWT" ]]; then
  record "/api/admin/system-status" "SKIP" "No --jwt provided — skipping admin endpoint"
else
  STATUS_HTTP=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "Authorization: Bearer ${ADMIN_JWT}" \
    "${TARGET}/api/admin/system-status" 2>/dev/null || echo "ERR")

  if [[ "$STATUS_HTTP" == "200" ]]; then
    record "/api/admin/system-status" "PASS" "HTTP 200"
  elif [[ "$STATUS_HTTP" == "401" ]]; then
    record "/api/admin/system-status" "FAIL" "HTTP 401 — JWT invalid or expired"
  else
    record "/api/admin/system-status" "FAIL" "HTTP ${STATUS_HTTP}"
  fi
fi

# ── Summary table ─────────────────────────────────────────────────────────────
printf "\n${BOLD}══════════════════════════════════════════════════════════════════${RESET}\n"
printf "${BOLD}Results${RESET}\n"
printf "${BOLD}══════════════════════════════════════════════════════════════════${RESET}\n\n"
printf "  %-40s %-8s %s\n" "Endpoint" "Result" "Detail"
printf "  %-40s %-8s %s\n" "────────────────────────────────────────" "──────" "────────────────────────────────────────"

for row in "${RESULTS[@]}"; do
  IFS='|' read -r name result detail <<< "$row"
  case "$result" in
    PASS) color="$GREEN" ;;
    SKIP) color="$YELLOW" ;;
    FAIL) color="$RED" ;;
    *)    color="$RESET" ;;
  esac
  printf "  %-40s ${color}%-8s${RESET} %s\n" "$name" "$result" "$detail"
done

printf "\n"

if [[ "$FAIL" == true ]]; then
  printf "${RED}${BOLD}Smoke tests FAILED.${RESET}\n\n"
  exit 1
else
  printf "${GREEN}${BOLD}All smoke tests passed.${RESET}\n\n"
  exit 0
fi
