# Medina Ventures Intelligence Platform — Build Prompt

You are building the Medina Ventures Intelligence Platform from scratch. This is a Cloudflare-native VC CRM with an AI agent (God Mode), auto-sync engine, and RAG pipeline.

## Source of Truth

There are two specification documents in this project folder. Read BOTH completely before writing any code:

1. `medina-ventures-trd-v3.0-final.md` — The Technical Requirements Document. 31,926 words. Contains every schema, API endpoint, integration contract, Workflow implementation, LLM prompt, edge case, and helper function. This is the SOLE authority. Do not deviate from it.

2. `medina-ventures-frontend-spec-v3.md` — The Frontend Specification. 8,514 words. Contains the design system, component specs, page layouts, interaction states, and responsive behavior. Companion to the TRD.

## Infrastructure (Already Configured — Do NOT Modify)

- `wrangler.toml` is in this folder and is LOCKED. Do not change it.
- `.env.local` is in this folder and is LOCKED. Do not change it.
- All Cloudflare resources are provisioned: D1 (medina-ventures-db), R2 (medina-ventures-storage), KV, Vectorize (medina-ventures-main, 768-dim, cosine), AI Gateway (medina-ventures).
- All API keys are obtained and stored as wrangler secrets.

## Build Order

Follow the Implementation Roadmap in TRD §17 exactly. Build phase by phase, and after each phase, run `npx wrangler deploy --dry-run` to verify the build compiles. Fix all TypeScript errors before moving to the next phase.

### Phase 1 — Foundation (do this first)
- Initialize the project: `npm init`, install dependencies (`@langchain/textsplitters`, `pdf-parse`, `mammoth`), set up `tsconfig.json`.
- Create the full directory structure from TRD §22.
- Write all D1 schema migrations from TRD §3 in the order specified in §20 (Appendix C). Run them with `wrangler d1 execute`.
- Implement the `Env` interface (§2.3), all type definitions (§types/), and all shared utilities (§18 — tokens, audit, helpers, claude, file-extraction, encryption, rate-limit, cache, chunking, embedding, hydration, retrieval, classification, discovery, reconciliation, dedup, merge, enrichment, extraction, associations, daily-cron, variables, idempotency).
- Implement the main Worker entry point (`src/index.ts`) with the router, cron handler, and queue consumers.
- Implement JWT auth middleware and tenant isolation.
- Implement Contact, Company, Deal, Tag, Task CRUD handlers (§5.1, §11).

### Phase 2 — Integrations & Sync
- Implement Microsoft Graph OAuth flow + email delta sync (§6.1).
- Implement calendar delta sync + event upsert (§7.4).
- Implement Slack message sync (§6.2).
- Implement webhook endpoints + queue intake + DLQ (§5.2).
- Implement intake classification with email privacy (§7.2) — including `participant_user_ids` population and cross-user email dedup.
- Implement new contact discovery (§7.3).
- Implement approval queue with idempotency (§3.16).
- Implement IngestionWorkflow (§7.1 Workflow A).
- Implement EnrichmentWorkflow (§7.1 Workflow B).
- Implement daily cron (§7.1).
- Implement duplicate detection (§7.5), event reconciliation with Phase 2 reschedule heuristic (§7.4), and contact merge (§7.6).
- Implement auto-link associations (§7.9).

### Phase 3 — RAG & God Mode
- Implement the full embedding pipeline with chunk config registry (§4).
- Implement speaker-turn-aware chunking with dynamic overlap (§4.2).
- Implement KV chunk store with 3-tier hydration fallback (§4.3).
- Implement split retrieval: internal + news with entity boosting (§8.3).
- Implement the cross-encoder re-ranker with cosine fallback (§8.4).
- Implement dynamic token budget + context assembly (§8.5).
- Implement D1-based cache invalidation (§8.6).
- Implement the Claude rate limiter with configurable RPM and priority bands (§5.3).
- Implement God Mode: sessions, streaming SSE, document upload, entity scoping (§9).
- Implement RAG observability (§8.7).
- Write all 7 LLM prompt constants (§16).

### Phase 4 — Enrichment
- Implement ReverseContact/LinkedIn integration with identity disambiguation (§6.4).
- Implement enrichment web search via Claude (§6.5).
- Implement multi-source enrichment pipeline with sanitized embeddings (§7.7).
- Implement LLM extraction with sanitized contributions (§7.8).
- Implement Firefly webhook handler (§6.3).
- Implement standalone promotion timers (§7.4).

### Phase 5 — Email Campaigns
- Implement CampaignSendWorkflow with step-per-recipient and proper 429 retry handling (§12.2).
- Implement campaign builder API endpoints.
- Implement variable resolution (§12.1).

### Phase 6 — Frontend
- Set up Next.js 14 App Router project in `frontend/`.
- Implement the design system (colors, typography, buttons) from Frontend Spec §1.
- Implement the app shell: sidebar navigation, top bar, command palette (Frontend Spec §2).
- Build shared components: DataTable, FilterPanel, Timeline, EntityHeader, StatRow, TabBar, Modal, Toast (Frontend Spec §3).
- Build all pages: Contacts, Companies, Deals, God Mode, Campaigns, Admin, Settings, Imports (Frontend Spec §4-11).
- Implement email privacy in timelines: restricted entries with lock icon for non-participants (Frontend Spec §3.3).
- Implement approval queue evidence gating for private email sources (Frontend Spec §9.7).
- Implement responsive breakpoints and mobile behavior (Frontend Spec §12).
- Implement keyboard shortcuts (Frontend Spec §13).

### Phase 7 — Polish
- Import flow with LLM column mapping (§16.7).
- Admin dashboard: DLQ viewer, enrichment status, orphan events, audit log, sync status.
- Error handling audit — verify every error code in §15.1 is thrown and caught correctly.
- Run `wrangler deploy --dry-run` one final time. Fix any remaining issues.

## Critical Implementation Rules

1. **Read the TRD section BEFORE implementing each feature.** The TRD contains edge case reasoning, code samples, and architectural decisions that will prevent bugs.

2. **Email Privacy (v3.0):** Every email-related feature must respect the privacy model. Metadata is shared, content is private. `participant_user_ids` gates access at 4 layers: API responses, Vectorize chunk filtering, timeline rendering, and approval queue evidence. Owner role bypasses. Slack/meetings/campaigns are org-wide. LLM extraction runs on all emails but enrichment embeddings use `sanitized_text`. Cross-user email dedup must update Vectorize metadata.

3. **Idempotency:** All D1 writes inside `step.do()` must use `INSERT OR IGNORE` or equivalent idempotency guards. Workflow steps can replay after checkpoint failures.

4. **No LangChain.** Direct Cloudflare API calls only. The only LangChain dependency is `@langchain/textsplitters` for `RecursiveCharacterTextSplitter`.

5. **Audit everything.** Every create, update, delete, merge, approve, reject, and campaign send must emit an audit event via the queue. Audit `before_data`/`after_data` must never include email body content.

6. **The `wrangler.toml` and `.env.local` are LOCKED.** Do not modify them. All secrets are already configured.

7. **Use the exact function signatures, interface names, and type definitions from the TRD.** The document is the build spec — implement what it says, not what seems easier.

Build it.
