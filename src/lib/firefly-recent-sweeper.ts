import type { Env } from '../types/env';
import { getFireflyKey } from './firefly-credentials';
import { fetchTranscriptBatch, FIREFLY_PAGE_SIZE } from './firefly-ingest';
import { recordFireflyApiCall } from './firefly-progressive-backfill';
import { enqueueFireflyTranscriptHydration } from './firefly-webhook-deliveries';
import { reportIngestionFailure, reportIngestionSuccess } from './ingestion-health';

interface CredentialedUser {
  user_id: string;
  email: string | null;
}

export interface FireflyRecentSweepResult {
  users_scanned: number;
  source_transcripts: number;
  missing_transcripts: number;
  enqueued: number;
  errors: Array<{ user_id: string; error: string }>;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function credentialedUsersForOrg(orgId: string, env: Env): Promise<CredentialedUser[]> {
  const rows = await env.D1.prepare(
    `SELECT u.id AS user_id, u.email
       FROM user_firefly_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE u.org_id = ?
        AND u.deleted_at IS NULL
        AND COALESCE(u.is_active, 1) = 1
      ORDER BY COALESCE(c.last_used_at, c.updated_at, c.created_at) DESC`
  ).bind(orgId).all<CredentialedUser>();
  return rows.results;
}

async function existingFireflyIds(orgId: string, ids: string[], env: Env): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.D1.prepare(
      `SELECT firefly_event_id
         FROM firefly_transcript_items
        WHERE org_id = ?
          AND firefly_event_id IN (${placeholders})`
    ).bind(orgId, ...chunk).all<{ firefly_event_id: string }>();
    for (const row of rows.results) existing.add(row.firefly_event_id);
  }
  return existing;
}

export async function runFireflyRecentSweeper(
  orgId: string,
  env: Env,
  opts: { daysBack?: number; maxPagesPerUser?: number } = {}
): Promise<FireflyRecentSweepResult> {
  const daysBack = Math.max(1, Math.min(10, opts.daysBack ?? 7));
  const maxPagesPerUser = Math.max(1, Math.min(3, opts.maxPagesPerUser ?? 2));
  const fromDate = daysAgoIso(daysBack);
  const toDate = new Date().toISOString();
  const users = await credentialedUsersForOrg(orgId, env);

  const result: FireflyRecentSweepResult = {
    users_scanned: 0,
    source_transcripts: 0,
    missing_transcripts: 0,
    enqueued: 0,
    errors: [],
  };

  for (const user of users) {
    result.users_scanned++;
    const key = await getFireflyKey(user.user_id, env);
    if (!key) {
      result.errors.push({ user_id: user.user_id, error: 'missing_or_decrypt_failed' });
      await reportIngestionFailure(env, {
        orgId,
        source: 'firefly',
        scopeType: 'user',
        scopeId: user.user_id,
        code: 'firefly_credential_unusable',
        message: `Fireflies credential for ${user.email || user.user_id} could not be decrypted or loaded.`,
        severity: 'critical',
        humanActionRequired: true,
      });
      continue;
    }

    try {
      const ids: string[] = [];
      for (let page = 0; page < maxPagesPerUser; page++) {
        const skip = page * FIREFLY_PAGE_SIZE;
        const batch = await fetchTranscriptBatch(key, fromDate, toDate, FIREFLY_PAGE_SIZE, skip);
        await recordFireflyApiCall(user.user_id, env, false, orgId).catch(() => {});
        for (const transcript of batch) {
          if (transcript.id) ids.push(transcript.id);
        }
        if (batch.length < FIREFLY_PAGE_SIZE) break;
      }

      result.source_transcripts += ids.length;
      const existing = await existingFireflyIds(orgId, [...new Set(ids)], env);
      for (const id of [...new Set(ids)]) {
        if (existing.has(id)) continue;
        result.missing_transcripts++;
        const queued = await enqueueFireflyTranscriptHydration(env, orgId, {
          firefly_event_id: id,
          source: 'recent_sweep',
          user_id: user.user_id,
        }, { priority: 32 });
        if (queued.inserted) result.enqueued++;
      }

      await reportIngestionSuccess(env, {
        orgId,
        source: 'firefly',
        scopeType: 'user',
        scopeId: user.user_id,
        metadata: {
          recent_sweep: true,
          days_back: daysBack,
          source_transcripts: ids.length,
          missing_transcripts: ids.filter(id => !existing.has(id)).length,
        },
      }).catch(() => {});
    } catch (e: any) {
      const message = String(e?.message || e);
      if (message.includes('FIREFLY_RATE_LIMITED')) {
        await recordFireflyApiCall(user.user_id, env, true, orgId).catch(() => {});
      }
      result.errors.push({ user_id: user.user_id, error: message.slice(0, 300) });
      await reportIngestionFailure(env, {
        orgId,
        source: 'firefly',
        scopeType: 'user',
        scopeId: user.user_id,
        code: message.includes('FIREFLY_RATE_LIMITED')
          ? 'firefly_recent_sweep_rate_limited'
          : 'firefly_recent_sweep_failed',
        message: `Fireflies recent transcript sweep failed for ${user.email || user.user_id}: ${message.slice(0, 300)}`,
        severity: message.includes('FIREFLY_AUTH_FAILED') ? 'critical' : 'warning',
        humanActionRequired: /FIREFLY_AUTH_FAILED|credential|decrypt/i.test(message),
        recoveryWindowStart: fromDate,
        recoveryWindowEnd: toDate,
      });
    }
  }

  return result;
}
