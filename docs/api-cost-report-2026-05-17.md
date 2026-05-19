# API Cost Report

Date: 2026-05-17

Project: Medina Intelligence Platform / MARTy

## Executive Summary

The platform has three major external cost centers:

1. Claude / Anthropic
   - MARTy production chat and artifact reasoning.
   - MARTy MAX mode.
   - MARTy Lab / Sandbox experiment generation, grading, and Deep Work.
   - Operational intelligence jobs such as document extraction, transcript extraction, deal detection, summaries, and import mapping.

2. Gemini / Google
   - Grounded web search for enrichment, news, LinkedIn discovery, and MARTy live web search.
   - Contact and company enrichment.
   - Web research / scraping style workflows.

3. Cloudflare
   - Workers API and pipeline execution.
   - D1 database.
   - R2 object storage.
   - Vectorize indexes.
   - Workers AI embeddings.
   - Queues, Workflows, KV, Browser Rendering, and AI Gateway.

The main finding: the current production telemetry is not yet sufficient to produce exact historical dollars by provider, model, and use case. The app records workload and some rate-limit usage, but it does not persist Claude token usage, Gemini token usage, Gemini grounding request counts, Workers AI token counts, or Cloudflare billable operation totals in a normalized cost ledger.

That means this report can identify the cost drivers and the production workload we can prove, but exact spend must be pulled from provider billing exports or reconstructed going forward with better instrumentation.

## Pricing References

Current pricing should always be treated as provider-controlled and subject to change. The relevant official pricing pages are:

- Anthropic Claude pricing: https://docs.anthropic.com/en/docs/about-claude/pricing
- Google Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Cloudflare Vectorize pricing: https://developers.cloudflare.com/vectorize/platform/pricing/
- Cloudflare AI Gateway pricing: https://developers.cloudflare.com/ai-gateway/reference/pricing/

As of this audit:

- Anthropic lists Claude Opus 4 and Opus 4.1 at $15 per million input tokens and $75 per million output tokens, Sonnet 4 and Sonnet 4.5 at $3 per million input tokens and $15 per million output tokens, and Haiku 4.5 at $1 per million input tokens and $5 per million output tokens.
- Google lists `gemini-2.5-flash` standard paid pricing at $0.30 per million text/image/video input tokens and $2.50 per million output tokens. Gemini grounding with Google Search is free up to the published daily/request allowance, then priced per grounded prompt/search query.
- Cloudflare Workers AI lists `@cf/baai/bge-base-en-v1.5` embeddings at $0.067 per million input tokens and `@cf/qwen/qwen3-embedding-0.6b` at $0.012 per million input tokens.
- Cloudflare Vectorize pricing depends on stored dimensions and queried dimensions. Query volume is not available from app telemetry today, so the Vectorize bill cannot be fully reconstructed from D1 alone.

## Current Production Telemetry

These are observed production values from the app database and Cloudflare resources.

### MARTy Chat / RAG

Source tables:

- `rag_query_logs`
- `agent_messages`
- `agent_runs`

Observed:

| Metric | Value |
| --- | ---: |
| RAG query log rows | 189 |
| First RAG log | 2026-04-26T19:10:51.067Z |
| Latest RAG log | 2026-05-17T15:19:46.211Z |
| RAG rows with Claude model populated | 0 |
| RAG rows with Claude token counts populated | 0 |
| Assistant messages | 189 |
| User messages | 190 |
| Agent message rows with token counts | 0 |
| Recent assistant messages tagged Fast | 1 |
| Recent assistant messages tagged MAX | 6 |
| Older assistant messages without mode metadata | 182 |

Interpretation:

- Production MARTy usage exists and is visible by conversation volume.
- Exact Claude cost for MARTy cannot be calculated from current app tables because token counts are not recorded.
- Recent Fast/MAX metadata exists, but it was added after most historical messages, so it cannot support historical model-percentage calculations yet.

### MARTy Lab / Sandbox

Source tables:

- `marty_lab_runs`
- `marty_lab_experiments`
- `marty_lab_upgrade_trials`
- `marty_lab_artifact_reviews`
- `work_queue`

Observed:

| Metric | Value |
| --- | ---: |
| MARTy Lab experiment queue jobs completed | 347 |
| MARTy Lab experiments graded | 250 |
| MARTy Lab experiments cancelled | 92 |
| MARTy Lab artifact reviews completed | 209 |
| Upgrade trials accepted | 2 |
| Upgrade trials inconclusive | 8 |
| Upgrade trials rejected | 17 |
| Upgrade trials pending | 12 |

Interpretation:

- MARTy Lab is probably one of the biggest Claude cost centers because it uses higher-quality lab models for scenario generation, adaptive follow-ups, candidate repair, grading, Deep Work, and code-patch planning.
- The lab currently has workload counts, but not the token counts needed to calculate exact Opus spend.
- Artifact reviews also create Cloudflare and renderer workload, but exact renderer/browser minutes are not currently logged in a cost ledger.

### Background Work Queue

Source table:

- `work_queue`

Observed completed rows by notable domain:

| Domain | Upstream | Completed rows | Dead-letter rows | Cost interpretation |
| --- | --- | ---: | ---: | --- |
| `rag_reindex_v2` | `bge` | 26,199 | 0 | Cloudflare Workers AI embeddings and Vectorize writes |
| `embed_retry` | `bge` | 3,291 | 55 | Cloudflare Workers AI embeddings and Vectorize writes |
| `semantic_intelligence_v1` | null | 28,146 | 0 | Internal processing, may indirectly call Claude depending path |
| `deal_replay_evidence` | `claude` | 6,063 | 0 | Claude-based deal evidence replay |
| `contact_enrichment` | null | 1,541 | 47 | Gemini enrichment plus internal persistence |
| `marty_lab_experiment` | `claude` | 347 | 0 | Claude lab workload |
| `marty_lab_artifact_review` | `artifact-renderer` | 156 | 0 | Artifact rendering/review workload |
| `calendar_refresh` | `graph` | 820 | 126 | Microsoft Graph, not in requested provider scope |
| `intelligent_import` | `claude` | 5 | 5 | Claude import mapping/extraction |
| `firefly_window` | `firefly_api` | 8 | 0 | Fireflies, not in requested provider scope |

Interpretation:

- `work_queue` rows are job rows, not one-to-one API calls.
- They are still useful for identifying cost-heavy features.
- The highest-volume provider-linked areas are RAG reindexing/embeddings, deal replay evidence, enrichment, and MARTy Lab.

### Cloudflare Resource Snapshot

Observed Cloudflare resources:

| Resource | Observed state |
| --- | --- |
| Workers | `medina-ventures-api`, `medina-ventures-pipelines` |
| D1 database | `medina-ventures-db`, approximately 1.19 GB file size |
| R2 bucket | `medina-ventures-storage`, 122,189 objects, 2.01 GB |
| Vectorize main index | `medina-ventures-main`, 339,875 vectors, 768 dimensions |
| Vectorize RAG v2 BGE index | `medina-rag-v2-bge-768`, 94,466 vectors, 768 dimensions |
| Vectorize RAG v2 Qwen index | `medina-rag-v2-qwen3-1024`, 0 vectors |
| Vectorize RAG v2 MiniLM index | `medina-rag-v2-minilm-384`, 0 vectors |
| Queues | audit log, webhook intake, RAG reindex, and DLQs |
| Workflows | ingestion, enrichment, campaign send, daily cron |
| AI Gateway | Anthropic traffic is routed through Cloudflare AI Gateway |

Vectorize stored dimensions:

| Index | Stored dimensions |
| --- | ---: |
| `medina-ventures-main` | 261,024,000 |
| `medina-rag-v2-bge-768` | 72,549,888 |
| Total populated Vectorize dimensions | 333,573,888 |

Interpretation:

- R2 storage is modest at about 2 GB.
- D1 storage is about 1.19 GB.
- Vectorize has meaningful stored dimensions, but query dimensions are not available from app telemetry. Query volume is required for exact Vectorize cost.
- Workers AI embedding cost cannot be reconstructed exactly because embedding token counts are not persisted.

## Provider Breakdown

## Claude / Anthropic

### Current Model Configuration

Observed in code:

