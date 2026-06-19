import type { Env } from '../types/env';

import { signJwt } from './auth';
import { errorResponse, jsonResponse } from './utils';

type PreviewUserRow = {
  id: string;
  org_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  email_verified: number | null;
  is_active: number | null;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadOnlyPreviewRequest(request: Request, env: Env): boolean {
  if (env.READ_ONLY_PROD_PREVIEW !== '1') return false;

  try {
    const url = new URL(request.url);
    return LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function isMutatingMethod(method: string): boolean {
  return !READ_ONLY_METHODS.has(method.toUpperCase());
}

export function readOnlyPreviewMutationResponse(): Response {
  return errorResponse(
    'READ_ONLY_PREVIEW',
    405,
    'This local API is connected to production data in read-only preview mode. Mutating requests are blocked.'
  );
}

export async function handleReadOnlyPreviewLogin(request: Request, env: Env): Promise<Response> {
  if (!isReadOnlyPreviewRequest(request, env)) {
    return errorResponse(
      'READ_ONLY_PREVIEW_DISABLED',
      403,
      'Read-only production preview login is only available from localhost when READ_ONLY_PROD_PREVIEW=1.'
    );
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return errorResponse('BAD_JSON', 400, 'Expected a JSON body.');
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email) {
    return errorResponse('EMAIL_REQUIRED', 400, 'Email is required.');
  }

  const allowedEmail = env.READ_ONLY_PREVIEW_EMAIL?.trim().toLowerCase();
  if (allowedEmail && email !== allowedEmail) {
    return errorResponse(
      'READ_ONLY_PREVIEW_EMAIL_NOT_ALLOWED',
      403,
      'This local preview is restricted to the configured preview email.'
    );
  }

  const user = await env.D1.prepare(`
    SELECT id, org_id, email, full_name, role, email_verified, is_active
    FROM users
    WHERE lower(email) = ? AND deleted_at IS NULL
    LIMIT 1
  `).bind(email).first<PreviewUserRow>();

  if (!user) {
    return errorResponse('USER_NOT_FOUND', 404, 'No active user was found for that email.');
  }
  if (user.is_active === 0) {
    return errorResponse('USER_INACTIVE', 403, 'That user is inactive.');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
  const token = await signJwt({
    sub: user.id,
    org_id: user.org_id,
    role: user.role || 'member',
    email: user.email,
    purpose: 'session',
    exp: expiresAt,
  }, env);

  return jsonResponse({
    token,
    read_only: true,
    expires_at: expiresAt,
    user: {
      id: user.id,
      org_id: user.org_id,
      email: user.email,
      full_name: user.full_name,
      role: user.role || 'member',
      email_verified: Boolean(user.email_verified),
    },
  });
}
