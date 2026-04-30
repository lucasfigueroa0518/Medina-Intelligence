// Q12 — synthetic observations API.
//
// GET /api/entities/:type/:id/observations
//   Lists active observations for the entity. Org-isolation via the
//   entity table join inside listObservationsForEntity. Returns rows
//   ordered by last_observed_at DESC.
//
// POST /api/observations/:id/dismiss
//   Marks an observation as dismissed by the calling user. A
//   subsequent re-sighting by the LLM CLEARS the dismissal — a
//   dismissed observation that's still being seen is worth re-surfacing.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import {
  dismissObservation,
  listObservationsForEntity,
} from '../lib/synthetic-observations';

function tableForEntity(t: 'contact' | 'company' | 'deal'): string {
  if (t === 'contact') return 'contacts';
  if (t === 'company') return 'companies';
  return 'deals';
}

export async function listEntityObservations(
  entityType: string,
  entityId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (entityType !== 'contact' && entityType !== 'company' && entityType !== 'deal') {
    return errorResponse('VALIDATION_ERROR', 400, 'entity_type must be contact|company|deal');
  }
  // ACL — caller must have access to the entity in their org. Hides
  // existence of cross-org entities behind the same 404 shape as the
  // detail endpoints.
  const table = tableForEntity(entityType);
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(entityId, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) return errorResponse('NOT_FOUND', 404);

  const observations = await listObservationsForEntity(
    entityType, entityId, ctx.orgId, env
  );
  return jsonResponse({ observations });
}

export async function dismissEntityObservation(
  observationId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!observationId) return errorResponse('VALIDATION_ERROR', 400);
  const result = await dismissObservation(observationId, ctx.userId, ctx.orgId, env);
  if (!result.ok) return errorResponse('NOT_FOUND', 404, 'observation not found or already dismissed');
  return jsonResponse({ ok: true });
}
