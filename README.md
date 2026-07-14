# Medina Ventures Intelligence Platform

VC CRM and intelligence platform built on Cloudflare Workers. Ingests email, calendar, meeting transcripts (Firefly), and Slack into a deduplicated graph of contacts, companies, and deals; enriches with ReverseContact and Gemini; serves a RAG agent (MARTy) over the firm's full data with citation enforcement. Frontend is Next.js on Vercel.

This README targets a new engineer with a clean machine. Run the golden path below and you should have a local backend running against a fresh D1 database and a local frontend talking to it in **under 15 minutes** (excluding integration OAuth dashboard setup, which is per-integration and done separately).

## Status

- Production: live at https://medinaventures.ai (frontend) + `medina-ventures-api.<account>.workers.dev` (Worker).
- Phase 8 partial ship (2026-05-06): a second Worker `medina-ventures-pipelines` now owns the Workflow class definitions and the cron triggers. The `medina-ventures-api` Worker still has direct `env.<WORKFLOW>.create()` callsites pending the planned strip + service-binding refactor — see `src/index.ts` header comment.
- All 95 migrations through `0091_marty_lab.sql` are applied in production. Backend typechecks clean.
- This is a single-tenant production system. Treat schema changes and migrations as live-data operations.

## Current no-fly zones

These restrictions apply while Phase 8's strip-and-service-binding refactor is in progress. Do not work around them without explicit coordination.

- **Do not add new `env.<WORKFLOW>.create()` callsites in `src/index.ts`.** Workflow class ownership has moved to `medina-ventures-pipelines`; the api Worker's remaining `.create()` calls are legacy stubs awaiting the service-binding refactor.
- **Do not re-add `[[workflows]]` declarations to `wrangler.toml`.** They were removed in Phase 8 and would re-claim workflow ownership from the pipelines Worker, breaking production runs mid-flight.
- **Do not add new `[triggers]` or `crons` to `wrangler.toml`.** All cron triggers now run on the pipelines Worker (`wrangler.pipelines.toml`).
- **Migrations are forward-only.** Production has 0001–0091. Write a new migration to undo any schema change; do not edit existing migration files.
- **D1 production ID `4bb3705c-c471-43f7-b42f-b44ab62f5dab` is live data.** Never run `migrate:remote` or bootstrap scripts against it without a pre-approved plan.

## Architecture

```
                  ┌────────────────────────────────────────────────────────┐
                  │                     Vercel (Next.js 16)                │
                  │           frontend/  →  medinaventures.ai              │
                  └──────────────────────────┬─────────────────────────────┘
                                             │ HTTPS + JWT
                                             ▼
        ┌────────────────────────────────────────────────────────────────┐
        │                  Cloudflare Worker: medina-ventures-api        │
        │                  src/index.ts (router + scheduled())           │
        │   ─ Public: /health, /auth/*, /webhooks/{firefly,slack,outlook}│
        │   ─ Authed: /api/{contacts,companies,deals,documents,...}      │
        │   ─ Agent:  /api/agent/* (MARTy, SSE streaming)                │
        │   ─ Admin:  /api/admin/* (DLQ, backfills, embed queue, ...)    │
        └────┬───────────┬───────────┬───────────┬───────────┬───────────┘
             │           │           │           │           │
             ▼           ▼           ▼           ▼           ▼
        ┌────────┐ ┌──────────┐ ┌────────┐ ┌────────────┐ ┌──────────┐
        │   D1   │ │    R2    │ │   KV   │ │ Vectorize  │ │   AI     │
        │ medina-│ │ medina-  │ │ tokens │ │ medina-    │ │ Gateway  │
        │ ventures│ │ ventures│ │ idemp. │ │ ventures-  │ │ (Claude, │
        │ -db    │ │ -storage │ │ rate-l │ │ main (768) │ │  Gemini, │
        └────────┘ └──────────┘ └────────┘ └────────────┘ │ workersAI│
                                                          └──────────┘
             ▲           ▲
             │           │
        ┌────┴───────────┴─────────────────────────────────────────────┐
        │       Cloudflare Worker: medina-ventures-pipelines           │
        │       src/pipelines-index.ts  + src/workflows/*.ts           │
        │   ─ Workflows: ingestion, ingestion-chunk, ingestion-final,  │
        │                enrichment, campaign-send, daily-cron         │
        │   ─ Cron: minute tick (* * * * *) + hourly (0 * * * *)       │
        └──────────────────────────────────────────────────────────────┘

        Queues:  AUDIT_QUEUE → AUDIT_DLQ      (audit-log persistence)
                 WEBHOOK_QUEUE → WEBHOOK_DLQ  (firefly/slack/outlook intake)
```

### Subsystems

