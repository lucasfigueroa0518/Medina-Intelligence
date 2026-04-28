// Step-name telemetry for CF Workflows.
//
// Audit 2026-04-28 finding: when a workflow step fails, sync_jobs.error_message
// captures the error but not WHICH step threw it. We had to infer the failing
// step ("fetch-core-sources timed out") only because metadata was empty. This
// helper writes the step name into metadata around every step.do() call so the
// failing step is recorded directly in D1.
//
// The writes happen OUTSIDE step.do(), so they are not durable in the
// CF Workflows sense — they re-fire on workflow restart. That is intentional:
// (a) writes are idempotent (same value); (b) `current_step_started_at` then
// reflects the most recent attempt, which is the useful number; (c) failure
// telemetry must run from the catch block, which is necessarily outside.

import type { Env } from '../types/env';
import type {
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepContext,
} from 'cloudflare:workers';

type Callback<T> = (ctx: WorkflowStepContext) => Promise<T>;

export function trackedStep<T>(
  env: Env,
  step: WorkflowStep,
  jobId: string | null,
  name: string,
  callback: Callback<T>
): Promise<T>;
export function trackedStep<T>(
  env: Env,
  step: WorkflowStep,
  jobId: string | null,
  name: string,
  config: WorkflowStepConfig,
  callback: Callback<T>
): Promise<T>;
export async function trackedStep<T>(
  env: Env,
  step: WorkflowStep,
  jobId: string | null,
  name: string,
  configOrCallback: WorkflowStepConfig | Callback<T>,
  maybeCallback?: Callback<T>
): Promise<T> {
  const callback: Callback<T> =
    typeof configOrCallback === 'function'
      ? (configOrCallback as Callback<T>)
      : (maybeCallback as Callback<T>);
  const config: WorkflowStepConfig | undefined =
    typeof configOrCallback === 'function' ? undefined : (configOrCallback as WorkflowStepConfig);

  if (jobId) {
    try {
      await env.D1.prepare(
        `UPDATE sync_jobs
            SET metadata = json_set(
                  COALESCE(metadata, '{}'),
                  '$.current_step', ?,
                  '$.current_step_started_at', ?
                )
          WHERE id = ?`
      ).bind(name, new Date().toISOString(), jobId).run();
    } catch {
      // Telemetry must never block the workflow.
    }
  }

  try {
    // Cast through `any` because step.do enforces T extends Rpc.Serializable<T>
    // at its call site; we propagate T from the caller (which already passed
    // that check) without re-asserting it inside this generic wrapper.
    const result = (config
      ? await (step.do as any)(name, config, callback)
      : await (step.do as any)(name, callback)) as T;

    if (jobId) {
      try {
        await env.D1.prepare(
          `UPDATE sync_jobs
              SET metadata = json_set(COALESCE(metadata, '{}'), '$.last_completed_step', ?)
            WHERE id = ?`
        ).bind(name, jobId).run();
      } catch {
        /* ignore */
      }
    }
    return result;
  } catch (e) {
    if (jobId) {
      try {
        const msg = e instanceof Error ? e.message : String(e);
        await env.D1.prepare(
          `UPDATE sync_jobs
              SET metadata = json_set(
                    COALESCE(metadata, '{}'),
                    '$.failed_step', ?,
                    '$.failed_step_error', ?
                  )
            WHERE id = ?`
        ).bind(name, msg.slice(0, 500), jobId).run();
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}
