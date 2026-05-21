#!/usr/bin/env bash
# scripts/bootstrap-cloudflare.sh
#
# Idempotently create the Cloudflare dev stack for a new engineer.
# Every resource is detected by name before creation — safe to run twice.
#
# Usage:
#   npm run bootstrap
#   bash scripts/bootstrap-cloudflare.sh
#   bash scripts/bootstrap-cloudflare.sh --dry-run
#   bash scripts/bootstrap-cloudflare.sh --name-prefix <prefix>
#   bash scripts/bootstrap-cloudflare.sh --allow-production
#   bash scripts/bootstrap-cloudflare.sh --help
#
# After running, the script prints the exact lines to paste into
# wrangler.toml and wrangler.pipelines.toml for your new resource IDs.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
PRODUCTION_ACCOUNT_ID="ad54df3fe69483d2c0b69be1b72864e8"
DRY_RUN=false
ALLOW_PRODUCTION=false
NAME_PREFIX=""
INCLUDE_EXPERIMENTAL_INDEXES=false

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<'HELP'
bootstrap-cloudflare.sh — idempotently create a Cloudflare dev stack

USAGE
  bash scripts/bootstrap-cloudflare.sh [OPTIONS]

OPTIONS
  --dry-run                     Print what would be created; make no changes.
  --name-prefix <prefix>        Prefix all resource names (e.g. "lucas-") for
                                 per-engineer namespacing alongside production.
  --allow-production            Required if wrangler whoami returns the
                                 production account (ad54df3fe...). Refused by
                                 default to prevent accidental production writes.
  --include-experimental-indexes
                                Also create the three future-TODO Vectorize
                                metadata indexes (entity_type, is_org_wide,
                                participant_user_ids). These are NOT used by the
                                current retrieval code. Only add them if you are
                                working on the topK-ceiling refactor described
                                in docs/feedback/feedback_vectorize_metadata_index.md.
  --help                        Show this message.

RESOURCES CREATED
  D1 database:          medina-ventures-db
  R2 bucket:            medina-ventures-storage
  KV namespace:         KV (binding name)
  Vectorize index:      medina-ventures-main (768-dim cosine)
    Metadata indexes:   org_id, document_type, primary_entity_id (always)
  Queues:               audit-log-queue, audit-log-dlq,
                        webhook-intake-queue, webhook-dlq

All resource names are prefixed with --name-prefix if supplied.

EXIT CODES
  0  Success (or dry run completed)
  1  Creation or verification error
  2  Usage / dependency error