- **Universal work queue substrate** (`src/lib/work-queue.ts`, `work-queue-driver.ts`, `work-queue-handlers/`). A domain-typed durable job queue on top of D1 (`work_queue` table, migration `0083`). Used for `firefly-window`, `embed-retry`, `calendar-refresh`, `intelligent-import`, `deal-replay-evidence`, `marty-lab-experiment`. Three-tier retry with attempt-based escalation, claim leases, `deferWork` for cooperative resumption inside Workflow steps, dead-letter on terminal failure.
- **Ingestion workflows** (`src/workflows/ingestion.ts`, `ingestion-chunk.ts`, `ingestion-finalizer.ts`). Per-user, per-source backfill orchestrators (Outlook mail/calendar, Firefly transcripts, Slack history). Chunked progressive backfill with checkpointing in `sync_jobs`; finalizer reconciles after the last chunk completes.
- **Agent / MARTy** (`src/handlers/agent.ts`, `src/lib/agent.ts`, `src/lib/agent-tools.ts`, `src/prompts/`, `src/lib/retrieval.ts`, `src/lib/citations.ts`, `src/lib/citation-verifier.ts`). Claude-powered RAG agent with tool calling, SSE streaming, ACL-aware retrieval, mandatory citation verification. "God Mode" toggle (`src/prompts/god-mode.ts`) gives MARTy write tools (`agent_writes` table, migration `0077`).
- **Embed pipeline** (`src/lib/embedding.ts`, `src/lib/process-transcript-items.ts`, `src/lib/daily-cron.ts`). Workers AI 768-d embeddings into `medina-ventures-main` Vectorize index. Active Vectorize metadata indexes: `org_id`, `document_type`, `primary_entity_id`. Backfill via `backfillUnembedded` admin endpoint; retry via `embed-retry` work queue domain.
- **Integrations** (`src/integrations/{outlook,slack,firefly,reversecontact,news-search,oauth,outlook-send}.ts`). Outlook (Microsoft Graph), Slack (Bolt-style webhooks + Web API), Firefly (transcripts via HMAC-signed webhook + API backfill), ReverseContact (contact enrichment), News (Brave Search fallback), Outlook Send (campaigns).
- **Daily cron** (`src/lib/daily-cron.ts`, dispatched from `src/index.ts:scheduled()` and from the pipelines Worker). Runs enrichment ticks, embed-queue draining, calendar token health checks, system-status snapshot, work-queue dispatch.

## What to give a new engineer

Before they start, make sure a new engineer has all of the following. Missing any one of these will block a step in Local Setup.

1. **Repo access** — GitHub repository invite (read + write).
2. **`.dev.vars`** — a pre-filled copy with real secrets (all keys from `.env.example`). Do NOT send as plaintext over Slack/email; use 1Password or a secure secrets-share link.
3. **`frontend/.env.local`** — one line: `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787`.
4. **Cloudflare account invite** — Workers admin role on the team account. They'll create their own dev resources via `npm run bootstrap` after logging in.
5. **Vercel team access** — for frontend deploys (Settings → Members in the Vercel dashboard).
6. **Third-party dashboard logins** (7 items):
   - Anthropic console (for their own API key or team key)
   - Google AI Studio / Google Cloud console (Gemini)
   - Microsoft Entra portal (Azure AD app registration access)
   - Slack workspace admin (to install the dev app)
   - Firefly.ai account (per-user API key)
   - ReverseContact dashboard (API key)
   - Cloudflare AI Gateway dashboard (for `CLOUDFLARE_AI_GATEWAY_TOKEN`)
7. **Four feedback files** — these encode hard-won architectural lessons that are not in the repo. They live in the Claude project memory; share them manually until they are committed under `docs/feedback/`:
   - <!-- TODO: docs/feedback/feedback_hypothetical_trace_verification.md (content pending) -->
   - <!-- TODO: docs/feedback/feedback_cf_subrequest_cap.md (content pending) -->
   - <!-- TODO: docs/feedback/feedback_workflow_vs_waitUntil_lifetime.md (content pending) -->
   - <!-- TODO: docs/feedback/feedback_acl_layered_redaction.md (content pending) -->
   - `docs/feedback/feedback_vectorize_metadata_index.md` — already in repo ✓

## Prerequisites

- **Node**: 20.x. No `.nvmrc`; `@types/node` is `^20.14.0` and `frontend/package.json` engines is unset but tested on Node 20.
- **npm**: 10.x (ships with Node 20).
- **Wrangler**: `^4.85.0` (root `devDependencies`). Run via `npx wrangler` so you pick up the pinned version; do not install globally.
- **Cloudflare account** with Workers Paid plan (required for D1 production, R2, Queues, Vectorize, Workflows, AI Gateway, scheduled triggers). Sign up: https://dash.cloudflare.com/sign-up. You will need your **Account ID** (top of the dashboard sidebar).
- **Anthropic API key** for Claude (MARTy, classification, enrichment). https://console.anthropic.com.
- **Google AI Studio / Gemini API key** for Gemini 2.5 Flash enrichment. https://aistudio.google.com/app/apikey.
- **Microsoft Entra (Azure AD) app registration** for Outlook Mail + Calendar OAuth. https://entra.microsoft.com → Identity → Applications → App registrations. Scopes: `offline_access`, `Mail.Read`, `Calendars.Read`, `User.Read`, `MailboxSettings.Read`.
- **Slack app** (admin of a Slack workspace). https://api.slack.com/apps → Create New App. Scopes (bot): `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`, `users:read.email`, `team:read`. Event subscriptions for `message.channels`, `message.groups`.
- **Firefly account** with API access. https://fireflies.ai. Per-user API key, plus a webhook signing secret you choose.
- **ReverseContact** account. https://www.reversecontact.com. API key.
- (Optional) **Brave Search API key** for fallback web search inside MARTy. https://api-dashboard.search.brave.com/.

