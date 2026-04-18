// TRD §12.2 — Microsoft Graph Mail.Send helper
import type { Env } from '../types/env';
import { getDecryptedAccessToken } from '../lib/helpers';

export interface SendMailParams {
  senderUserId: string;
  subject: string;
  body: string;
  toEmail: string;
}

export interface SendMailResult {
  ok: boolean;
  status: number;
  errorMessage?: string;
  retryAfter?: number;
}

export async function sendViaOutlook(
  params: SendMailParams,
  env: Env
): Promise<SendMailResult> {
  let token: string;
  try {
    token = await getDecryptedAccessToken(params.senderUserId, env);
  } catch {
    return { ok: false, status: 401, errorMessage: 'AUTH_TOKEN_INVALID' };
  }

  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: params.subject,
        body: { contentType: 'HTML', content: params.body },
        toRecipients: [{ emailAddress: { address: params.toEmail } }],
      },
      saveToSentItems: true,
    }),
  });

  if (resp.ok) return { ok: true, status: resp.status };

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '60', 10);
    return { ok: false, status: 429, retryAfter };
  }

  const errText = await resp.text();
  return {
    ok: false,
    status: resp.status,
    errorMessage: `OUTLOOK_SEND_FAILED: ${resp.status} ${errText.slice(0, 300)}`,
  };
}
