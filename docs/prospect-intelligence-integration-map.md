# Prospect Intelligence Phase 0 Integration Map

Verified: 2026-05-30
Branch: `codex/prospect-intel-phase2a-hardening`

This is the Phase 0 read-only integration artifact required by the Prospect Intelligence TRD section 11. It records the current repo bindings for the prospect intelligence layer and the REQ-INT integration points. It does not claim that the feature is production-enabled: migration `0114_prospect_intelligence.sql` is still pending on remote D1, the human gold set does not exist yet, and the Phase 2a GO/NO-GO gate has not run.

## Locked Contract

- Prospects never route to a review queue. Uncertainty is stored as recoverable metadata (`provisional`, `direction_uncertain`, `uncategorized`, soft duplicate/deal links, failed/pending classification state) and is resolved by deterministic reconciliation. This binds to `REQ-AR-*`.
- There is no `thesis_score` or `thesis_band`. Enrichment priority and default surfacing use deterministic `signal_strength`, sector filtering, and recency. This binds to `REQ-SS-*`.
- Graduation link lives on `prospects.deal_id`, indexed for reverse lookup. The `deals` table is not modified by Prospect Intelligence. This binds to the reconciled `REQ-DP-3`.
- The deterministic signal identity key is `(org_id, source_type, source_id, mention_ordinal)`, with `span_start`/`span_end` stored as the tie-stable raw-text anchor. This binds to `REQ-ID-1`.

## D1 Schema

Existing core tables used by this build:

- `deals`: defined by the existing migrations, with the conservative one-open-deal-per-company contract in `migrations/0088_deals_conservative_contract.sql`. The open-deal uniqueness index is `uniq_deals_open_per_company` on `(org_id, company_id)` where `deleted_at IS NULL AND stage != 'closed'`. Prospect Intelligence must not weaken this firewall (`REQ-INT-8`).
- `companies`: existing CRM entity table. Prospect matching reads company name/domain and relationship state; prospect graduation may set company verification state when that path is implemented, but no deal-table mutation is required.
- `firm_company_relationships`: used as the small high-signal known portfolio/pipeline set for classifier context.
- `dealmakers`: added by `migrations/0114_prospect_intelligence.sql`, with `org_id`, contact/email/name/domain fields, `dealmaker_type`, warmth, and first/last seen timestamps.
- `entity_field_state`: existing authority/provenance ledger, rebuilt by `0114` to widen `entity_type` to include `prospect` while preserving current rows. The unique key remains `(entity_type, entity_id, field_name)`.
- `agent_writes`: existing audited write log used by `src/lib/entity-writes.ts`.
- `vector_entity_index`: existing D1 sidecar for Vectorize records, written by `src/lib/ingestion-shared.ts` after `chunkEmbedAndPersistAll`.
- `embed_retry_queue` / work queue tables: existing retry path for embeddings and background work. Prospect Intelligence does not create a separate embedding pipeline.

Prospect Intelligence tables from `0114`:

- `prospect_sectors`: top-tier sector keys and labels.
- `prospects`: canonical metadata-only prospect rows. Key fields include `canonical_name`, `normalized_name`, `domain`, `company_id`, `deal_id`, `status`, `visibility`, `sector_key`, `signal_count`, `evidence_count`, `signal_strength`, `signal_strength_reasons`, `enrichment_priority`, `confidence`, `provisional`, `direction_uncertain`, `possible_duplicate_of`, `possible_company_id`, `possible_deal_id`, `metadata_json`, and `custom_fields`.
- `prospect_signals`: source-anchored mention rows. The deterministic uniqueness constraint is `(org_id, source_type, source_id, mention_ordinal)`. Rows store source references, raw mention text, span offsets, classification fields, durable `classification_status` / `resolution_status` / `error_message`, and metadata only. Raw restricted source bodies are not copied here.
- `prospect_classification_history`: append-only history when a deterministic signal row is reclassified.
- `prospect_soft_links`: recoverable possible duplicate/company/deal links.
- `prospect_backfill_runs`: scaffolding for windowed/resumable historical backfill.
- `prospect_backfill_coverage`: coverage ledger including pending errored classifications for coverage-honest MARTy answers.

## Write Path (`REQ-INT-1`)

Prospect field writes reuse the existing `entity-writes.ts` path:

- `src/lib/entity-writes.ts` defines `EntityType = 'contact' | 'company' | 'deal' | 'prospect'`, maps `prospect` to `prospects`, and exposes `updateProspectFields`.
- Prospect writable fields are intentionally metadata fields: name/domain/status/visibility, sector, enrichment state, soft-link fields, `metadata_json`, and `custom_fields`.
- The same lock checks, `entity_field_state` synchronization, and per-field `agent_writes` audit hook apply to prospects.
- `src/lib/progressive-enrichment.ts` and `src/lib/proposal-evaluator.ts` also map `prospect` to `prospects`, so held/candidate field-state flows do not require a parallel provenance table.

## Agent Tools (`REQ-INT-2`, `REQ-INT-3`)

MARTy tools are registered in `src/handlers/agent.ts` and implemented in `src/lib/agent-tools.ts`:

- `query_deal_flow`: exact aggregate counts over firm-visible prospect metadata, with coverage qualifiers.
- `search_prospects`: sector/keyword/status search, sorted by recency then `signal_strength`.
- `get_prospect_evidence`: evidence drill-down that lists evidence rows but gates snippets through the existing source ACL logic.

