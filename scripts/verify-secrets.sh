#!/usr/bin/env bash
# scripts/verify-secrets.sh
# Phase 8 worker-split: confirm pipelines Worker has every secret required
# by code that's moving from api. Run BEFORE deploying pipelines so missing
# secrets surface pre-deploy rather than at first runtime call.
#
# Usage: ./scripts/verify-secrets.sh wrangler.pipelines.toml
# Exit 0 = all required secrets present. Non-zero = at least one missing.

set -euo pipefail

CONFIG="${1:-wrangler.pipelines.toml}"

# Canonical list. 14 entries. Source of truth: which secrets are referenced
# by code paths that move to pipelines (see Phase 8 audit §10).
REQUIRED_SECRETS=(
  # Encryption / decryption (decrypt Outlook tokens, Firefly creds)
  TOKEN_ENCRYPTION_KEY

  # Outlook OAuth refresh (graph-subscriptions + token-refresh paths)
  AZURE_CLIENT_ID
  AZURE_CLIENT_SECRET
  AZURE_TENANT_ID
  AZURE_REDIRECT_URI

  # LLM upstreams (enrichment workflow, deal intelligence, daily cron)
  GOOGLE_GEMINI_API_KEY
  ANTHROPIC_API_KEY

  # Slack ingestion (webhook intake — moves Stage 4 — but shared
  # ingestion utilities reference these on import; safer to set now)
  SLACK_BOT_TOKEN
  SLACK_CLIENT_ID
  SLACK_CLIENT_SECRET
  SLACK_SIGNING_SECRET

  # Enrichment APIs
  REVERSECONTACT_API_KEY

  # Cloudflare gateway (Gemini + AI Gateway routing)
  CLOUDFLARE_AI_GATEWAY_TOKEN

  # Cloudflare API (workflow state reconciler hits CF API to inspect
  # in-flight workflow instances)
  CLOUDFLARE_API_TOKEN
)

# Secrets that are NOT moved (api-only):
#   JWT_SECRET           — user auth (api endpoints only)
#   DEFAULT_SIGNUP_ORG_ID — signup flow (api only)

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config file not found: $CONFIG" >&2
  exit 2
fi

echo "Checking secrets against config: $CONFIG"
echo ""

# Pull secret list from CF for the named Worker. Output is JSON; extract names.
PRESENT=$(npx wrangler secret list --config "$CONFIG" 2>/dev/null \
  | python3 -c "import json, sys; raw=sys.stdin.read(); start=raw.find('['); arr=json.loads(raw[start:]); [print(s['name']) for s in arr]" \
  || echo "")

if [[ -z "$PRESENT" ]]; then
  echo "ERROR: could not list secrets for $CONFIG (Worker may not exist yet)" >&2
  echo "  If this is a fresh deploy, ensure the Worker name matches and you have" >&2
  echo "  authenticated with 'wrangler login'." >&2
  exit 3
fi

MISSING=()
for key in "${REQUIRED_SECRETS[@]}"; do
  if ! grep -qx "$key" <<<"$PRESENT"; then
    MISSING+=("$key")
  fi
done

if [[ ${#MISSING[@]} -eq 0 ]]; then
  echo "✓ All ${#REQUIRED_SECRETS[@]} required secrets present on pipelines Worker."
  exit 0
else
  echo "✗ Missing ${#MISSING[@]} secret(s) on pipelines Worker:"
  for key in "${MISSING[@]}"; do
    echo "    - $key"
  done
  echo ""
  echo "To set each missing secret:"
  for key in "${MISSING[@]}"; do
    echo "  npx wrangler secret put --config $CONFIG $key"
  done
  exit 1
fi
