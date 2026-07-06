# Infra hardening pass — FINAL assembled dispatch (recovered from archived session 02b55c09)
# This is the authoritative task spec for this loop. §4 step 5 was superseded by §5.
# Recovered 2026-07-05. Lucas pasted only §5–6 into /loop; §0–§4 recovered from transcript.

# Infra hardening pass: frontend/backend plumbing (isolated from the V2 data-model overhaul)

## 0. Orient first, then work in isolation

Read planning/medina-db-v2/00-start-here.md and 05-current-backend-audit.md before
touching anything. That plan is the source of truth for a separate, in-flight backend
data-model overhaul (opportunities/facts/evidence ledger). This task is NOT part of
that overhaul and must not touch its territory (see §2).

Current branch `fable/medina-db-v2-plan` has substantial UNCOMMITTED overhaul work in
its working tree right now. Do not do this work there. Create a fresh git worktree off
main (or origin/main) for this task, with its own branch. Leave the existing branch and
its working tree completely untouched — no checkout, no stash, no branch switch in that
directory.

## 1. Goal

Fix the fetching/loading/search/error-handling plumbing that's independent of the data
model, so the app feels fast and reliable now, and so whatever the overhaul ships in the
next phases lands on a cleaner foundation instead of the same ad hoc per-page fetch code.
This is a plumbing pass, not a redesign and not a rewrite.

## 2. Hard boundary — do not cross without stopping and asking

NOT IN SCOPE, full stop:
- Any table/column/enum change: deals, prospects, opportunities, entity_field_state
  semantics, fact/artifact/evidence tables, anything a D0xx decision in
  02-approved-decisions.md already owns.
- The backend write path for contacts (`updateContactFields` / entity-writes.ts) —
  it flows through entity_field_state, which the overhaul is actively reconciling.
  Do not modify this handler.
- New ingestion, extraction, or routing logic of any kind.

IN SCOPE, confirmed safe (companies/contacts tables and their list/search endpoints are
explicitly "preserve" in the audit — only the record-level data model is changing, not
the read/list plumbing around it):
- Frontend fetch/loading/caching/error-handling code, anywhere.
- Read-only query/index optimization on existing tables (e.g. adding an index or FTS
  table mirroring one that already exists elsewhere) — see the companies-search finding
  below for a concrete instance.
- The frontend side of the contact-save bug (consuming the response the backend already
  returns, cache invalidation) — see §3.3. Do NOT go into the backend write handler to
  "fix" it from that side.

If you're ever unsure which side of this line something is on, stop and ask rather than
guessing — this is explicitly a "safe wins only" pass, not a race to fix everything.

## 3. Confirmed findings — start from these, don't rediscover them

A research pass already mapped the current code. Use these as your starting punch list
(verify quickly, then fix — don't re-derive from scratch):

**3.1 No shared data-fetching layer.** `frontend/lib/use-contact-list.ts` is the one
well-built hook in the app (TTL cache, in-flight de-dup, abort controllers, sequence
guards, cursor pagination). Everything else — companies, conversations, contact detail,
settings, documents — is ad hoc `useState`/`useEffect`/`.then/.catch` per component, each
reinventing loading/error handling at different quality levels. Standardize on the
`use-contact-list` pattern (or a shared hook built from it) rather than introducing a new
dependency (React Query/SWR) — that's a bigger, riskier swap to run in parallel with an
active backend overhaul. If you think a library swap is genuinely better, propose it and
wait for a go-ahead rather than doing it inline.

**3.2 Companies page has no error handling at all.** `frontend/app/companies/page.tsx`
`loadCompanies`/`loadMore` have no `.catch()` — a failed fetch silently renders "No
companies match your filters" with no error state and no retry. Compare to contacts,
which has a real error card. Also: companies search is a plain `LIKE %term%`
(`src/handlers/companies.ts`), while contacts already has a dedicated FTS index
(`contact_search_fts`, `src/lib/contact-search.ts`). Bringing companies search up to the
same FTS pattern contacts already uses is a same-shape, low-risk index addition — not a
data-model change. (If this requires a new D1 migration file, check the current highest
migration number immediately before creating it — the overhaul may be landing its own
migrations in this same window; don't create one from a stale/cached view of the
migrations folder.)

**3.3 Contact edit-save bug — frontend side only.** `frontend/app/contacts/[id]/page.tsx`
`handleSave` discards the server's response (`result.after`, and any `rejected_fields`)
and just triggers a full refetch. Fix on the frontend: consume what the backend already
returns instead of blind-refetching, and invalidate/update the 60s list cache in
`use-contact-list.ts` on save so edits show up in the list immediately. Do not modify the
backend `updateContactFields` handler — see §2.

**3.4 MARTy chat message-load spinner.** The actual MARTy chat is
`frontend/app/god-mode/page.tsx` (not the `/conversations/[id]` thread viewer, which is a
separate Outlook-thread page and already has a spinner). Reopening an existing chat
session has no dedicated loading state on the message pane — add one, without disturbing
the existing draft/streaming-preservation logic (`preserveHydratedLocalUiState`,
`skipNextFetchRef`) that's already there for the in-progress-run case. This file is
~3,800 lines and load-bearing — make the smallest change that adds the spinner; don't
refactor around it.

**3.5 Conversation-thread load is slow by construction.** The backend
`getConversationThread` handler (src/handlers/conversations.ts) has no LIMIT on the
thread query and fetches every message body from R2 with no pagination or truncation.
This data source (conversations/R2) is permanently preserved by the overhaul, so fixing
pagination/truncation here is safe plumbing, not overhaul territory.

**3.6 Root domain black-screen / slow first paint.** `AuthGuard`
(frontend/components/auth-guard.tsx) blocks all first paint on a synchronous
`GET /api/auth/me` with an 8s timeout, rendering nothing but a logo pulse until it
resolves — worse on a Worker cold start. Fix: paint an instant app-shell skeleton while
the auth check resolves in the background, rather than a blank/logo-only screen. Do not
render actual protected data before auth resolves — skeleton only, no security
weakening.

**3.7 MARTy "tasks dying mid-run."** Not yet diagnosed — investigate before proposing a
fix. If the root cause turns out to touch backend agent-run/session state rather than
pure frontend plumbing, treat it as a §2 boundary judgment call and flag it rather than
assuming it's safe.

## 4. Process

1. Set up the isolated worktree (§0).
2. Do a quick verification pass on §3's findings (they're pre-diagnosed, not
   pre-verified) and produce a short punch list with your proposed fix for each,
   plus anything from §3.7 you find.
