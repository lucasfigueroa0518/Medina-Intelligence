// TRD §5.3 — Claude + enrichment rate limiters
import type { Env } from '../types/env';
import { checkBudget, recordUsage, recordRateLimit, reserveBudget, type Upstream } from './upstream-budget';

interface ClaudeRateState {
  count: number;
  resets_at: string;
}

// Phase 3.3 (2026-05-04): migrated from KV-backed counter to the
// upstream_budget_ledger. Caller signature unchanged so all 26+ existing
// call sites keep working without edits. Same migration shape as Graph
// (3.1) and Gemini (3.2):
//   • The ledger replaces the KV counter for the rate-limit-window
//     accounting. The cap is sourced from DEFAULT_CAPS.claude.minute
//     (= 60, matching the existing CLAUDE_MAX_RPM env-var default).
//   • Priority is preserved via cap-math at the call site: 'high' uses
//     full cap, 'low' uses cap minus a 1/3 reserve — same semantics as
//     the prior KV implementation.
//   • The check-and-increment behavior of the prior KV impl is preserved
//     by calling recordUsage inline on a successful check. Callers don't
//     need to add a separate record call.
//   • 429 detection lands at the actual fetch site in src/lib/claude.ts
//     (recordRateLimit invoked when Anthropic returns 429) — the prior
//     KV impl could not observe upstream 429s; the ledger circuit
//     breaker closes that gap.
//   • The previous KV keys (`claude_rate:<orgId>`) are abandoned. TTL
//     was 120s so they expire naturally within ~2 min after deploy.
//   • Note: callClaudeStreaming intentionally NOT routed through this
//     wrapper today (pre-existing gap, not a Phase 3.3 regression).
//     Future phase can fold streaming through the same ledger.
export async function checkClaudeRateLimit(
  env: Env,
  orgId: string,
  priority: 'high' | 'low'
): Promise<boolean> {
  const result = await checkBudget(env, orgId, null, 'claude', 'minute');
  if (result.decision === 'circuit_open') return false;
  const reserve = Math.floor(result.cap / 3);
  const effectiveCap = priority === 'high' ? result.cap : result.cap - reserve;
  if (result.used >= effectiveCap) return false;
  // Pre-record to mirror the KV impl's check-and-increment behavior;
  // existing callers expect a successful check to count toward the
  // window total.
  await recordUsage(env, orgId, null, 'claude', 'minute');
  return true;
}

// --- Enrichment source cooldown (§5.3) ---

const BASE_BACKOFF: Record<string, number> = {
  reversecontact: 1800,
  claude_enrichment: 600,
  claude_news: 600,
  gemini_enrichment: 600,
  gemini_news: 600,
  gemini_linkedin: 600,
};

// Phase 3.2 (2026-05-04): migrated from KV-backed counter to the
// upstream_budget_ledger. Caller signature unchanged so all callers
// keep working without edits. Same migration shape as Graph (3.1):
//   • The ledger replaces the KV counter for the rate-limit-window
//     accounting. The cap is sourced from DEFAULT_CAPS.gemini.minute
//     (= 500, matching the existing GEMINI_MAX_RPM env-var override
//     in wrangler.toml).
//   • Priority is preserved via cap-math at the call site: 'high' uses
//     full cap, 'low' uses cap minus a 1/3 reserve — same semantics as
//     the prior KV implementation.
//   • The check-and-increment behavior of the prior KV impl is
//     preserved by calling recordUsage inline on a successful check.
//     Callers don't need to add a separate record call.
//   • 429 detection lands at the actual fetch site in src/lib/gemini.ts
//     (recordRateLimit invoked when Google returns 429) — the prior
//     KV impl could not observe upstream 429s; the ledger circuit
//     breaker closes that gap.
//   • The previous KV keys (`gemini_rate:<orgId>`) are abandoned. TTL
//     was 120s so they expire naturally within ~2 min after deploy.
export async function checkGeminiRateLimit(
  env: Env,
  orgId: string,
  priority: 'high' | 'low',
  upstream: Extract<Upstream, 'gemini' | 'gemini_web_search'> = 'gemini',
  userId: string | null = null
): Promise<boolean> {
  const result = await checkBudget(env, orgId, userId, upstream, 'minute');
  if (result.decision === 'circuit_open') return false;
  const reserve = Math.floor(result.cap / 3);
  const effectiveCap = priority === 'high' ? result.cap : result.cap - reserve;
  if (result.used >= effectiveCap) return false;
  // Pre-record to mirror the KV impl's check-and-increment behavior;
  // existing callers expect a successful check to count toward the
  // window total.
  await recordUsage(env, orgId, userId, upstream, 'minute');
  return true;
}
const MAX_BACKOFF = 86400;

interface EnrichmentRateState {
  blocked_until: string;
  consecutive_429s: number;
  last_429_at?: string;
}

export async function checkEnrichmentRateLimit(
  source: string,
  orgId: string,
  env: Env
): Promise<boolean> {
  const state = await env.KV.get<EnrichmentRateState>(
    `rate_limit:${source}:${orgId}`,
    'json'
  );
  return !state || new Date(state.blocked_until) <= new Date();
}

export async function recordEnrichmentRateLimit(
  source: string,
  orgId: string,
  env: Env
): Promise<void> {
  const state = await env.KV.get<EnrichmentRateState>(
    `rate_limit:${source}:${orgId}`,
    'json'
  );
  const n = (state?.consecutive_429s || 0) + 1;
  const backoff = Math.min(
    (BASE_BACKOFF[source] || 3600) * Math.pow(2, n - 1),
    MAX_BACKOFF
  );
  await env.KV.put(
    `rate_limit:${source}:${orgId}`,
    JSON.stringify({
      blocked_until: new Date(Date.now() + backoff * 1000).toISOString(),
      consecutive_429s: n,
      last_429_at: new Date().toISOString(),
    }),
    { expirationTtl: MAX_BACKOFF + 60 }
  );
}