HELP
}

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)                    usage; exit 0 ;;
    --dry-run)                    DRY_RUN=true ;;
    --allow-production)           ALLOW_PRODUCTION=true ;;
    --include-experimental-indexes) INCLUDE_EXPERIMENTAL_INDEXES=true ;;
    --name-prefix)
      shift
      [[ $# -eq 0 ]] && { echo "ERROR: --name-prefix requires a value" >&2; exit 2; }
      NAME_PREFIX="$1"
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'; BOLD='\033[1m'
ok()      { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
skip()    { printf "${YELLOW}↷${RESET}  %s\n" "$*"; }
created() { printf "${GREEN}+${RESET} %s\n" "$*"; }
dryrun()  { printf "${YELLOW}(dry-run)${RESET} would create: %s\n" "$*"; }
fail()    { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

# ── Dependencies ──────────────────────────────────────────────────────────────
if ! command -v npx &>/dev/null; then
  fail "npx not found — install Node 20.x"
  exit 2
fi

# ── Production account guard ──────────────────────────────────────────────────
printf "\n${BOLD}Checking Cloudflare account...${RESET}\n"
WHOAMI_OUT=$(npx wrangler whoami 2>&1 || true)

if echo "$WHOAMI_OUT" | grep -qi "not authenticated\|not logged in\|You are not"; then
  fail "Not authenticated with Cloudflare. Run: npx wrangler login"
  exit 1
fi

CURRENT_ACCOUNT_ID=$(echo "$WHOAMI_OUT" | grep -oE '[0-9a-f]{32}' | head -1 || echo "")

if [[ "$CURRENT_ACCOUNT_ID" == "$PRODUCTION_ACCOUNT_ID" ]] && [[ "$ALLOW_PRODUCTION" == false ]]; then
  fail "You are logged into the PRODUCTION account (${PRODUCTION_ACCOUNT_ID})."
  printf "${RED}  Refusing to create resources in production without --allow-production.${RESET}\n" >&2
  printf "${RED}  If you intended to use a personal dev account, run:${RESET}\n" >&2
  printf "${RED}    npx wrangler logout && npx wrangler login${RESET}\n" >&2
  exit 1
fi

ok "Account: ${CURRENT_ACCOUNT_ID:-unknown}"
if [[ "$CURRENT_ACCOUNT_ID" == "$PRODUCTION_ACCOUNT_ID" ]]; then
  warn "Operating on PRODUCTION account — proceeding because --allow-production was passed"
fi

[[ "$DRY_RUN" == true ]] && printf "\n${YELLOW}${BOLD}DRY RUN MODE — no changes will be made${RESET}\n"

# ── Resource name helper ──────────────────────────────────────────────────────
rname() { printf '%s%s' "$NAME_PREFIX" "$1"; }

D1_NAME=$(rname "medina-ventures-db")
R2_NAME=$(rname "medina-ventures-storage")
KV_NAME=$(rname "KV")
VEC_NAME=$(rname "medina-ventures-main")
QUEUES=(
  "$(rname "audit-log-queue")"
  "$(rname "audit-log-dlq")"
  "$(rname "webhook-intake-queue")"
  "$(rname "webhook-dlq")"
)

# ── Run-or-dry helper ─────────────────────────────────────────────────────────
# Usage: run_or_dry "description" command args...
run_or_dry() {
  local desc="$1"; shift
  if [[ "$DRY_RUN" == true ]]; then
    dryrun "$desc"
    return 0
  fi
  "$@"
}

# Capture output of a wrangler command, filtering noise
wrangler_run() {
  npx wrangler "$@" 2>&1 | grep -v "^npm notice" | grep -v "^[[:space:]]*$" || true
}

# ── Collected IDs for wrangler.toml hint ─────────────────────────────────────
D1_ID=""
KV_ID=""

# ── 1. D1 database ────────────────────────────────────────────────────────────
printf "\n${BOLD}1. D1 database: ${D1_NAME}${RESET}\n"

EXISTING_D1=$(wrangler_run d1 list 2>/dev/null | grep -E "^\s*${D1_NAME}\s" || true)
if [[ -n "$EXISTING_D1" ]]; then
  skip "${D1_NAME} already exists — skipping"
  if [[ "$DRY_RUN" == false ]]; then
    D1_ID=$(wrangler_run d1 info "${D1_NAME}" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || echo "existing-check-dashboard")
  fi
else
  if [[ "$DRY_RUN" == true ]]; then
    dryrun "D1 create ${D1_NAME}"
  else
    OUTPUT=$(wrangler_run d1 create "${D1_NAME}")
    printf '%s\n' "$OUTPUT"
    D1_ID=$(printf '%s' "$OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || echo "")
    created "D1 created: ${D1_NAME} (id: ${D1_ID})"
  fi
fi

# ── 2. R2 bucket ──────────────────────────────────────────────────────────────
printf "\n${BOLD}2. R2 bucket: ${R2_NAME}${RESET}\n"

EXISTING_R2=$(wrangler_run r2 bucket list 2>/dev/null | grep -F "${R2_NAME}" || true)
if [[ -n "$EXISTING_R2" ]]; then
  skip "${R2_NAME} already exists — skipping"
else
  if [[ "$DRY_RUN" == true ]]; then
    dryrun "R2 bucket create ${R2_NAME}"
  else
    wrangler_run r2 bucket create "${R2_NAME}"
    created "R2 bucket created: ${R2_NAME}"
  fi
fi

# ── 3. KV namespace ───────────────────────────────────────────────────────────
printf "\n${BOLD}3. KV namespace: ${KV_NAME}${RESET}\n"

EXISTING_KV=$(wrangler_run kv namespace list 2>/dev/null | grep -F "\"${KV_NAME}\"" || true)
if [[ -n "$EXISTING_KV" ]]; then
  skip "${KV_NAME} KV namespace already exists — skipping"
  if [[ "$DRY_RUN" == false ]]; then
    KV_ID=$(wrangler_run kv namespace list 2>/dev/null \
      | grep -A2 "\"${KV_NAME}\"" \
      | grep -oE '"[0-9a-f]{32}"' | head -1 | tr -d '"' || echo "existing-check-dashboard")
  fi
else
  if [[ "$DRY_RUN" == true ]]; then
    dryrun "KV namespace create ${KV_NAME}"
  else
    OUTPUT=$(wrangler_run kv namespace create "${KV_NAME}")
    printf '%s\n' "$OUTPUT"
    KV_ID=$(printf '%s' "$OUTPUT" | grep -oE 'id = "[0-9a-f]+"' | grep -oE '[0-9a-f]+' | head -1 || echo "")
    created "KV namespace created: ${KV_NAME} (id: ${KV_ID})"
  fi
fi

# ── 4. Vectorize index + metadata indexes ─────────────────────────────────────
printf "\n${BOLD}4. Vectorize index: ${VEC_NAME}${RESET}\n"

EXISTING_VEC=$(wrangler_run vectorize list 2>/dev/null | grep -F "${VEC_NAME}" || true)
if [[ -n "$EXISTING_VEC" ]]; then
  skip "${VEC_NAME} Vectorize index already exists — skipping creation"
else
  if [[ "$DRY_RUN" == true ]]; then
    dryrun "vectorize create ${VEC_NAME} --dimensions=768 --metric=cosine"
  else
    wrangler_run vectorize create "${VEC_NAME}" --dimensions=768 --metric=cosine
    created "Vectorize index created: ${VEC_NAME} (768-dim cosine)"
  fi
fi

printf "\n${BOLD}  4a. Required metadata indexes${RESET}\n"
REQUIRED_INDEXES=("org_id" "document_type" "primary_entity_id")

for field in "${REQUIRED_INDEXES[@]}"; do
  if [[ "$DRY_RUN" == true ]]; then
    dryrun "vectorize create-metadata-index ${VEC_NAME} --property-name=${field} --type=string"
  else
    OUTPUT=$(wrangler_run vectorize create-metadata-index "${VEC_NAME}" \
      --property-name="${field}" --type=string 2>&1 || true)
    if echo "$OUTPUT" | grep -qi "already exists\|already enabled\|already indexed"; then
      skip "Metadata index '${field}' already exists"
    else
      printf '%s\n' "$OUTPUT"
      created "Metadata index created: ${field}"
    fi
  fi
done

# ── 4b. Verify all three indexes exist ────────────────────────────────────────
if [[ "$DRY_RUN" == false ]]; then
  printf "\n  Verifying metadata indexes...\n"
  VERIFY_OUT=$(wrangler_run vectorize list-metadata-index "${VEC_NAME}" 2>/dev/null || true)
  VERIFY_FAIL=false

  for field in "${REQUIRED_INDEXES[@]}"; do
    if echo "$VERIFY_OUT" | grep -qF "$field"; then
      ok "  Verified: ${field}"
    else
      fail "  Metadata index '${field}' NOT found after creation — check Cloudflare dashboard"
      VERIFY_FAIL=true
    fi
  done

  if [[ "$VERIFY_FAIL" == true ]]; then
    fail "Metadata index verification failed. Cannot continue."
    exit 1
  fi
fi

# ── 4c. Experimental indexes (opt-in only) ────────────────────────────────────
# These three fields (entity_type, is_org_wide, participant_user_ids) are NOT
# used as Vectorize query filters in the current codebase. They are placeholders
# for a future refactor that would lift the topK ≤ 50 ceiling by moving ACL
# filtering from post-retrieval JS to the Vectorize query layer.
#
# Prerequisites before enabling these:
#   1. Refactor hydration.ts to read r2_key/chunk_index/text_preview from D1
#      instead of the Vectorize payload (required to switch to returnMetadata='indexed')
#   2. Full re-embed of all existing vectors (Vectorize does NOT retroactively
#      index vectors written before an index is declared)
#
# See: src/lib/retrieval.ts ~line 1458 (canonical TODO comment)
#      docs/feedback/feedback_vectorize_metadata_index.md (full explanation)
#
# To enable: pass --include-experimental-indexes to this script.
if [[ "$INCLUDE_EXPERIMENTAL_INDEXES" == true ]]; then
  printf "\n${BOLD}  4d. Experimental metadata indexes (--include-experimental-indexes)${RESET}\n"
  warn "These indexes are not used by current retrieval code. Read"
  warn "docs/feedback/feedback_vectorize_metadata_index.md before proceeding."
  EXPERIMENTAL_INDEXES=("entity_type" "is_org_wide" "participant_user_ids")
  for field in "${EXPERIMENTAL_INDEXES[@]}"; do
    if [[ "$DRY_RUN" == true ]]; then
      dryrun "vectorize create-metadata-index ${VEC_NAME} --property-name=${field} --type=string"
    else
      OUTPUT=$(wrangler_run vectorize create-metadata-index "${VEC_NAME}" \
        --property-name="${field}" --type=string 2>&1 || true)
      if echo "$OUTPUT" | grep -qi "already exists\|already enabled\|already indexed"; then
        skip "Metadata index '${field}' already exists"
      else
        printf '%s\n' "$OUTPUT"
        warn "Created experimental index '${field}' — remember to run full re-embed"
      fi
    fi
  done
fi

# ── 5. Queues ─────────────────────────────────────────────────────────────────
printf "\n${BOLD}5. Queues${RESET}\n"

for queue in "${QUEUES[@]}"; do
  EXISTING_Q=$(wrangler_run queues list 2>/dev/null | grep -F "$queue" || true)
  if [[ -n "$EXISTING_Q" ]]; then
    skip "Queue '${queue}' already exists — skipping"
  else
    if [[ "$DRY_RUN" == true ]]; then
      dryrun "queues create ${queue}"
    else
      wrangler_run queues create "${queue}"
      created "Queue created: ${queue}"
    fi
  fi
done

# ── 6. Print wrangler.toml paste hint ─────────────────────────────────────────
printf "\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n"
printf "${BOLD}Paste these lines into wrangler.toml and wrangler.pipelines.toml:${RESET}\n"
printf "${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n\n"

D1_ID_HINT="${D1_ID:-<run: npx wrangler d1 info ${D1_NAME} | grep database_id>}"
KV_ID_HINT="${KV_ID:-<run: npx wrangler kv namespace list | grep ${KV_NAME}>}"

cat <<TOML_HINT
# In wrangler.toml — replace the production IDs with these:
[[d1_databases]]
binding = "D1"
database_name = "${D1_NAME}"
database_id = "${D1_ID_HINT}"
preview_database_id = "${D1_ID_HINT}"

[[kv_namespaces]]
binding = "KV"
id = "${KV_ID_HINT}"
preview_id = "${KV_ID_HINT}"

[[vectorize]]
binding = "VECTORIZE"
index_name = "${VEC_NAME}"
# Metadata indexes active: org_id, document_type, primary_entity_id

# Queue bindings (names only — no ID needed for Queues):
# [[queues.producers]] queue = "${QUEUES[0]}" binding = "AUDIT_QUEUE"
# [[queues.producers]] queue = "${QUEUES[1]}" binding = "AUDIT_DLQ"
# [[queues.producers]] queue = "${QUEUES[2]}" binding = "WEBHOOK_QUEUE"
# [[queues.producers]] queue = "${QUEUES[3]}" binding = "WEBHOOK_DLQ"

TOML_HINT

printf "\n${BOLD}Next steps:${RESET}\n"
printf "  1. Paste the above into wrangler.toml and wrangler.pipelines.toml\n"
printf "  2. Create .dev.vars from .env.example: cp .env.example .dev.vars && \$EDITOR .dev.vars\n"
printf "  3. Create frontend/.env.local: echo \"NEXT_PUBLIC_API_URL=http://127.0.0.1:8787\" > frontend/.env.local\n"
printf "  4. Apply migrations: npm run migrate:local\n"
printf "  5. Run preflight: npm run preflight\n"
printf "  6. Start dev servers: npm run dev\n\n"

[[ "$DRY_RUN" == true ]] && printf "${YELLOW}Dry run complete — no resources were created.${RESET}\n\n"
