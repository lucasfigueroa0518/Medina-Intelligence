// TRD §5.1, §12 — Email campaign CRUD + send
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';

export async function listCampaigns(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT * FROM email_campaigns WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`
  ).bind(ctx.orgId).all();
  return jsonResponse({ campaigns: rows.results });
}

export async function createCampaign(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.title || !body?.subject || !body?.body_template || !body?.sender_user_id) {
    return errorResponse('VALIDATION_ERROR', 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO email_campaigns
       (id, org_id, created_by, sender_user_id, title, subject, body_template, filter_criteria, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      ctx.userId,
      body.sender_user_id,
      body.title,
      body.subject,
      body.body_template,
      JSON.stringify(body.filter_criteria || {}),
      now,
      now
    )
    .run();

  const campaign = await env.D1.prepare('SELECT * FROM email_campaigns WHERE id = ?').bind(id).first();
  return jsonResponse({ campaign }, 201);
}

export async function getCampaign(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const campaign = await env.D1.prepare(
    'SELECT * FROM email_campaigns WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!campaign) return errorResponse('CAMPAIGN_NOT_FOUND', 404);

  const recipients = await env.D1.prepare(
    `SELECT ecr.*, c.full_name FROM email_campaign_recipients ecr
     LEFT JOIN contacts c ON c.id = ecr.contact_id
     WHERE ecr.campaign_id = ?`
  ).bind(id).all();

  return jsonResponse({ campaign, recipients: recipients.results });
}

export async function updateCampaign(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  const allowed = [
    'title',
    'subject',
    'body_template',
    'filter_criteria',
    'sender_user_id',
    'scheduled_at',
    'status',
  ];
  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (body && k in body) {
      updates.push(`${k} = ?`);
      binds.push(typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]);
    }
  }
  if (updates.length === 0) return jsonResponse({ ok: true });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

  await env.D1.prepare(
    `UPDATE email_campaigns SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`
  ).bind(...binds, id, ctx.orgId).run();

  return jsonResponse({ ok: true });
}

export async function sendCampaign(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const campaign = await env.D1.prepare(
    'SELECT * FROM email_campaigns WHERE id = ? AND org_id = ? AND status = ?'
  ).bind(id, ctx.orgId, 'draft').first<any>();
  if (!campaign) return errorResponse('CAMPAIGN_NOT_FOUND_OR_NOT_DRAFT', 404);

  // Build recipient list from filter_criteria
  const recipients = await buildRecipientListFromFilter(
    JSON.parse(campaign.filter_criteria || '{}'),
    ctx.orgId,
    env
  );

  if (recipients.length === 0) {
    return errorResponse('NO_RECIPIENTS', 400);
  }

  // Insert recipients
  for (const r of recipients) {
    await env.D1.prepare(
      `INSERT OR IGNORE INTO email_campaign_recipients (id, campaign_id, contact_id, email, status)
       VALUES (?, ?, ?, ?, 'pending')`
    ).bind(crypto.randomUUID(), id, r.id, r.email).run();
  }

  await env.D1.prepare(
    `UPDATE email_campaigns SET status = 'scheduled', total_recipients = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(recipients.length, id).run();

  // Trigger the CampaignSendWorkflow
  await env.CAMPAIGN_WORKFLOW.create({
    id: `campaign-${id}`,
    params: { campaign_id: id, org_id: ctx.orgId },
  });

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'campaign_send',
    entity_type: 'campaign',
    entity_id: id,
    metadata: { total_recipients: recipients.length },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, total_recipients: recipients.length });
}

async function buildRecipientListFromFilter(
  filter: any,
  orgId: string,
  env: Env
): Promise<Array<{ id: string; email: string }>> {
  const where: string[] = [
    'c.org_id = ?',
    'c.deleted_at IS NULL',
    'c.email IS NOT NULL',
    'c.email != \'\'',
    'ml.contact_id IS NULL',
  ];
  const binds: unknown[] = [orgId];

  if (filter.contact_types?.length) {
    where.push(
      `c.contact_type IN (${filter.contact_types.map(() => '?').join(',')})`
    );
    binds.push(...filter.contact_types);
  }
  if (filter.company_id) {
    where.push('c.company_id = ?');
    binds.push(filter.company_id);
  }
  if (filter.keyword) {
    where.push('(c.full_name LIKE ? OR c.email LIKE ?)');
    binds.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
  }

  const rows = await env.D1.prepare(
    `SELECT c.id, c.email FROM contacts c
     LEFT JOIN merge_locks ml ON c.id = ml.contact_id AND ml.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE ${where.join(' AND ')}
     LIMIT 5000`
  ).bind(...binds).all<{ id: string; email: string }>();

  return rows.results;
}
