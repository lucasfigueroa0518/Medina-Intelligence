// User profile management — only operates on the authenticated user's own
// record. Email/role/org_id are deliberately not editable here; those are
// managed through admin flows.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';

const PROFILE_FIELDS = ['full_name', 'phone', 'job_title', 'linkedin_url', 'bio', 'avatar_url'] as const;
type ProfileField = typeof PROFILE_FIELDS[number] | 'share_emails_org_wide';

interface ProfileUpdateBody {
  full_name?: string;
  phone?: string | null;
  job_title?: string | null;
  linkedin_url?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  share_emails_org_wide?: boolean;
}

/**
 * PATCH /api/users/me
 * Update the authenticated user's own profile.
 */
export async function updateMyProfile(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<ProfileUpdateBody>(request);
  if (!body) return errorResponse('INVALID_BODY', 400);

  // full_name, when present, must be non-empty.
  if (body.full_name !== undefined) {
    if (typeof body.full_name !== 'string' || body.full_name.trim().length === 0) {
      return errorResponse('VALIDATION_ERROR', 400, 'full_name must be a non-empty string');
    }
  }

  const updates: Array<{ col: ProfileField; value: string | number | null }> = [];
  for (const field of PROFILE_FIELDS) {
    if (!(field in body)) continue;
    const raw = (body as any)[field];
    if (raw === null) {
      updates.push({ col: field, value: null });
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      updates.push({ col: field, value: field === 'full_name' ? trimmed : (trimmed.length === 0 ? null : trimmed) });
    }
  }

  if ('share_emails_org_wide' in body && typeof body.share_emails_org_wide === 'boolean') {
    updates.push({ col: 'share_emails_org_wide', value: body.share_emails_org_wide ? 1 : 0 });
  }

  if (updates.length === 0) {
    return errorResponse('NO_UPDATES', 400, 'No valid fields to update');
  }

  const setClause = updates.map(u => `${u.col} = ?`).join(', ');
  const binds: (string | number | null)[] = updates.map(u => u.value);
  binds.push(ctx.userId);

  await env.D1.prepare(
    `UPDATE users SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND deleted_at IS NULL`
  ).bind(...binds).run();

  const user = await env.D1.prepare(
    `SELECT id, email, full_name, role, org_id, avatar_url, phone, job_title, linkedin_url, bio, last_login_at, share_emails_org_wide
     FROM users WHERE id = ?`
  ).bind(ctx.userId).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'user',
    entity_id: ctx.userId,
    metadata: { fields: updates.map(u => u.col) },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ user });
}

/**
 * POST /api/users/me/avatar
 * multipart/form-data with field "avatar" (file). Stores in R2 and updates avatar_url.
 */
export async function uploadMyAvatar(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return errorResponse('INVALID_CONTENT_TYPE', 400, 'Expected multipart/form-data');
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse('INVALID_BODY', 400, 'Could not parse multipart form');
  }

  const fileValue = formData.get('avatar');
  // In Workers runtime, File is shaped like Blob with name/type/size/stream(). Duck-type instead of instanceof.
  if (!fileValue || typeof fileValue === 'string' || typeof (fileValue as any).stream !== 'function') {
    return errorResponse('VALIDATION_ERROR', 400, 'avatar field is required and must be a file');
  }
  const file = fileValue as unknown as { type: string; size: number; stream(): ReadableStream };

  const allowed: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const ext = allowed[file.type.toLowerCase()];
  if (!ext) {
    return errorResponse('UNSUPPORTED_IMAGE_TYPE', 400, `Unsupported image type: ${file.type}`);
  }

  // 5 MB cap — enough for any reasonable avatar.
  if (file.size > 5 * 1024 * 1024) {
    return errorResponse('FILE_TOO_LARGE', 400, 'Avatar must be 5MB or smaller');
  }

  const r2Key = `${ctx.orgId}/avatars/${ctx.userId}.${ext}`;
  await env.R2.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  // We expose avatars via an authenticated read endpoint rather than a public R2 URL —
  // store the R2 key as the avatar_url so the frontend can resolve it through the API.
  const avatarUrl = `r2:${r2Key}`;
  await env.D1.prepare(
    `UPDATE users SET avatar_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(avatarUrl, ctx.userId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'user',
    entity_id: ctx.userId,
    metadata: { fields: ['avatar_url'] },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, avatar_url: avatarUrl });
}

/**
 * GET /api/users/me/avatar
 * Streams the current user's avatar from R2 (or any user's, if avatar_url is r2:...).
 * Reads ?key=... so the frontend can resolve any user's r2: avatar_url within the org.
 */
export async function getAvatar(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return errorResponse('VALIDATION_ERROR', 400, 'key query param required');

  // Org-scope: keys are stored as `${org_id}/avatars/...` so disallow cross-org reads.
  if (!key.startsWith(`${ctx.orgId}/avatars/`)) {
    return errorResponse('FORBIDDEN', 403);
  }

  const obj = await env.R2.get(key);
  if (!obj) return errorResponse('NOT_FOUND', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=60');
  return new Response(obj.body, { headers });
}