export async function clearEnrichmentRateLimit(
  source: string,
  orgId: string,
  env: Env
): Promise<void> {
  await env.KV.delete(`rate_limit:${source}:${orgId}`);
}

// --- Workers AI BGE embedding rate limiter (audit 2026-04-28 scale-up) ---
//
// Unlike checkClaudeRateLimit (throw-on-excess), this one BACKS OFF AND WAITS.
// Embedding is on the critical path — every ingested item needs it. If we
// throw, the embed step fails after retries and chunks complete silently
// with no vectors. Backoff-and-wait keeps work moving; it just paces it.
//
// The old limiter used a hot KV key (`embed_rate:<org>`). At RAG V2 queue
// concurrency that became the bottleneck before Workers AI did. The limiter
// now reserves slots in upstream_budget_ledger with an atomic D1 UPDATE, so
// the queue can run hundreds of jobs while the BGE call rate remains bounded.
//
// Tuned by upstream_budget_ledger (bge.per_second defaults to 12).
// 90s ceiling on a single acquire — if we wait longer than that, surface the
// failure explicitly so the caller can record it (the gap is then caught by
// detect-embed-gaps in the finalizer and recovered via embed_retry_queue).

const EMBED_BACKOFF_BASE_MS = 100;
const EMBED_BACKOFF_MAX_MS = 5000;
const EMBED_MAX_WAIT_MS = 90_000;

function isTransientLimiterBackpressure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('429') ||
    msg.includes('Too Many Requests') ||
    /overloaded/i.test(msg) ||
    /SQLITE_BUSY/i.test(msg) ||
    /database is locked/i.test(msg);
}

async function waitForEmbedLimiterRetry(
  startedAt: number,
  attempt: number,
  reason: string,
  preferredDelayMs?: number
): Promise<void> {
  const baseBackoff = preferredDelayMs !== undefined
    ? Math.min(Math.max(preferredDelayMs, 50), EMBED_BACKOFF_MAX_MS)
    : Math.min(
      EMBED_BACKOFF_BASE_MS * Math.pow(2, attempt),
      EMBED_BACKOFF_MAX_MS
    );
  const jitter = Math.random() * Math.min(250, Math.max(50, baseBackoff * 0.25));
  const backoff = Math.max(50, baseBackoff + jitter);

  if (Date.now() - startedAt + backoff > EMBED_MAX_WAIT_MS) {
    throw new Error(
      `EMBED_RATE_LIMIT_TIMEOUT after ${Math.round((Date.now() - startedAt) / 1000)}s waiting for slot (${reason})`
    );
  }

  await new Promise(resolve => setTimeout(resolve, backoff));
}

export async function acquireEmbedSlot(orgId: string, env: Env): Promise<number> {
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    let reservation: Awaited<ReturnType<typeof reserveBudget>>;
    try {
      reservation = await reserveBudget(env, orgId, null, 'bge', 'per_second');
    } catch (e) {
      if (!isTransientLimiterBackpressure(e)) throw e;
      await waitForEmbedLimiterRetry(startedAt, attempt++, 'limiter_backpressure');
      continue;
    }

    if (reservation.decision === 'ok') {
      return Date.now() - startedAt;
    }

    if (reservation.decision === 'circuit_open') {
      throw new Error(
        `EMBED_RATE_LIMIT_CIRCUIT_OPEN until ${reservation.circuit_open_until || 'unknown'}`
      );
    }

    const windowEndMs = Date.parse(reservation.window_ends_at);
    const preferredDelayMs = Number.isFinite(windowEndMs)
      ? Math.max(50, windowEndMs - Date.now() + 25)
      : undefined;
    await waitForEmbedLimiterRetry(startedAt, attempt++, 'budget_over_cap', preferredDelayMs);
  }
}

// --- Microsoft Graph API rate tracking (§6.1) ---
//
// Phase 3.1 (2026-05-04): migrated from KV-backed counter to the
// upstream_budget_ledger (Phase 0). Caller signatures unchanged so all
// 14 existing call sites keep working without edits. Ledger gives us
// cross-org visibility (System Status budgets section) plus circuit-
// breaker auto-tune-down on repeated 429s. The Graph cap (8000 calls
// per 10 min — 80% of Microsoft's 10K hard limit) is encoded as
// `graph.ten_minute = 8000` in upstream-budget.ts DEFAULT_CAPS.
//
// The previous KV keys (`graph_rpm:<orgId>`) are abandoned — TTL was
// 660s so they expire naturally within ~11 minutes after deploy. No
// cleanup script needed; downstream callers don't read the KV state.
//
// 429 detection: the existing pre-check `checkGraphRateLimit` cannot
// observe upstream 429s (it's just a counter). The actual 429 from
// Microsoft Graph fires inside the fetch loop in src/integrations/
// outlook.ts; that's where Phase 3.1 also adds `recordRateLimit`
// calls so the ledger's circuit-breaker auto-tune-down rule fires.

export async function checkGraphRateLimit(
  orgId: string,
  env: Env
): Promise<boolean> {
  const result = await checkBudget(env, orgId, null, 'graph', 'ten_minute');
  return result.decision === 'ok';
}

export async function recordGraphApiCall(
  orgId: string,
  env: Env,
  count: number = 1
): Promise<void> {
  await recordUsage(env, orgId, null, 'graph', 'ten_minute', count);
}
