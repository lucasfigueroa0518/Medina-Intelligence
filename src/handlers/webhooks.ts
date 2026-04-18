// TRD §5.2 — Webhook endpoints: Firefly + Slack
import type { Env } from '../types/env';
import { jsonResponse } from './utils';
import { extractIdempotencyKey } from '../lib/idempotency';
import { verifyFireflySignature } from '../integrations/firefly';
import { verifySlackSignature } from '../integrations/slack';

export async function receiveFireflyWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get('X-Firefly-Signature') || '';
  const rawBody = await request.text();

  if (env.FIREFLY_WEBHOOK_SECRET) {
    const valid = await verifyFireflySignature(
      env.FIREFLY_WEBHOOK_SECRET,
      rawBody,
      signature
    );
    if (!valid) {
      return jsonResponse({ error: 'INVALID_SIGNATURE' }, 401);
    }
  }

  const idempotencyKey = extractIdempotencyKey('firefly', rawBody);
  if (idempotencyKey) {
    const seen = await env.KV.get(`webhook_idem:${idempotencyKey}`);
    if (seen) return jsonResponse({ ok: true, duplicate: true });
    await env.KV.put(`webhook_idem:${idempotencyKey}`, '1', {
      expirationTtl: 86400,
    });
  }

  await env.WEBHOOK_QUEUE.send({
    source: 'firefly',
    receivedAt: new Date().toISOString(),
    idempotencyKey,
    rawPayload: rawBody,
    signatureHeader: signature,
  });

  return jsonResponse({ ok: true });
}

export async function receiveSlackWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp') || '';
  const signature = request.headers.get('X-Slack-Signature') || '';
  const rawBody = await request.text();

  if (env.SLACK_SIGNING_SECRET && timestamp && signature) {
    const valid = await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      timestamp,
      rawBody,
      signature
    );
    if (!valid) return jsonResponse({ error: 'INVALID_SIGNATURE' }, 401);
  }

  // Slack URL verification handshake
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed.type === 'url_verification' && parsed.challenge) {
      return new Response(parsed.challenge, { status: 200 });
    }
  } catch {
    /* non-JSON bodies — form-encoded slash commands */
  }

  const idempotencyKey = extractIdempotencyKey('slack', rawBody);
  if (idempotencyKey) {
    const seen = await env.KV.get(`webhook_idem:${idempotencyKey}`);
    if (seen) return jsonResponse({ ok: true, duplicate: true });
    await env.KV.put(`webhook_idem:${idempotencyKey}`, '1', {
      expirationTtl: 86400,
    });
  }

  await env.WEBHOOK_QUEUE.send({
    source: 'slack',
    receivedAt: new Date().toISOString(),
    idempotencyKey,
    rawPayload: rawBody,
  });

  return jsonResponse({ ok: true });
}
