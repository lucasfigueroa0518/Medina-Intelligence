# Medina Intelligence Platform — engineering standards

## Frontend data fetching
- `frontend/lib/use-cached-list.ts` (`createCachedList`) is the canonical list-fetch
  pattern: TTL cache, in-flight de-dup, epoch invalidation, abort controllers,
  sequence guards, cursor/offset pagination, prefetch. New list surfaces get a thin
  wrapper on it (see `use-contact-list.ts`, `use-company-list.ts`,
  `use-document-list.ts`) — do not hand-roll `useState`/`useEffect`/`.then/.catch`
  fetch code for lists.
- Do not introduce React Query/SWR or other fetch libraries without an explicit
  owner go-ahead.
- Every data surface must render a real error state with a retry affordance
  (contacts-style error card). Silent empty states on failure are bugs.
- Writes must update list caches immediately via `patchItem`/`invalidateAll` from
  the shared layer — never rely on the TTL expiring to reflect an edit.
- Mutations must consume the server response (e.g. `{ contact, rejected_fields }`)
  and surface rejected/locked fields to the user, not blind-refetch.

## Backend read handlers
- Responses are bounded: no unbounded row scans, no unbounded R2 fan-outs. Window +
  opaque cursor is the house pattern (`getConversationThread` is the reference).
  ACL-filter first, then window, so cursors are defined over readable rows only.
- Entity search uses FTS5 with a graceful LIKE fallback (`src/lib/contact-search.ts`,
  `src/lib/company-search.ts`). New searchable entities mirror that module shape,
  including the index-state sidecar, drift repair, and an admin rebuild endpoint.

## Migrations
- Before creating a migration, check the highest number in `migrations/` on EVERY
  active branch (including uncommitted work in other worktrees), not just your own —
  parallel branches land migration blocks concurrently.

## Active-overhaul boundary
- A backend data-model overhaul (opportunities/facts/evidence) is in flight; its
  source of truth is `planning/medina-db-v2/` (read `00-start-here.md` and
  `02-approved-decisions.md`). Do not change schema/enums it owns, and do not touch
  the contact write path (`updateContactFields` / `entity-writes.ts`) without
  checking that plan first.

## Local dev
- Frontend expects the Worker API at `http://localhost:8787`
  (`frontend/.env.local`). Run wrangler local-only; `wrangler.readonly.toml` sets
  `remote = true` on D1 and will hit production — do not use it for local testing.
