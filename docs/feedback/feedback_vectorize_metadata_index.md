# Vectorize Metadata Indexes: Why Production Has 3, Not 6

**Production is correctly configured. This file exists to prevent a future engineer
from "fixing" the apparent gap without understanding the prerequisites.**

## The 6-vs-3 Documentation Drift

Older planning docs and a previous version of README step 3 listed six required
Vectorize metadata indexes for the `medina-ventures-main` index:

```
org_id, entity_type, primary_entity_id, document_type, is_org_wide, participant_user_ids
```

Production has three:

```
org_id, document_type, primary_entity_id
```

The README has been corrected. The three "missing" indexes were never load-bearing.

## The Canonical Architectural Decision

`src/lib/retrieval.ts` lines 1452–1461:

```
// Vectorize hard limit: topK > 50 requires returnMetadata='indexed' + returnValues=false.
// We use returnMetadata='all' here for ACL filtering (visibility, participant_user_ids,
// user_id, reconciliation_status — none of which are indexed) and for chunk hydration
// (r2_key, chunk_index, text_preview — also not indexed). So 50 is our ceiling.
// MAX mode's real value comes from per-entity boosts, document-type queries, and
// cross-entity bridging — not raw broad topK. (See: VECTOR_QUERY_ERROR 40025)
// TODO: to raise broad topK above 50, declare metadata indexes for the four ACL fields,
// re-upsert all existing vectors (Vectorize indexes are not retroactive), refactor
// hydration.ts to read r2_key/chunk_index/text_preview from D1, and move ACL filtering
// from post-retrieval JS to a D1 join. Multi-day project, not a hotfix.
```

This is the decision. Do not create the missing indexes without completing the
prerequisite refactor described below.

## Why ACL Is Post-Filter Only

Vectorize has two `returnMetadata` modes:

| Mode | topK ceiling | Returns non-indexed fields? |
|---|---|---|
| `'all'` | 50 | Yes — any metadata field stored on the vector |
| `'indexed'` | 20 000 | No — only fields with declared metadata indexes |

The retrieval pipeline uses `returnMetadata='all'` because it needs to read three fields
from the Vectorize payload that are **not** declared as metadata indexes:

- `r2_key` — used by `hydrateChunks()` to fetch the full chunk text from R2
- `chunk_index` — used by the hydration/citation assembly pipeline
- `text_preview` — used for low-latency partial rendering

As long as those three fields are read from the Vectorize payload, the code is locked
to `returnMetadata='all'`, locked to topK ≤ 50, and **cannot** filter ACL fields at the
Vectorize query layer. ACL is therefore applied entirely in post-retrieval JavaScript.

## How ACL Actually Works Today (Two Layers)

**Layer 1 — `postRetrievalFilter` (retrieval.ts ~line 1339):**
Reads `chunk.metadata.visibility` from the Vectorize-returned payload and gates access:
- `'org_wide'` / `'public'` / `'org'` → allow (unless `reconciliation_status='orphaned'`)
- `'private'` → check `chunk.metadata.participant_user_ids` for user membership; fall back
  to `chunk.metadata.user_id` for legacy vectors
- `'confidential'` → owner/admin role only
- missing / unknown → **deny** (default-deny on bad data)

**Layer 2 — `filterMatchesByAuthoritativeAcl` (retrieval.ts ~line 123):**
For conversation, event, and document sources, discards Vectorize metadata entirely and
re-checks access against the authoritative D1 row. This catches stale metadata written
before ACL backfills and is the defense-in-depth guarantee described in
`feedback_acl_layered_redaction.md`.

## Field-by-Field Table

| Field | Vectorize filter? | Post-filter in JS? | Line refs (retrieval.ts) |
|---|---|---|---|
| `org_id` | **YES** — all queries | No | 1447, 1576, 1759 |
| `document_type` | **YES** — exclusion or equality | Yes (classification) | 1448, 1576, 1759 |
| `primary_entity_id` | **YES** — entity queries | No | 1475, 1645 |
| `visibility` | No | **YES** — primary ACL gate | 1345–1382 |
| `participant_user_ids` | No | **YES** — private-chunk participant check | 1357; also D1 join ~184 |
| `is_org_wide` | No | No — field is not used in retrieval at all | — |
| `entity_type` | No | No — field is not used in retrieval at all | — |
| `reconciliation_status` | No | **YES** — orphaned-chunk gate | 1371 |

`is_org_wide` and `entity_type` are stored in Vectorize metadata for potential future
use but do not participate in any current query or filter path.

## The Prerequisite Refactor to Enable Vectorize-Layer ACL

Adding the three future-TODO indexes (`entity_type`, `is_org_wide`, `participant_user_ids`)
is only useful as part of the topK-ceiling lift. That lift requires:

1. **Move `r2_key`, `chunk_index`, `text_preview` reads from Vectorize payload to D1.**
   Every call to `hydrateChunks()` must be refactored to fetch those fields from the
   `embed_chunks` (or equivalent) D1 table instead of from `chunk.metadata.*`. This
   is the blocking prerequisite — without it, the code cannot switch to
   `returnMetadata='indexed'`.

2. **Declare the three new metadata indexes** via:
   ```bash
   npx wrangler vectorize create-metadata-index medina-ventures-main \
     --property-name=entity_type --type=string
   npx wrangler vectorize create-metadata-index medina-ventures-main \
     --property-name=is_org_wide --type=string
   npx wrangler vectorize create-metadata-index medina-ventures-main \
     --property-name=participant_user_ids --type=string
   ```
   **Do not run these commands** without completing step 1 first — they have no effect
   on current query performance since the code never passes those fields as filters.

3. **Full re-embed of all existing vectors.** Vectorize does not retroactively apply a
   new metadata index to vectors written before the index was created. Every vector in
   `medina-ventures-main` must be re-upserted after the indexes are declared. Use
   `POST /api/admin/backfill-unembedded` (chunked, idempotent) to drive the re-embed.
   At production scale this is a multi-hour job.

4. **Refactor retrieval to filter ACL fields at Vectorize layer.** Once steps 1–3 are
   done, `postRetrievalFilter`'s `participant_user_ids` and `is_org_wide` checks can be
   moved into the Vectorize filter object, allowing topK to exceed 50.

**This is a multi-day project, not a hotfix.** Do not attempt it as an incremental
change — all four steps must ship atomically or you introduce a window where the new
indexes exist but vectors haven't been re-embedded and filtered queries silently return 0.

## When to Revisit This

Consider the multi-day refactor when **all** of the following are true:

- A specific, reproducible class of queries demonstrates that topK = 50 is the binding
  constraint (not rerank quality, not embedding coverage, not chunk size).
- Embed coverage is ≥ 95% (check `GET /api/admin/embed-queue-health` before starting —
  if there is a large backlog, the re-embed in step 3 will be proportionally longer).
- You have a maintenance window for the re-embed job: expect 4–8 hours for a full corpus.
- The `hydration.ts` → D1 refactor has been designed and reviewed. Changing the data
  source for `r2_key`/`chunk_index`/`text_preview` affects citation assembly and must be
  verified end-to-end before deploying.

**Do not add the new indexes speculatively** "to have them ready." Vectorize does not
retroactively index existing vectors, so adding them before the re-embed gives you indexes
that cover only newly-written vectors — a partial, confusing, silent-failure-prone state.