| Area | Model / family | Primary source |
| --- | --- | --- |
| MARTy normal chat | `claude-sonnet-4-6` | `src/lib/claude.ts`, `src/lib/marty-runtime.ts` |
| MARTy MAX mode | `claude-opus-4-7` | `src/lib/max-mode.ts`, `src/lib/marty-runtime.ts` |
| MARTy Lab | Opus default via `MARTY_LAB_OPUS_MODEL`, fallback if configured | `src/lib/marty-lab.ts` |
| Session title generation | Haiku 4.5 style model | `src/handlers/agent.ts` |
| Document/transcript/deal intelligence | Claude wrapper | `src/lib/document-intelligence.ts`, `src/lib/transcript-extraction.ts`, `src/lib/deal-intelligence.ts`, `src/lib/deal-detection.ts` |

### Claude Use Cases

| Use case | What Claude does | Likely model class | Cost risk |
| --- | --- | --- | --- |
| MARTy normal chat | Answers user questions, uses RAG context, creates artifacts, handles conversation continuity | Sonnet | High volume, moderate per-token cost |
| MARTy MAX | Deeper search and synthesis when the user chooses MAX | Opus | Lower volume, high per-token cost |
| MARTy Lab / Sandbox | Designs tests, generates adaptive follow-ups, proposes upgrades, grades baseline vs candidate, finds Deep Work | Opus | Potentially very high cost because each experiment includes many model calls |
| Document intelligence | Classifies documents, extracts structured signals, creates summaries | Sonnet/Haiku depending call site | Medium |
| Transcript extraction | Pulls meeting signals, deal facts, summaries, participants, next steps | Claude | Medium |
| Deal detection and replay evidence | Detects deals from conversations and builds evidence records | Claude | Medium to high because queue volume is large |
| Intelligent import | Maps uploaded files and raw content into structured workspace objects | Claude | Low current volume |
| Citation verification | Checks answer support against source material | Claude | Low to medium |
| Artifact planning/composition | Produces DOCX/XLSX/PPTX structures or repair instructions | Claude | Medium to high depending artifact volume |

### Claude Percentages

Exact percentages cannot be calculated from current app logs.

What we can say:

- Historical MARTy chat volume is visible: 189 assistant messages / 189 RAG query logs.
- Token usage is not persisted for those rows.
- Model names are not persisted for those rows.
- Recent assistant messages include 1 Fast and 6 MAX-tagged outputs, but 182 older assistant messages predate the current metadata.
- MARTy Lab has 347 completed Claude queue jobs, plus many experiment/trial rows, but no Opus token ledger.

What is needed:

- Persist model, input tokens, output tokens, cache tokens, feature tag, org/user/session, and estimated cost for every Claude call.
- For streaming calls, capture final usage from the provider response or the AI Gateway log export.
- Import Anthropic Usage and Cost API / Claude Console export for historical true spend.
- Optionally import Cloudflare AI Gateway logs because Claude requests are routed through AI Gateway.

## Gemini / Google

### Current Model Configuration

Observed in code:

| Area | Model / tool | Primary source |
| --- | --- | --- |
| Gemini wrapper | `gemini-2.5-flash` | `src/lib/gemini.ts` |
| Grounded search | Google Search grounding enabled by default unless disabled | `src/lib/gemini.ts` |
| Enrichment | Gemini grounded web research | `src/lib/enrichment.ts` |
| News search | Gemini grounded web research | `src/integrations/news-search.ts` |
| LinkedIn discovery | Gemini grounded search | `src/lib/linkedin-discovery.ts` |
| MARTy web search | Gemini search budget / grounded search path | `src/lib/agent-web-search.ts` |

### Gemini Use Cases

| Use case | What Gemini does | Cost risk |
| --- | --- | --- |
| Contact enrichment | Searches the web for contact context, bios, company relationships, public signals | Medium to high |
| Company enrichment | Searches web/news/company sources to build dossiers | Medium to high |
| LinkedIn discovery | Finds likely LinkedIn URLs and public profile/company matches | Medium |
| News / company research | Pulls recent web results and grounded summaries | Medium |
| MARTy live web search | Lets MARTy answer current web-dependent questions | Medium, bursty |
| Web scraping / public research | Repo usage is mostly grounded Google Search rather than a generic crawler | Medium to high when batch enrichment runs |

