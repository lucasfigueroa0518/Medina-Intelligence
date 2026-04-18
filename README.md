# Medina Ventures Intelligence Platform

Cloudflare-native VC CRM with God Mode AI agent, auto-sync engine, and RAG pipeline.

## Structure

- `src/` — Cloudflare Workers API (TypeScript)
- `migrations/` — D1 schema migrations (FK-ordered)
- `frontend/` — Next.js 14 App Router UI
- `medina-ventures-trd-v3.0-final.md` — Technical Requirements Document (sole authority)
- `medina-ventures-frontend-spec-v3.md` — Frontend Specification

## Setup

```bash
npm install
npm run migrate:local       # apply migrations locally
npm run deploy:dry          # verify build
```

## Infrastructure Notes

`wrangler.toml` in this repo is locked. The TRD §2.2 specifies additional bindings (Workflows, Queues, Cron Triggers) that need to be added before a full deploy — the code targets the `Env` interface in `src/types/env.ts` which matches TRD §2.3.

Required additions before `wrangler deploy`:
- `[[workflows]]` blocks for `IngestionWorkflow`, `EnrichmentWorkflow`, `CampaignSendWorkflow`
- `[[queues.producers]]` / `[[queues.consumers]]` for `audit-log-queue`, `audit-log-dlq`, `webhook-intake-queue`, `webhook-dlq`
- `[triggers] crons = ["*/20 * * * *", "5 * * * *", "0 0 * * *"]`
- `compatibility_flags = ["nodejs_compat"]`

See TRD §2.2 for the complete `wrangler.toml` reference.

## Architecture

Three product modules on a unified Cloudflare stack:
1. **Intelligent CRM** — contacts, companies, deals, tags, tasks, documents
2. **God Mode Agent** — RAG-powered chat over firm data with SSE streaming
3. **Auto-Sync Engine** — dual-workflow architecture (Ingestion + Enrichment) with durable checkpointing

## Email Privacy (v3.0)

Metadata is shared, content is private. The `participant_user_ids` field gates email content access at 4 layers: API responses, Vectorize chunk filtering, timeline rendering, and approval queue evidence. Owner role bypasses. Slack/meetings/campaigns are org-wide.
