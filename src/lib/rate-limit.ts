// TRD §5.3 — Claude + enrichment rate limiters
import type { Env } from '../types/env';

interface ClaudeRateState {
  count: number;
  resets_at: string;
}

export async function checkClaudeRateLimit(
  env: Env,
  orgId: string,
  priority: 'high' | 'low'
): Promise<boolean> {
  const key = `claude_rate:${orgId}`;
  const state = await env.KV.get<ClaudeRateState>(key, 'json');
  const now = new Date();

  if (!state || new Date(state.resets_at) < now) {
    await env.KV.put(
      key,
      JSON.stringify({ count: 1, resets_at: new Date(now.getTime() + 60000).toISOString() }),
      { expirationTtl: 120 }
    );
    return true;
  }

  const MAX_RPM = parseInt(env.CLAUDE_MAX_RPM || '60', 10);
  const RESERVE = Math.floor(MAX_RPM / 3);
  const limit = priority === 'high' ? MAX_RPM : MAX_RPM - RESERVE;

  if (state.count < limit) {
    state.count++;
    await env.KV.put(key, JSON.stringify(state), { expirationTtl: 120 });
    return true;
  }
  return false;
}

// --- Enrichment source cooldown (§5.3) ---

const BASE_BACKOFF: Record<string, number> = {
  reversecontact: 1800,
  claude_enrichment: 600,
  claude_news: 600,
};
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