### Gemini Percentages

Exact percentages cannot be calculated from current app logs.

What we can say:

- `contact_enrichment` has 1,541 completed queue rows and 47 dead-letter rows.
- Gemini rate-limit ledger rows exist, but they are rolling/current budget windows, not historical spend ledgers.
- The Gemini wrapper does not persist token counts, grounding request counts, or per-feature dollar estimates.

What is needed:

- Persist Gemini model, input tokens, output tokens, grounding prompts/search queries, feature tag, and estimated cost per call.
- Record whether grounding was enabled and how many search queries were performed.
- Import Google billing/export data for historical true spend.

## Cloudflare

### Cloudflare Use Cases

| Use case | Cloudflare product | Cost driver |
| --- | --- | --- |
| API server | Workers | Requests, CPU duration, paid plan |
| Pipeline worker | Workers + cron | Requests, CPU duration, scheduled work |
| Database | D1 | Storage, rows read, rows written |
| Files and artifacts | R2 | Storage, Class A/B operations |
| RAG retrieval | Vectorize | Stored dimensions, queried dimensions |
| Embeddings | Workers AI | Embedding input tokens |
| Background processing | Queues | Operations |
| Multi-step ingestion/enrichment | Workflows | Workflow runs/steps |
| Settings/session/cache state | KV | Reads, writes, storage |
| Rendered artifact inspection | Browser Rendering | Browser session/minute usage |
| Claude proxy/logging | AI Gateway | Gateway requests/log storage, plus Anthropic provider cost |

### Cloudflare Current State

The Cloudflare footprint is real but mostly moderate by storage size:

- D1: about 1.19 GB.
- R2: about 2.01 GB and 122,189 objects.
- Vectorize: about 333.6 million populated stored dimensions.
- Workers AI embeddings: high job volume from RAG reindexing, but exact token count is not stored.
- Queues and Workflows are heavily used by ingestion, enrichment, and RAG reindexing.

The likely largest Cloudflare-specific cost drivers are:

1. Worker execution from API and pipelines.
2. Workers AI embedding calls during RAG reindexing and retries.
3. Vectorize query dimensions from MARTy retrieval.
4. Browser Rendering if artifact grading runs frequently.
5. R2 object operations if artifact/document traffic grows.

## Current Cost Confidence

| Provider | Can we calculate exact historical spend from app telemetry? | Why |
| --- | --- | --- |
| Claude | No | Token counts and model tags are not persisted across all Claude calls. |
| Gemini | No | Token counts, grounding request counts, and feature tags are not persisted. |
| Cloudflare | Partially | Current resource sizes are visible, but billed requests, CPU, D1 ops, R2 ops, Vectorize query dimensions, Workers AI tokens, and Browser Rendering minutes require Cloudflare billing/analytics export. |

## Practical Cost Risk Ranking

1. MARTy Lab / Sandbox Claude Opus calls
   - The lab can multiply model calls quickly because each experiment includes scenario generation, adaptive user turns, baseline/candidate paired runs, grading, repair, and Deep Work.
   - Opus is materially more expensive than Sonnet.

2. MARTy MAX Opus
   - Lower volume than regular chat, but high per-token cost.
   - Needs precise per-run token accounting.

3. Gemini grounded enrichment
   - Contact/company enrichment and web research can create large bursts.
   - Grounding can add per-grounded-prompt/search-query cost after the free allowance.

4. RAG reindexing and embedding
   - High job count and potentially large token volume.
   - Workers AI embedding price is lower than frontier LLMs, but reindexing can scale across the entire document corpus.

5. Vectorize queries
   - Stored dimensions are known.
   - Query dimensions are unknown and can grow with MARTy traffic.

6. R2/D1 storage
   - Current storage size looks modest.
   - Operations can still matter, but storage itself is unlikely to be the largest near-term driver.

## What A True Cost Dashboard Needs

Add a first-class `api_usage_events` ledger. Suggested columns:

