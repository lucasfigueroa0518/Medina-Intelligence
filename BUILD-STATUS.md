# Build Status — Medina Ventures Intelligence Platform v3.0

**Typecheck:** `npx tsc --noEmit` passes with 0 errors on the backend.

## What's built

### Phase 1 — Foundation
- 30 D1 migrations in FK-correct order (`migrations/0001-0030`)
- `Env` interface with all bindings + secrets (TRD §2.3)
- Full type system in `src/types/`: env, audit, webhooks, interfaces
- All shared utilities in `src/lib/`: tokens, audit, helpers, claude, file-extraction, encryption, rate-limit, cache, chunking (with speaker-turn chunker + dynamic overlap), embedding, hydration (3-tier KV→R2→preview), retrieval (split + entity boost + rerank + token budget), classification (with cross-user dedup + Vectorize re-upsert), discovery, reconciliation (phase-2 reschedule heuristic), dedup (blocking keys), merge (atomic batch + lock guard + vector cleanup), enrichment (multi-source + sanitized embeddings), extraction (LLM signals + idempotency), associations, daily-cron, variables, idempotency, stage-approvals
- JWT auth middleware + tenant isolation (`handlers/auth.ts`)
- CRUD handlers for contacts, companies, deals, events, conversations, tags, tasks, documents
- Main Worker entry (`src/index.ts`): router, cron dispatch, queue dispatch

### Phase 2 — Integrations & Sync
- Microsoft Graph OAuth + email delta sync (with dead-token skipping + backfill)
- Calendar delta sync + event upsert (with ON CONFLICT)
- Slack OAuth bot token flow + message sync + signature verification
- Webhook endpoints (Firefly + Slack) → queue intake → DLQ
- Idempotency key extraction
- Intake classification with email privacy (participant_user_ids populated, Vectorize re-upsert on add)
- New contact discovery from email with personal-domain filtering
- Approval queue with idempotency_key UNIQUE index
- `IngestionWorkflow` (7 steps, concurrency guard, timeout recovery)
- `EnrichmentWorkflow` (batched 10 entities/step)
- Daily cron (9 operations, each try/catch'd)
- Duplicate detection (5 blocking-key types + Jaro-Winkler)
- Event reconciliation (±15 min phase 1, ±24h reschedule phase 2)
- Contact merge (12-table atomic batch, merge chain resolution up to depth 5)
- Auto-link associations (co-meeting / co-email)

### Phase 3 — RAG & God Mode
- Embedding pipeline with chunk config registry (v1/v2)
- Speaker-turn-aware chunking with dynamic overlap (1/2/3 turns)
- KV chunk store with 90-day backfill TTL
- 3-tier hydration: KV → R2 re-chunk → preview
- Split retrieval (internal topK 30 + news topK 10) with entity dual-query + boost
- Cross-encoder rerank with cosine fallback (4 failure modes)
- Dynamic token budget (63k retrieved + 20k upload, rebalances when doc uploaded)
- D1-based cache invalidation (strongly consistent)
- Claude rate limiter with priority bands (high/low, RPM configurable)
- God Mode: sessions, SSE streaming, entity scoping, ephemeral doc upload, auto-title
- RAG observability (rag_query_logs + R2 traces)
- All 7 LLM prompts (god-mode, reranker, extraction, enrichment, classification, session-title, import-mapping)

### Phase 4 — Enrichment
- ReverseContact/LinkedIn with identity disambiguation (composite scoring, 0.8 threshold)
- Enrichment web search via Claude (identity anchoring rule)
- Multi-source enrichment pipeline with sanitized embeddings (P-2 fix)
- LLM extraction with sanitized contributions (no body leakage)
- Firefly webhook handler with HMAC-SHA256 verification
- Standalone promotion (48h with ID / 72h without ID + transcript)
- Orphan flagging (7-day threshold)

### Phase 5 — Email Campaigns
- `CampaignSendWorkflow` with step-per-recipient (durable replay)
- 429 retry handling (step.sleep + throw for retry, not permanent failure)
- Campaign builder API endpoints
- Variable resolution (`{{full_name}}`, `{{first_name}}`, `{{company_name}}`, `{{job_title}}`, `{{custom.field}}`)
- Merge lock check in recipient list builder
- Recipient list from ContactFilter

### Phase 6 — Frontend
- Next.js 14 App Router project in `frontend/`
- Design system: Tailwind config with exact TRD colors, DM Sans + Instrument Serif, brand gradient
- App shell: sidebar, top bar, admin badge
- Shared components: DataTable (sortable, skeleton loading, empty state), FilterPanel (collapsible sections), Timeline (with email privacy restricted entries + lock icon), TopBar
- Pages: Contacts (list + detail with tabs), Companies (list + detail), Deals (kanban), God Mode (chat + SSE streaming + sessions sidebar + prompt suggestions), Campaigns, Admin (4 tabs), Settings, Imports (wizard)
- Email privacy rendering: `canReadContent` flag gates body previews in timeline
- Typed API client in `lib/api.ts` with streaming agent query helper

### Phase 7 — Polish
- Import flow with LLM column mapping (CSV parse + Claude pre-mapping)
- Admin dashboard: DLQ viewer, enrichment status, sync status, approval queue
- Error handling audit: all codes from §15.1 thrown in handlers
- **Typecheck passes with 0 errors.**

## Known limitations / TODOs

1. **`wrangler.toml` is locked but incomplete.** The file in the repo only declares D1, R2, KV, Vectorize, and AI bindings. The code targets the full `Env` interface from TRD §2.3 which also requires `[[workflows]]`, `[[queues.producers]]`, `[[queues.consumers]]`, `[triggers] crons`, and `compatibility_flags = ["nodejs_compat"]`. Before running `npx wrangler deploy`, the user must unlock `wrangler.toml` and add the missing bindings as specified in TRD §2.2. Until then, `wrangler deploy --dry-run` will fail because it binds against the current incomplete config.

2. **Secrets.** Run `wrangler secret put` for each of: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_REDIRECT_URI`, `ANTHROPIC_API_KEY`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `REVERSECONTACT_API_KEY`, `FIREFLY_WEBHOOK_SECRET`, `TOKEN_ENCRYPTION_KEY`, `JWT_SECRET`. Values are in `.env.local`.

3. **Queues.** Create the Cloudflare Queues in the dashboard (or `wrangler queues create`) before first deploy: `audit-log-queue`, `audit-log-dlq`, `webhook-intake-queue`, `webhook-dlq`.

4. **Workflows.** Cloudflare Workflows must be enabled on the account. The `Workflow` type shim in `src/types/env.ts` is a minimal type — the runtime binding comes from the Cloudflare runtime.

5. **Frontend deps** not installed yet. Run `cd frontend && npm install` when ready to run the dev server. The pages are built but untested in a browser (per guidance in system prompt).

## How to run

```bash
# Install backend deps (already done)
npm install

# Typecheck
npx tsc --noEmit    # passes cleanly

# Apply migrations locally
npm run migrate:local

# Start Worker dev server (after unlocking wrangler.toml)
npm run dev

# Frontend
cd frontend
npm install
npm run dev    # http://localhost:3000
```

## File count summary

- 30 SQL migrations
- ~50 TypeScript files in `src/` (types, handlers, lib, integrations, workflows, workers, prompts)
- ~20 React/TypeScript files in `frontend/` (components, pages, lib)
- All TRD function signatures and type names preserved.
