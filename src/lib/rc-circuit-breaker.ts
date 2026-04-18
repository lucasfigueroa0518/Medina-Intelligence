// ReverseContact 401 circuit breaker.
//
// KV key: rc_failures:{org_id}  (TTL 24h — auto-heals if the operator forgets)
// Opens after 3 consecutive 401 responses. While open we short-circuit BOTH
// LinkedIn URL discovery and the ReverseContact call — no point paying Claude
// RPM to find a LinkedIn URL we can't then enrich.
// Reset manually with: wrangler kv:key delete rc_failures:{org_id}

import type { Env } from '../types/env';

const TTL_SECONDS = 86400;
const OPEN_THRESHOLD = 3;

function key(orgId: string): string {
  return `rc_failures:${orgId}`;
}

export async function isRcCircuitOpen(orgId: string, env: Env): Promise<boolean> {
  const raw = await env.KV.get(key(orgId));
  if (!raw) return false;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= OPEN_THRESHOLD;
}

export async function recordRcFailure(orgId: string, env: Env): Promise<number> {
  const raw = await env.KV.get(key(orgId));
  const prev = raw ? parseInt(raw, 10) : 0;
  const next = (Number.isFinite(prev) ? prev : 0) + 1;
  await env.KV.put(key(orgId), String(next), { expirationTtl: TTL_SECONDS });
  if (next >= OPEN_THRESHOLD) {
    console.warn(
      `[rc-circuit] OPEN — ${next} consecutive 401s for org ${orgId}. ` +
        `Fix the API key and run: wrangler kv:key delete ${key(orgId)}`
    );
  }
  return next;
}

export async function resetRcFailures(orgId: string, env: Env): Promise<void> {
  await env.KV.delete(key(orgId));
}