| Column | Purpose |
| --- | --- |
| `id` | Event id |
| `org_id` | Tenant attribution |
| `user_id` | User attribution when available |
| `provider` | `anthropic`, `google`, `cloudflare`, etc. |
| `service` | `claude`, `gemini`, `workers_ai`, `vectorize`, `d1`, `r2`, etc. |
| `model` | Exact model id |
| `feature` | `marty_chat`, `marty_max`, `marty_lab`, `enrichment`, etc. |
| `subfeature` | More detailed use case |
| `source_table` | Source table that caused the call |
| `source_id` | Source row id |
| `session_id` | MARTy session when relevant |
| `run_id` | Lab/import/task run when relevant |
| `request_id` | Provider or gateway request id |
| `input_tokens` | Prompt/input token count |
| `output_tokens` | Output token count |
| `cache_creation_tokens` | Claude cache write tokens |
| `cache_read_tokens` | Claude cache read tokens |
| `grounding_requests` | Gemini/Claude web search usage |
| `embedding_tokens` | Workers AI embedding tokens |
| `vector_stored_dimensions` | Vectorize storage attribution |
| `vector_queried_dimensions` | Vectorize query attribution |
| `cloudflare_units_json` | D1/R2/Worker/Queue/Workflow units when captured |
| `estimated_cost_usd` | Calculated estimate using pricing version |
| `pricing_version` | Pricing table version used |
| `created_at` | Timestamp |

Then add a daily rollup:

| Dimension | Rollup |
| --- | --- |
| Provider | Daily spend by provider |
| Model | Daily spend by model |
| Feature | Daily spend by use case |
| Org/user | Tenant and user attribution |
| Lab run/session/task | Trace expensive runs back to source |

## Feature Tags To Add

Recommended normalized feature tags:

- `marty_chat`
- `marty_max`
- `marty_lab`
- `marty_lab_artifact_review`
- `marty_lab_code_patch`
- `enrichment_contact`
- `enrichment_company`
- `linkedin_discovery`
- `news_search`
- `marty_web_search`
- `document_ingestion`
- `document_intelligence`
- `transcript_ingestion`
- `deal_detection`
- `deal_replay_evidence`
- `citation_verifier`
- `artifact_generation`
- `rag_embedding`
- `rag_vector_search`
- `daily_cron`
- `intelligent_import`

## Immediate Engineering Recommendations

1. Instrument Claude streaming first.
   - This is the biggest blind spot because MARTy chat is streamed and currently not persisted with token counts.
   - Capture final Anthropic usage and feature tag each call.

2. Instrument MARTy Lab with hard budgets.
   - Record Opus tokens by lab run, experiment, scenario, follow-up, evaluator, and Deep Work.
   - Add per-experiment estimated cost before a user starts it.

3. Instrument Gemini grounding.
   - Log token usage and number of grounded prompts/search queries.
   - Tag enrichment, news, LinkedIn, and MARTy web search separately.

4. Instrument embeddings.
   - Log Workers AI model and input token count for every embedding batch.
   - Attribute to reindex job, upload, or retry.

5. Pull provider billing exports.
   - Anthropic Usage and Cost API or Claude Console export.
   - Google billing export for Gemini API.
   - Cloudflare billing/analytics export for Workers, D1, R2, Vectorize, Queues, Workflows, Workers AI, AI Gateway, and Browser Rendering.

6. Build an admin Cost Center.
   - Provider spend by day.
   - Use case spend by day.
   - Model split: Opus vs Sonnet vs Haiku, Gemini model split, Workers AI embedding split.
   - MARTy vs MARTy Lab vs enrichment vs ingestion.
   - Top expensive sessions, lab experiments, documents, and queue jobs.

## Bottom Line

The platform already has enough structure to build a strong API cost dashboard, but not enough historical cost telemetry to answer exact spend by provider and use case from the app database alone.

The most honest current answer is:

- Claude is likely the most important cost to control because MARTy, MAX, Lab, and intelligence jobs all depend on it.
- Gemini cost is mainly driven by grounded search/enrichment and can spike with batch contact/company work.
- Cloudflare storage is currently modest, but Workers, Workers AI embeddings, Vectorize query dimensions, and Browser Rendering need better usage capture.

The next engineering step should be a unified API usage ledger plus provider billing import. After that, this report can become an exact dollar dashboard instead of an audit-plus-instrumentation plan.