3. Stop and share that punch list before writing code. This is a "safe wins" pass —
   confirm scope before implementation, not after.
   [NOTE from loop operator: Lucas's final hands-free /loop setup (recovered transcript
   line 92: "You don't do anything in between... walk away", "Fable runs §0–§4
   immediately") supersedes blocking here. Interpretation in force: SHARE the verified
   punch list in-transcript before implementing (Lucas can interrupt), but do not block
   on approval — except for anything NEW beyond the pre-approved §3 list or any §2
   boundary question, which DOES stop the loop per §5.]
4. Ship as small, independent, easily-revertable changes rather than one large branch —
   several small PRs beat one big one here, both for review and for merge-conflict risk
   against the overhaul branch's own churn.
5. [superseded by §5 — the loop is the verification]

## 5. Autonomous build → independent audit → revise → verify loop

Don't stop after implementing the punch list and hand control back for review. Run a
real self-hardening loop, and don't return until you hit a genuine stop condition below.

**Each round:**
1. Implement (or revise) the current punch list.
2. Hand the diff to a FRESH subagent that did not write the code — give it the original
   reported symptom for each item (companies search returns nothing / "contacts failed
   to load" / contact edits don't save / MARTy chat has no loading state / domain loads
   to a black screen / conversation thread is slow), not just "review this diff."
   Its job is to reproduce each original symptom's exact scenario against the fix, live,
   using the preview tools (start the dev server, click through, check network/console) —
   not to read the diff and nod. Model: opus, per standing policy.
3. Anything the auditor finds gets fixed with a general fix, not a narrow patch shaped to
   satisfy that one check — no overfitting to whatever the auditor happened to poke.
4. Re-run the FULL audit (not just the broken item) after every fix — a fix can regress
   something the previous round already passed.

**Stop conditions (any of these ends the loop and reports to Lucas):**
- One full round comes back with zero findings. That's sufficient — this isn't an
  active-fire situation, don't run a second confirmatory pass just to be safe.
- 5 rounds have passed without a clean one. Stop and report what's still red rather than
  continuing indefinitely.
- Two consecutive rounds surface a new instance of the same bug family — that's a signal
  you're papering over something structural, not fixing it. Stop and flag it explicitly
  instead of patching again.
- Any fix would require crossing the §2 boundary. Stop and flag, don't route around it.

**Before declaring the final clean pass:** re-verify from a fresh git worktree/clean
checkout of your branch, not the working tree you built in — this catches anything that
works locally but was never actually committed.

Keep a running log of what each round found and fixed (a simple task list is fine) so
Lucas can see the full history without having watched it happen.

## 6. Wider engineering-standards pass — report, don't silently act

There is no CLAUDE.md or standards doc anywhere in this repo today. You're welcome to do
a broader "is this optimal?" pass across frontend conventions (state management, error
UX, caching posture) beyond the specific bugs above, and flag opinions — but scope any
actual code changes from that pass to the same §2 boundary and §4 process. If you land on
a clear standard (e.g. "this hook is now the canonical fetch pattern"), write it down
briefly as a short CLAUDE.md rather than leaving it as tribal knowledge in a diff.
