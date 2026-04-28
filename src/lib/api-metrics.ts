// Real per-service API call counters for the Command Center sparklines.
//
// Stores hourly-bucketed counts in KV under `api_calls:{service}:{org}:{hour}`
// with TTL 26h so the dashboard can read the last 24 buckets to plot real
// activity (replacing the previous estimation from sync_jobs metadata).
//
// Race tolerance: two concurrent calls can each read N and write N+1, losing
// some counts. Acceptable for a dashboard — it under-counts slightly during
// bursts, never over-counts. If we ever need exact accuracy, move to D1 with
// an INSERT into a hourly-aggregate table.
//
// Cost per API call: 1 KV read + 1 KV write. Wrapped in try/catch so a
// metrics failure never blocks the actual API call.

import type { Env } from '../types/env';

export type ApiService = 'claude' | 'gemini' | 'graph' | 'slack' | 'reversecontact';

const HOUR_TTL_SECONDS = 26 * 3600;

function hourBucketKey(service: ApiService, orgId: string, when: Date = new Date()): string {
  // 'YYYY-MM-DDTHH' — 13-char hour bucket.
  return `api_calls:${service}:${orgId}:${when.toISOString().slice(0, 13)}`;
}

export async function recordApiCall(
  env: Env,
  service: ApiService,
  orgId: string,
  count: number = 1
): Promise<void> {
  try {
    const key = hourBucketKey(service, orgId);
    const current = parseInt((await env.KV.get(key)) || '0', 10);
    const next = (Number.isFinite(current) ? current : 0) + count;
    await env.KV.put(key, String(next), { expirationTtl: HOUR_TTL_SECONDS });
  } catch (e) {
    // Metrics never block the real API call.
    console.warn(`[api-metrics] recordApiCall(${service}) failed:`, e);
  }
}

// Returns the hourly call counts for the last `hours` (default 24), oldest
// first. Missing buckets count as 0. Single batched parallel read.
export async function readHourlyCalls(
  env: Env,
  service: ApiService,
  orgId: string,
  hours: number = 24
): Promise<number[]> {
  const now = Date.now();
  const reads = Array.from({ length: hours }, (_, i) => {
    const when = new Date(now - (hours - 1 - i) * 3600_000);
    return env.KV.get(hourBucketKey(service, orgId, when))
      .then(v => parseInt(v || '0', 10))
      .catch(() => 0);
  });
  return Promise.all(reads);
}

export async function readCurrentHourCalls(
  env: Env,
  service: ApiService,
  orgId: string
): Promise<number> {
  try {
    const v = await env.KV.get(hourBucketKey(service, orgId));
    return parseInt(v || '0', 10);
  } catch {
    return 0;
  }
}