ACL enforcement:

- Aggregate prospect metadata is firm-visible by default (`prospects.visibility = 'firm'`), so counts are not user-specific.
- Conversation evidence uses the existing conversation/email visibility helpers.
- Event evidence checks attendee/access context.
- Document evidence uses `isDocumentAccessibleToUser`.
- R2 keys and restricted raw source text are not exposed directly through the prospect metadata layer.

## Ingestion And Sources (`REQ-INT-7`)

The shared ingestion pipeline is `src/lib/ingestion-shared.ts`.

Current order:

1. Stage and commit classified source items.
2. Chunk/embed and write `vector_entity_index`.
3. Process attachments.
4. Detect/stage deal signals.
5. Detect and record prospect signals.

Prospect detection is deliberately after deal detection so the top-of-funnel layer sits above the existing deals pipeline without changing it. Backfill callers pass `ingestionMode: 'backfill'`; live ingestion defaults to `live`.

Source families currently handled by prospect signal persistence:

- `conversation`: email, Slack, and manual conversation rows stored in `conversations`.
- `event`: meeting/calendar/transcript-backed rows stored in `events`.
- `document`: schema-supported in `prospect_signals`, with evidence hydration in `agent-tools.ts`; live detection currently reaches documents through classified items when they flow through the shared ingestion shape.

Signals store references (`source_type`, `source_id`, `source_title`, offsets, metadata) rather than raw bodies. R2 remains the source-of-truth object store for raw artifacts and extracted source payloads.

## Classifier (`REQ-CL-*`, `REQ-VAL-*`, `REQ-AR-3`)

Classifier implementation lives in `src/lib/prospect-intelligence.ts`:

- `callProspectClassifier` calls `callClaudeWithUsage` through the existing Cloudflare AI Gateway path in `src/lib/claude.ts`.
- Default model is `claude-haiku-4-5-20251001`, with override via `PROSPECT_CLASSIFIER_MODEL`.
- The LLM decides `mention_type`, `direction`, `sector_key`, `sector_confidence`, and confidence. Deterministic prefilter/sector functions are prompt hints only, not fallback classifiers.
- JSON parse/model failures write durable failed/pending `prospect_signals` rows keyed by `(org_id, source_type, source_id, mention_ordinal)`, with `classification_status = 'failed'`, `resolution_status = 'pending'`, and `error_message`. Reprocessing the same source retries by upserting the same deterministic row.
- Prompt caching is expressed by sending Anthropic system content blocks with `cache_control: { type: 'ephemeral' }` on the static classifier context. The Cloudflare AI Gateway path forwards the Anthropic request body; if provider/gateway support changes, cost is still bounded by the deterministic prefilter and the Phase 2a cost measurement.

## Cron And Queues (`REQ-INT-4`)

No new cron trigger is introduced.

Existing daily cron path:

- `src/lib/daily-cron.ts` runs many existing maintenance tasks under the established pattern.
- Prospect Intelligence attaches via `runProspectReconciliation(orgId, env)` inside `runDailyCron`.

Existing queues/workflows:

- Ingestion uses Cloudflare Workflows through `src/workflows/ingestion.ts`, `ingestion-chunk.ts`, and `ingestion-finalizer.ts`.
- The existing work queue / embed retry path remains the embedding retry mechanism.
- Historical backfill scaffolding exists in D1 (`prospect_backfill_runs`, `prospect_backfill_coverage`), but the six-month backfill has not been run and must wait for Phase 2a GO.

## Vectorize (`REQ-INT-6`)

Prospect Intelligence does not introduce a new Vectorize index or embedding path.

Current source embedding path:

- `src/lib/ingestion-shared.ts` calls `chunkEmbedAndPersistAll`.
- The existing embedding library writes vectors and D1 `vector_entity_index` rows.
- Retry/self-healing remains in the existing embedding retry/work-queue system.

The reconciler currently uses deterministic name/domain/soft-link logic. Any future semantic matching should reuse the existing Vectorize/index metadata conventions rather than creating a prospect-specific embedding fork.

## R2 (`REQ-INT-7`)

Raw artifacts remain in existing source tables and R2 objects. Prospect rows store metadata and references only.

Evidence retrieval in `get_prospect_evidence` hydrates from source tables and returns snippets only after the viewer passes source ACL. Direct R2 object contents are not copied to `prospects` or `prospect_signals`.

## Migrations (`REQ-INT-5`)

Migration location: `migrations/`.

Naming/order convention: zero-padded numeric prefix with descriptive suffix, e.g. `0088_deals_conservative_contract.sql`, `0113_d1_maintenance_and_news_quality.sql`, `0114_prospect_intelligence.sql`.

Remote D1 state verified during orientation: `0114_prospect_intelligence.sql` was listed as pending. It has not been applied remotely.

## Gaps Before Gate

- Human-labeled gold set does not exist yet. Phase 2a cannot run without it (`REQ-VAL-1`, `OD-6`).
- Six-month historical backfill is scaffolding only and must wait for a GO verdict.
- Remote migration apply, backfill, deploy, and production enablement are explicitly blocked until approval after the gate.
- `parse_dealflow_list` remains represented by deterministic mention extraction plus per-mention classifier calls; full list parsing quality is part of the Phase 2a/2b validation surface.
