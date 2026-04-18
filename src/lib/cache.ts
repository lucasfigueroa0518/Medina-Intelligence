// TRD §8.6 — D1-based cache invalidation
import type { Env } from '../types/env';
import type { HydratedChunk } from '../types/interfaces';

export async function invalidateRagCache(orgId: string, env: Env): Promise<void> {
  await env.D1.prepare(
    `UPDATE org_cache_state SET last_modified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ?`
  ).bind(orgId).run();

  // Self-heal: if row missing, create it
  await env.D1.prepare(
    `INSERT OR IGNORE INTO org_cache_state (org_id) VALUES (?)`
  ).bind(orgId).run();
}

export async function getCachedRagResult(
  cacheKey: string,
  orgId: string,
  env: Env
): Promise<HydratedChunk[] | null> {
  const cached = await env.KV.get<{ data: HydratedChunk[]; cached_at: string }>(
    cacheKey,
    'json'
  );
  if (!cached) return null;

  const state = await env.D1.prepare(
    'SELECT last_modified_at FROM org_cache_state WHERE org_id = ?'
  ).bind(orgId).first<{ last_modified_at: string }>();

  if (state && state.last_modified_at > cached.cached_at) {
    await env.KV.delete(cacheKey);
    return null;
  }
  return cached.data;
}

export async function setCachedRagResult(
  cacheKey: string,
  data: HydratedChunk[],
  env: Env
): Promise<void> {
  await env.KV.put(
    cacheKey,
    JSON.stringify({ data, cached_at: new Date().toISOString() }),
    { expirationTtl: 3600 }
  );
}
