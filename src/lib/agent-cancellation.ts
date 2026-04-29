// In-isolate registry of active agent requests + their AbortControllers.
//
// Workers run on multiple isolates and a cancel POST might land on a
// different isolate than the one running the streamed query. This module
// provides the same-isolate fast path; the slow cross-isolate path uses
// KV markers (see KV_CANCEL_KEY / writeCancelMarker / readCancelMarker
// below). Same-isolate cancellation is sub-50ms; KV cross-isolate is
// poll-interval bound (~1s).
//
// Lifecycle:
//   register(id)       — at the top of queryAgent, returns AbortController
//   cancel(id)         — POST /api/agent/cancel, aborts + writes KV marker
//   wasCancelled(id)   — checked after the stream ends to decide metadata
//   unregister(id)     — try/finally cleanup at end of queryAgent
import type { Env } from '../types/env';

interface Entry {
  controller: AbortController;
  aborted: boolean;
}

const active = new Map<string, Entry>();

const KV_CANCEL_PREFIX = 'agent_cancel:';
const KV_CANCEL_TTL_SECONDS = 120;

export function registerActiveRequest(requestId: string): AbortController {
  const controller = new AbortController();
  active.set(requestId, { controller, aborted: false });
  return controller;
}

// Same-isolate abort. Returns true when the controller is found locally.
// Always also writes a KV marker so a different isolate's polling check
// can pick up the intent if the stream is running there instead.
export async function cancelRequest(requestId: string, env: Env): Promise<{ local: boolean }> {
  let local = false;
  const entry = active.get(requestId);
  if (entry) {
    entry.aborted = true;
    try { entry.controller.abort(); } catch { /* already aborted */ }
    local = true;
  }
  // Best-effort cross-isolate hint. Short TTL because cancellation is
  // race-y by nature — if the query already finished, the marker should
  // age out before any future request_id collision.
  await env.KV.put(`${KV_CANCEL_PREFIX}${requestId}`, '1', {
    expirationTtl: KV_CANCEL_TTL_SECONDS,
  }).catch(() => {});
  return { local };
}

export function wasCancelled(requestId: string): boolean {
  return !!active.get(requestId)?.aborted;
}

export function unregisterRequest(requestId: string): void {
  active.delete(requestId);
}

// For the capture-stream code path that runs inside ctxExec.waitUntil after
// the response writer is closed: check both the in-isolate flag AND the KV
// marker. Either signals the assistant turn should be persisted as cancelled.
export async function wasCancelledIncludingKV(requestId: string, env: Env): Promise<boolean> {
  if (wasCancelled(requestId)) return true;
  try {
    const marker = await env.KV.get(`${KV_CANCEL_PREFIX}${requestId}`);
    return marker !== null;
  } catch {
    return false;
  }
}