You do NOT need a separate Cloudflare AI Gateway account; the slug `medina-ventures` is configured via the AI Gateway dashboard inside your Cloudflare account (https://dash.cloudflare.com/?to=/:account/ai/ai-gateway). If you want metrics, create a gateway with that slug; otherwise change `CLOUDFLARE_AI_GATEWAY_SLUG` in `wrangler.toml`.

## Local setup

> Commands assume the repo root unless otherwise noted. The production database ID in `wrangler.toml` is the live database — do not run `migrate:remote` until you have your own database ID.

### Golden path (under 15 minutes)

```bash
git clone <repo-url> medina-ventures
cd medina-ventures
npm install
cd frontend && npm install && cd ..
npx wrangler login                    # authenticate with Cloudflare
npm run bootstrap                     # create D1, R2, KV, Vectorize, Queues
cp .env.example .dev.vars             # then fill in secrets (see step 5 below)
echo "NEXT_PUBLIC_API_URL=http://127.0.0.1:8787" > frontend/.env.local
npm run migrate:local                 # apply all migrations to local D1
npm run preflight                     # verify environment before first run
npm run dev                           # start api (port 8787) + frontend (port 3000)
```

After `npm run bootstrap`, paste the printed resource IDs into `wrangler.toml` and `wrangler.pipelines.toml` before continuing.

The detailed steps below explain what each phase does and what to watch for.

### 1. Clone and install

```bash
git clone <repo-url> medina-ventures
cd medina-ventures
npm install
cd frontend && npm install && cd ..
```

### 2. Authenticate Wrangler

```bash
npx wrangler login
npx wrangler whoami        # verify account
```

If `whoami` shows a different account than the one you want to deploy into, run `npx wrangler logout` and re-`login`.

### 3. Create Cloudflare resources

Run the bootstrap script — it detects existing resources by name and skips them (idempotent):

```bash
npm run bootstrap
# or: bash scripts/bootstrap-cloudflare.sh
# dry run first: bash scripts/bootstrap-cloudflare.sh --dry-run
# per-engineer namespace: bash scripts/bootstrap-cloudflare.sh --name-prefix yourname-
```

The script creates: D1, R2, KV, Vectorize index (768-dim cosine), and all four Queues. After creation it prints the exact lines to paste into `wrangler.toml` and `wrangler.pipelines.toml`.

> **Vectorize metadata indexes:** The bootstrap script creates three indexes (`org_id`, `document_type`, `primary_entity_id`) — these are the only fields the retrieval code currently passes to Vectorize as query filters. Three additional fields (`entity_type`, `is_org_wide`, `participant_user_ids`) appear in older planning docs but are not used as Vectorize filters today. See `docs/feedback/feedback_vectorize_metadata_index.md` for the architectural reason.
>
> **Important:** Cloudflare does not retroactively index vectors written before an index was created. If you add an index later, you must re-embed existing data via `POST /api/admin/backfill-unembedded`.

If you are working against the existing production resources (read-only or a hotfix), skip to step 5. The bootstrap script refuses to run against the production account ID (`ad54df3fe...`) without `--allow-production`.

### 4. Update `wrangler.toml` bindings

Edit `wrangler.toml` and `wrangler.pipelines.toml`:
- `CLOUDFLARE_ACCOUNT_ID` (under `[vars]`) → your account ID.
- `[[d1_databases]] database_id` and `preview_database_id` → your D1 ID.
- `[[kv_namespaces]] id` → your KV namespace ID.
- `ALLOWED_ORIGINS` and `FRONTEND_URL` if you are not deploying to `medinaventures.ai`.

The Vectorize, R2, AI, and Queue bindings reference by name only, so no edits needed if you used the names above.

### 5. Set secrets

Run these against the **api** Worker (which serves requests). The pipelines Worker reads the same set; repeat each `secret put` with `--config wrangler.pipelines.toml` for the pipelines Worker.

> **`TOKEN_ENCRYPTION_KEY` must be exactly 32 raw bytes, base64-encoded** (AES-GCM key for OAuth token storage). Generate with:
> ```bash
> openssl rand -base64 32
> ```
> Using a key shorter than 32 bytes will cause token decryption failures at runtime — the error will appear only when a user first connects an Outlook account.

```bash
# Auth
npx wrangler secret put JWT_SECRET                  # 32+ random bytes: openssl rand -base64 48
npx wrangler secret put TOKEN_ENCRYPTION_KEY        # exactly 32 raw bytes, base64-encoded: openssl rand -base64 32

# LLM providers
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_GEMINI_API_KEY       # optional, enables gemini enrichment path

# Microsoft Graph (Outlook mail + calendar)
npx wrangler secret put AZURE_CLIENT_ID
npx wrangler secret put AZURE_TENANT_ID             # tenant UUID
npx wrangler secret put AZURE_CLIENT_CERT_PRIVATE_KEY
npx wrangler secret put AZURE_CLIENT_CERT_THUMBPRINT
npx wrangler secret put OUTLOOK_SYSTEM_SENDER_EMAIL
# Optional when AZURE_REDIRECT_URI is local/http: public HTTPS base for Graph webhooks
npx wrangler secret put OUTLOOK_WEBHOOK_BASE_URL    # e.g. https://<worker>

# Slack
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN

# Firefly
npx wrangler secret put FIREFLY_WEBHOOK_SECRET      # HMAC-SHA256 secret you set in Firefly webhook config

# Enrichment
npx wrangler secret put REVERSECONTACT_API_KEY

# Cloudflare (required by pipelines Worker)
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_TOKEN  # dash → AI → AI Gateway → your gateway → API tokens
npx wrangler secret put CLOUDFLARE_API_TOKEN         # dash → My Profile → API Tokens → Workers:Edit

# Optional
npx wrangler secret put DEFAULT_SIGNUP_ORG_ID       # org UUID — run scripts/seed-default-org.sh first
npx wrangler secret put ALLOWED_SIGNUP_DOMAINS      # comma-separated email domains
```

Verify with `scripts/verify-secrets.sh`.

For local `wrangler dev`, secrets come from `.dev.vars` (gitignored). Create it from the template:

```bash
cp .env.example .dev.vars
$EDITOR .dev.vars   # fill in values
```

> **Warning:** Wrangler reads `.dev.vars`, not `.env.local`. If you have a `.env.local` at the repo root containing Worker secrets (not the frontend one at `frontend/.env.local`), rename it: `mv .env.local .dev.vars`. Running `npm run preflight` will detect this and warn you.

### 6. Frontend environment

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787
```

This is the only frontend env var (verified by grep). In production it is `https://medina-ventures-api.<account>.workers.dev` or your custom Worker route.

### 7. Apply migrations

```bash
# Local (writes to .wrangler/state)
npm run migrate:local

# Remote (writes to your D1 — destructive on production)
npm run migrate:remote
```

The `migrations/` directory is FK-ordered; `wrangler d1 migrations apply` runs them in lexical order. Latest applied in production: `0091_marty_lab.sql`. The file `cleanup_spam_contacts.sql` is a one-shot operational script, not a migration — do not apply it as part of the standard flow.

### 8. Run dev servers

> **`wrangler dev` runs in remote mode by default for this repo.** The `dev:api` script passes `--remote`, which means it talks to real Cloudflare D1/R2/KV/Vectorize backends using your dev credentials. `--local` mode does not work for Vectorize or AI Gateway. Every request against the API in dev hits live Cloudflare infrastructure — use your own dev resources (from `npm run bootstrap`), not the production ones.

```bash
npm run dev              # both API + frontend (concurrently)
# or run separately:
npm run dev:api          # wrangler dev --remote (port 8787)
npm run dev:web          # next dev (port 3000)
```

### 9. Verify

```bash
curl http://127.0.0.1:8787/health
# → {"ok":true,"env":"production"}
```

Then open http://localhost:3000, sign up (uses `DEFAULT_SIGNUP_ORG_ID` if set, otherwise restricted to `ALLOWED_SIGNUP_DOMAINS`), log in, navigate to `/god-mode`, and send a test message. If MARTy responds (even with "no results"), the agent + Claude + Vectorize wiring is correct.

## Environment variables and secrets

| Name | Where | Required | Purpose | Source |
|---|---|---|---|---|
| `ENVIRONMENT` | wrangler `[vars]` | yes | `production` / `development` | static |
| `CLOUDFLARE_ACCOUNT_ID` | wrangler `[vars]` | yes | account UUID for AI Gateway URLs | Cloudflare dashboard |
| `CLOUDFLARE_AI_GATEWAY_SLUG` | wrangler `[vars]` | yes | AI Gateway slug | dash → AI → AI Gateway |
| `GEMINI_MAX_RPM` | wrangler `[vars]` | yes | self-imposed Gemini throttle | static, default 500 |
| `ALLOWED_ORIGINS` | wrangler `[vars]` | yes | CORS allowlist (comma-separated) | static |
| `FRONTEND_URL` | wrangler `[vars]` | yes | canonical frontend URL for redirects | static |
| `DEFAULT_SIGNUP_ORG_ID` | secret | optional | org UUID assigned to self-signup | D1 `organizations.id` |
| `ALLOWED_SIGNUP_DOMAINS` | secret | optional | restrict signup to listed domains | static |
| `JWT_SECRET` | secret | yes | JWT signing key | `openssl rand -base64 48` |
| `TOKEN_ENCRYPTION_KEY` | secret | yes | AES-GCM key for OAuth token storage | `openssl rand -base64 32` (32-byte raw) |
| `ANTHROPIC_API_KEY` | secret | yes | Claude (MARTy, classification, enrichment) | console.anthropic.com |
| `GOOGLE_GEMINI_API_KEY` | secret | optional | Gemini 2.5 Flash enrichment | aistudio.google.com |
| `AZURE_CLIENT_ID` | secret | yes for Outlook | Microsoft Graph app id | Entra app registration |
| `AZURE_TENANT_ID` | secret | yes for Outlook | tenant UUID | Entra app |
| `AZURE_CLIENT_CERT_PRIVATE_KEY` | secret | yes for Outlook | PEM private key for app-only client assertion | certificate paired with Entra upload |
| `AZURE_CLIENT_CERT_THUMBPRINT` | secret | yes for Outlook | certificate SHA-1 thumbprint for JWT `x5t` | Entra certificate blade |
| `OUTLOOK_SYSTEM_SENDER_EMAIL` | secret | yes for campaign sends | mailbox used for system sends | in Exchange RBAC scope |
| `OUTLOOK_WEBHOOK_BASE_URL` | secret | local/optional | public HTTPS base for Graph subscription callbacks | e.g. Worker URL or HTTPS tunnel |
| `AZURE_REDIRECT_URI` | secret | delegated fallback only | OAuth callback URL | matches Worker route |
| `AZURE_CLIENT_SECRET` | secret | delegated fallback only | Microsoft OAuth fallback secret | Entra app → Certificates & secrets |
| `SLACK_CLIENT_ID` | secret | yes for Slack | OAuth client | api.slack.com → your app |
| `SLACK_CLIENT_SECRET` | secret | yes for Slack | OAuth client | api.slack.com → your app |
| `SLACK_SIGNING_SECRET` | secret | yes for Slack | webhook HMAC verification | Slack app → Basic Information |
| `SLACK_BOT_TOKEN` | secret | yes for Slack | `xoxb-...` bot token | Slack app → OAuth & Permissions |
| `FIREFLY_WEBHOOK_SECRET` | secret | yes for Firefly | webhook HMAC | you choose; set same in Firefly |
| `REVERSECONTACT_API_KEY` | secret | yes for enrichment | ReverseContact API | reversecontact.com → dashboard |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | secret | yes (pipelines Worker) | AI Gateway token for Gemini + Claude routing | dash → AI → AI Gateway → your gateway → API tokens |
| `CLOUDFLARE_API_TOKEN` | secret | yes (pipelines Worker) | Cloudflare API token for workflow state reconciler | dash → My Profile → API Tokens → Workers:Edit |
| `NEXT_PUBLIC_API_URL` | `frontend/.env.local` | yes | Worker base URL | local: `http://127.0.0.1:8787` |

Bindings (no secret, declared in `wrangler.toml`): `AI`, `D1`, `R2`, `KV`, `VECTORIZE`, `AUDIT_QUEUE`, `AUDIT_DLQ`, `WEBHOOK_QUEUE`, `WEBHOOK_DLQ`. After the planned Phase 8 strip-redeploy, the api Worker will also declare a `[[services]] PIPELINES` binding to invoke workflows on the pipelines Worker.

`.env.example` at the repo root lists all secrets. Use it as a template: `cp .env.example .dev.vars && $EDITOR .dev.vars`.

## Integration setup

### Microsoft Graph (Outlook mail + calendar)

1. Entra portal → Identity → Applications → App registrations → New registration.
2. Upload the public certificate to the app registration and copy the certificate SHA-1 thumbprint.
3. Grant Microsoft Graph application permissions required by the platform (`Mail.Read`, `Mail.Send`, `Calendars.Read`, `Contacts.Read`) and admin consent.
4. Configure Exchange RBAC for Applications so the service principal is scoped to the approved mailbox set.
5. `wrangler secret put` for `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_CERT_PRIVATE_KEY`, `AZURE_CLIENT_CERT_THUMBPRINT`, and `OUTLOOK_SYSTEM_SENDER_EMAIL`.
6. Set `OUTLOOK_AUTH_MODE=app_only` and `INTERNAL_DOMAINS=medinavc.com,medinacapital.com` in Worker vars.
7. Ensure Graph subscription callbacks resolve to a public HTTPS URL. If `AZURE_REDIRECT_URI` is local/http, set `OUTLOOK_WEBHOOK_BASE_URL=https://<public-worker-or-tunnel>`.
8. Verify: open Settings → System Status. Outlook App-Only Health should show Graph probes passing, all provisioned mailboxes, and 3/3 current subscriptions per mailbox.

### Slack

1. api.slack.com → Create New App → From scratch. Choose your workspace.
2. OAuth & Permissions → Bot Token Scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`, `users:read.email`, `team:read`.
3. Event Subscriptions → Enable → Request URL: `https://<worker>/webhooks/slack`. Subscribe to `message.channels`, `message.groups`.
4. Basic Information → copy Signing Secret. OAuth & Permissions → install to workspace → copy Bot User OAuth Token (`xoxb-...`).
5. `wrangler secret put` for `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`.
6. Verify: post a message in a watched channel; Worker logs (`npx wrangler tail`) show `webhook-intake-queue` enqueue → `webhook-consumer` process → row in `messages`.

### Firefly

1. fireflies.ai → Settings → Developer → grab a per-user API key.
2. Configure a webhook in Firefly pointing at `https://<worker>/webhooks/firefly`. Set an HMAC-SHA256 secret of your choice.
3. `wrangler secret put FIREFLY_WEBHOOK_SECRET` with the same value.
4. In the app, go to Settings → Firefly Credentials and enter the per-user API key (stored encrypted in D1 `user_firefly_credentials` per migration `0082`).
5. Verify: trigger a test webhook from Firefly, or use admin `POST /api/admin/firefly-progressive-backfill` with a date range to pull historical transcripts.

### ReverseContact

1. reversecontact.com → dashboard → API key.
2. `wrangler secret put REVERSECONTACT_API_KEY`.
3. Verify: hit `POST /api/contacts/:id/enrich` on a contact with an email; `enrichments` row appears, `companies` row may be created/updated.

### Anthropic (Claude)

1. console.anthropic.com → API Keys → Create. Set a billing limit.
2. `wrangler secret put ANTHROPIC_API_KEY`.
3. Verify: send a message via `/god-mode` UI or `POST /api/agent/sessions` then `POST /api/agent/sessions/:id/messages`. Streaming SSE response with citations confirms.

### Google Gemini (optional)

1. aistudio.google.com → Get API key.
2. `wrangler secret put GOOGLE_GEMINI_API_KEY`.
3. Verify: enrichment-tick logs show `gemini_*` calls succeeding; the System Status page shows Gemini capacity gauge populated.

## Development workflow

- **Branch model**: worktrees-based. Main is the deploy target. Feature branches live in `.claude/worktrees/<name>/`. Each worktree gets its own branch off `main`. Merge to `main` via PR (or direct commit for solo flows), then `wrangler deploy` and `git push origin main` to ship.
- **Typecheck**: `npm run typecheck` (strict TS). Must pass before deploy.
- **Tests**: none in the backend. Verification is via the production work queue + admin endpoints + `wrangler tail` + direct D1 queries.
- **Deploy**:
  ```bash
  npm run typecheck && npx wrangler deploy                                   # api Worker
  npx wrangler deploy --config wrangler.pipelines.toml                       # pipelines Worker
  git push origin main                                                       # triggers Vercel
  ```
  Per project discipline: "deploy" is not done until both `wrangler deploy` and `git push origin main` have completed.
- **Migrations**: numbered `NNNN_description.sql`. Never edit a shipped migration; add a new one. Production already has 0001-0091. New migrations go through `npm run migrate:local` first, then `npm run migrate:remote` after schema review. SQLite gotchas: FK targets are not validated at `CREATE TABLE`, so a typo (`REFERENCES orgs` instead of `organizations`) latches in silent until first INSERT under FK enforcement. ON CONFLICT against a partial UNIQUE index must reproduce the partial `WHERE` clause.
- **Audit-first discipline**: before changing a substrate (work queue, embed pipeline, ACL filter, retrieval), read the current state end-to-end. Verify hypotheses against live D1 with read-only queries before shipping. <!-- TODO: docs/feedback/feedback_hypothetical_trace_verification.md (content pending) -->
- **Cloudflare subrequest cap**: a single Worker step can issue at most ~50 subrequests on the paid plan; chunk-parallelism handlers like classify-batch are pinned at ≤10 items/step. <!-- TODO: docs/feedback/feedback_cf_subrequest_cap.md (content pending) -->

## Key subsystems

### Universal work queue substrate
- `src/lib/work-queue.ts` — enqueue, claim, complete, fail, defer.
- `src/lib/work-queue-driver.ts` — domain-dispatching worker, called from `daily-cron.ts` and pipeline scheduled().
- `src/lib/work-queue-handlers/{calendar-refresh,deal-replay-evidence,embed-retry,firefly-window,intelligent-import,marty-lab-experiment}.ts` — one file per domain.
- Schema: `work_queue` (migration `0083`), `0084` (embed-retry), `0085` (FK fix), `0086` (firefly-windows).
- Exercise: `POST /api/admin/process-embed-queue`, `GET /api/admin/embed-queue-health`, or via daily cron.

### Ingestion workflows
- `src/workflows/ingestion.ts` — orchestrator: fan-out per source per user.
- `src/workflows/ingestion-chunk.ts` — chunked per-source backfill.
- `src/workflows/ingestion-finalizer.ts` — runs once the last chunk completes.
- Triggered by admin `/api/admin/trigger-ingestion` or by daily cron observing `sync_jobs` rows with `status='pending'`.
- Class definitions live in `src/workflows/`; declarations live in `wrangler.pipelines.toml`.

### Agent / MARTy
- `src/handlers/agent.ts` — HTTP entry, SSE streaming.
- `src/lib/agent.ts` — main loop, tool dispatch, citation enforcement.
- `src/lib/agent-tools.ts` — read tools (retrieval, lookups) + God Mode write tools.
- `src/lib/retrieval.ts` — vectorize query, ACL filter, rerank.
- `src/lib/citations.ts` + `src/lib/citation-verifier.ts` — citation parsing and post-hoc verification.
- `src/prompts/{god-mode,reranker,session-title}.ts` — prompt constants.
- Cancellation: `src/lib/agent-cancellation.ts`. Tables: `agent_writes` (0077), `agent_message_verifications` (0087).

### Embed pipeline
- `src/lib/embedding.ts` — Workers AI bge-base-en-v1.5 wrapper.
- `src/lib/process-transcript-items.ts` — transcript chunking + embedding.
- `src/lib/chunking.ts` — langchain-style splitter (used as a util only — see `BUILD-PROMPT.md` "no LangChain at runtime" rule; the package is a build-only dep for the splitter constants).
- `src/lib/daily-cron.ts` — embed branches: `backfillUnembedded`, dual-write reconciler.
- Vectorize metadata indexes are mandatory; see step 3 of local setup.

### Integrations
- `src/integrations/outlook.ts` — Microsoft Graph delta queries, subscription management. `src/integrations/outlook-send.ts` — outbound send for campaigns.
- `src/integrations/slack.ts` — Web API + webhook verification.
- `src/integrations/firefly.ts` — webhook intake + API backfill.
- `src/integrations/reversecontact.ts` — enrichment HTTP client.
- `src/integrations/news-search.ts` — Brave Search fallback for agent web-search.
- `src/integrations/oauth.ts` — generic OAuth helpers.

### Migrations
- `migrations/0001` → `0091` plus `cleanup_spam_contacts.sql` (one-shot, not auto-applied).
- Convention: `NNNN_snake_case_description.sql`. Two files can share a prefix (e.g. `0076_deal_intelligence_brief_summary.sql` + `0076_efs_human_edit_user_id.sql`) — `wrangler d1 migrations apply` runs them in lexical order, so disambiguate with the suffix.
- After applying, the `d1_migrations` table records the applied filename; check with `npx wrangler d1 execute medina-ventures-db --remote --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 5"`.

## Common tasks

### Add a new migration
```bash
npx wrangler d1 migrations create medina-ventures-db <description>
# edit the generated file in migrations/
npm run migrate:local         # test
npm run typecheck             # if you renamed columns referenced in src/
npm run migrate:remote        # ship
```

### Add a new work queue domain
1. Add a handler file: `src/lib/work-queue-handlers/<domain>.ts` exporting `handle<Domain>(env, payload)`.
2. Register in `src/lib/work-queue-driver.ts` (the dispatch switch).
3. Enqueue from callers via `enqueueWork(env, { domain: '<domain>', payload })`.
4. If the domain has its own table (rare; most use `work_queue` directly), add a migration.

### Add a new integration
1. Module: `src/integrations/<name>.ts` (HTTP client + signature helpers).
2. Secrets: add to "Environment variables and secrets" table and `wrangler secret put`.
3. OAuth (if any): route in `src/index.ts` for `/auth/<name>` + `/auth/<name>/callback`.
4. Webhook (if any): route in `src/index.ts` for `/webhooks/<name>` → push to `WEBHOOK_QUEUE` with `source: '<name>'`.
5. Consumer: extend `src/workers/webhook-consumer.ts` switch.
6. Schema: `integration_credentials.provider` enum + per-source tables as needed.

### Debug a stuck ingestion run
```bash
# Inspect sync_jobs state
npx wrangler d1 execute medina-ventures-db --remote --command \
  "SELECT id,user_id,source,status,started_at,last_heartbeat_at,last_error FROM sync_jobs ORDER BY started_at DESC LIMIT 20"

# Workflow instance status (read the cf_instance_id from above)
npx wrangler workflows instances describe ingestion-workflow <instance-id> --config wrangler.pipelines.toml

# Force-reset a stalled job
npx wrangler d1 execute medina-ventures-db --remote --command \
  "UPDATE sync_jobs SET status='pending', last_heartbeat_at=NULL WHERE id='<job-id>'"
```

### Inspect work_queue state in production
```bash
npx wrangler d1 execute medina-ventures-db --remote --command \
  "SELECT domain, status, COUNT(*) FROM work_queue GROUP BY domain, status ORDER BY domain"
```

### Trigger a manual backfill for one user
```bash
curl -X POST https://<worker>/api/admin/trigger-ingestion \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>","source":"outlook_mail","from":"2024-01-01","to":"2024-12-31"}'
```

### Roll back a deploy
```bash
# Worker: redeploy a previous git ref
git checkout <sha> -- src wrangler.toml
npx wrangler deploy
git checkout main -- src wrangler.toml

# Migrations are forward-only — write a new migration to undo a schema change.
# Frontend (Vercel): use the dashboard to promote a previous deployment.
```

## Troubleshooting

- **`Authentication error` from wrangler** — token expired. `npx wrangler logout && npx wrangler login`. Wrangler tokens have been observed to drop silently at UTC midnight; long-running background watches that span 00:00Z go blind. Prefer short pre-midnight watches.
- **Migration apply fails** — check that `REFERENCES <table>` matches the actual table name (org table is `organizations`, not `orgs`). Check that any `ON CONFLICT(...)` against a partial unique index reproduces the partial `WHERE` clause; otherwise SQLite emits `does not match any UNIQUE constraint`.
- **MARTy not retrieving recent X** — check `DOC_TYPE_KEYWORDS` in `src/lib/retrieval.ts`; check embed coverage on `/admin` System Status; verify the Vectorize metadata index for the field you are filtering on (filtered queries silently return 0 if the index is missing OR if vectors were inserted before the index was created — see `docs/feedback/feedback_vectorize_metadata_index.md`).
- **`subrequest limit hit` in Worker logs** — a handler is fanning out too many calls per step. Batch sizes for classify/extract/embed are capped at ≤10 items/step.
- **D1 transient errors during dual-write** — when writing to two tables in the same step, follow the established ordering (parent before child; vector index after D1 commit). Don't introduce new dual-writes without re-reading `src/lib/persist-document.ts`.
- **Embed pipeline coverage gap** — `POST /api/admin/backfill-unembedded` (chunked, idempotent). Track progress via `GET /api/admin/embed-queue-health`.
- **Graph subscription creation fails** — Microsoft Graph requires an HTTPS notification URL. Set `OUTLOOK_WEBHOOK_BASE_URL` to a public HTTPS Worker or tunnel URL for local validation.
- **OAuth redirect mismatch** — only relevant when delegated fallback is explicitly enabled. `AZURE_REDIRECT_URI` must EXACTLY match the redirect URI registered in Entra.
- **Slack signature verification fails** — `SLACK_SIGNING_SECRET` is the Basic-Information signing secret, not the OAuth client secret. Easy to mix up.
- **Firefly webhook returns 401** — `FIREFLY_WEBHOOK_SECRET` in `wrangler secret` must equal the secret you entered in Firefly's webhook configuration; both are HMAC-SHA256.
- **`waitUntil` task disappears mid-run** — Cloudflare provides no lifetime guarantees for `waitUntil` work; the app-side stale-reset + watchdog is the only cleanup. Don't put critical-path work in `waitUntil`. <!-- TODO: docs/feedback/feedback_workflow_vs_waitUntil_lifetime.md (content pending) -->

## Operational endpoints

- `GET /health` — Worker liveness.
- `GET /api/admin/system-status` — Worker + pipeline + queue + embed-coverage snapshot. Backs the Settings → System Status UI.
- `GET /api/admin/embed-queue-health` — embed backlog.
- `POST /api/admin/process-embed-queue` — drain one batch.
- `GET /api/admin/calendar-token-health` — token expiry status.
- `POST /api/admin/run-daily-cron` — invoke daily cron logic manually (idempotent).
- `GET /api/admin/dlq` / `POST /api/admin/dlq/:id/replay` / `POST /api/admin/dlq/:id/discard` — DLQ inspection + replay.
- `POST /api/admin/trigger-ingestion` — kick a date-range ingestion.
- `POST /api/admin/firefly-progressive-backfill` (+ `GET`, `/cancel`) — Firefly historical pull.
- `POST /api/admin/progressive-backfill` (+ `GET`) — generic per-user progressive backfill (Outlook).
- `POST /api/admin/repair-vectorize-participants`, `/repair-acl-metadata`, `/cleanup-transcript-acl` — ACL backfill helpers.
- `POST /api/admin/reembed-transcripts`, `/embed-all-deals`, `/backfill-unembedded`, `/backfill-attachments`, `/cleanup-vector-bloat` — embed-pipeline tools.
- `POST /api/admin/sweep-approval-queue` — re-evaluate held approvals.
- `GET|POST /api/admin/marty-lab` (+ `/runs/:id`, `/runs/:id/cancel`) — MARTy human-conversation lab.

Full list is in `src/index.ts` under the `/api/admin/` block; all require owner/admin role via `requireRole`.

## Production deploy

- **Worker (api)**: `medina-ventures-api`, account `ad54df3fe69483d2c0b69be1b72864e8`. Deploy: `npx wrangler deploy`.
- **Worker (pipelines)**: `medina-ventures-pipelines`. Deploy: `npx wrangler deploy --config wrangler.pipelines.toml`.
- **D1**: `medina-ventures-db`, ID `4bb3705c-c471-43f7-b42f-b44ab62f5dab`.
- **R2**: `medina-ventures-storage`.
- **Vectorize**: `medina-ventures-main` (768-d cosine).
- **Frontend**: Vercel, deploy on push to `origin/main`. Live at https://medinaventures.ai.
- **Discipline**: a deploy is not done until BOTH `npx wrangler deploy` (and `wrangler deploy --config wrangler.pipelines.toml` if pipelines changed) AND `git push origin main` (Vercel) have completed. Wrangler ships the Worker from local files; Vercel needs the git push.

## Glossary

- **MARTy** — the platform's RAG agent. Claude-powered, runs in `src/lib/agent.ts`, exposed at `/api/agent/*`.
- **God Mode** — MARTy's write capabilities. When toggled, the agent gains write tools (create contact, log task, etc.) gated by user role; all writes append to `agent_writes`.
- **Work queue substrate** — generic D1-backed durable job system (`work_queue` table). Replaces ad-hoc cron+poll patterns. See "Key subsystems" above.
- **Domain** — in work-queue context, the string discriminator that routes a `work_queue` row to its handler (`firefly-window`, `embed-retry`, etc.).
- **Three-tier retry** — work queue retry policy: immediate retry → backed-off retry → dead-letter, with per-tier attempt budgets.
- **deferWork** — cooperative resume primitive: a Workflow step that exceeds its time budget reschedules itself via the work queue rather than failing the step.
- **Dead-letter** — a row moved to terminal-failure state after exhausting retries; surfaced via `/api/admin/dlq` (queue DLQs) or `work_queue` rows with `status='dead'`.
- **ACL** — access control. In this codebase: a chunk/document is `is_org_wide=1` (everyone in org sees it) or has a non-empty `participant_user_ids` list (only those users + owner role see it). Enforced at retrieval filter (Vectorize) AND tool filter (post-filter on returned chunks) — both layers are required. <!-- TODO: docs/feedback/feedback_acl_layered_redaction.md (content pending) -->
- **Email Privacy v3.0** — the policy that email content is participant-private even though metadata is org-shared. Implemented via `participant_user_ids` ACL.
- **Phase 6 / 6.1 / 8** — resilience-overhaul phases. Phase 6 introduced the universal work queue. Phase 6.1 hardened circuit breakers. Phase 8 (in progress) splits Workflow class ownership onto a second Worker (`medina-ventures-pipelines`).
- **Substrate vs handler** — a debugging distinction: structural state (job rows, queue depths, transition counts) can be green while handler-level diagnostics (last_error, heartbeat, response shape) silently regress. Always probe both layers.
- **Pipelines Worker** — the second Worker (`medina-ventures-pipelines`) that owns Workflow class definitions and the cron triggers. Lives at `src/pipelines-index.ts` + `wrangler.pipelines.toml`.

## References

- Technical Requirements Document: `medina-ventures-trd-v3.0-final.md`.
- Frontend specification: `medina-ventures-frontend-spec-v3.md`.
- Build history: `BUILD-PROMPT.md`, `BUILD-STATUS.md`.
- Deal intelligence contract: `docs/deal-intelligence-contract.md`.
