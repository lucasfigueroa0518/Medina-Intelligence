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

## CI gates
- Every PR and push to main runs `.github/workflows/ci.yml` (root: `tsc --noEmit`
  + `vitest run`; frontend: `tsc --noEmit` + lint + `next build`) and
  `config-check.yml` (wrangler drift). Keep them green; they are required-check
  candidates. CI does NOT deploy — Worker deploys stay manual, Vercel deploys
  off main.
- Tests must pass on a CLEAN CHECKOUT. A test that needs gitignored local
  artifacts (e.g. `outputs/` review contracts) must `describe.skipIf` on the
  artifact's existence, not fail without it — and never commit real CRM data
  as fixtures.

## Backups & disaster recovery
- DR contract: D1 Time Travel is the first line (≤30-day point-in-time);
  `D1BackupWorkflow` exports all base tables to R2 (`backups/d1/<date>/`)
  daily at 03:15 UTC with 14-day retention as the second line. Restore via
  `scripts/restore-d1-backup.mjs`. Runbook: `docs/disaster-recovery.md`.
- The backup path must stay strictly READ-ONLY against D1. Anything that
  mutates data belongs in maintenance, never in backup.
- New scheduled work does NOT get a new cron trigger (a 4th registered
  trigger broke CF cron dispatch on 2026-04-28). Add a UTC time-of-day gate
  inside the minute-tick branch of `handleScheduled` with a `withTaskRun`
  idempotency key, like `d1_maintenance` (02:25) and `d1_backup_dispatch`
  (03:15). Heavy work goes in a Workflow, not inline `waitUntil`.

## Frontend resilience
- `app/error.tsx` + `app/global-error.tsx` are load-bearing: pages must never
  white-screen. They are the LAST-RESORT net — per-surface data-error cards
  with retry (the contacts-style card) remain mandatory for fetch failures.
  New boundary UIs reuse `components/error-fallback.tsx`.

## Security headers
- `frontend/next.config.mjs` `headers()` is the baseline: HSTS, nosniff,
  `X-Frame-Options: DENY` + `frame-ancestors 'none'`, Referrer-Policy,
  Permissions-Policy, and a full CSP in REPORT-ONLY mode. Don't remove
  headers; tighten the CSP only with report-only violation data in hand,
  then flip to enforcing (nonce-based script-src is the end state).
- `connect-src` derives from `NEXT_PUBLIC_API_URL` at build time — never
  hardcode an API origin into the policy.

## Dependencies
- Patch posture: security patches ride minor/patch bumps promptly (run
  `npm audit` in both roots); MAJOR bumps (React, Tailwind, TypeScript,
  Next majors) are deliberate, scheduled decisions — they collide with the
  overhaul's UI phases. Known accepted residual: the postcss copy vendored
  inside Next (moderate, unfixable locally without a breaking downgrade).
- Spreadsheet parsing uses `@e965/xlsx` (maintained SheetJS build) in BOTH
  roots — the upstream `xlsx` package is frozen with unfixed advisories;
  do not reintroduce it.

## Wrangler configs
- The four wrangler configs are governed by
  `scripts/check-wrangler-drift.mjs` (runs in CI): parity vars must match
  everywhere, intentional divergences are pinned in its manifest, cron sets
  are exact, and any NEW var must be classified there — extend the manifest
  in the same PR that adds the var. `wrangler.readonly.toml` stays D1-only
  (+`remote=true`): giving it R2/KV would let a "readonly" preview write
  production storage.
