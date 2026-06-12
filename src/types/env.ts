import type { AuditEvent } from './audit';
import type { WebhookQueueMessage } from './webhooks';
import type { RagReindexQueueMessage } from './rag-v2';

export interface Env {
  // --- Storage ---
  D1: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;

  // --- AI & Vector ---
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  VECTORIZE_RAG_V2_BGE?: VectorizeIndex;
  VECTORIZE_RAG_V2_QWEN3?: VectorizeIndex;
  VECTORIZE_RAG_V2_MINILM?: VectorizeIndex;
  BROWSER?: Fetcher;

  // --- Queues ---
  AUDIT_QUEUE: Queue<AuditEvent>;
  AUDIT_DLQ: Queue<AuditEvent>;
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
  WEBHOOK_DLQ: Queue<WebhookQueueMessage>;
  RAG_REINDEX_QUEUE?: Queue<RagReindexQueueMessage>;

  // --- Service bindings ---
  PIPELINES?: PipelinesService;
  API?: Fetcher;

  // --- Workflows ---
  INGESTION_WORKFLOW: Workflow;
  INGESTION_CHUNK_WORKFLOW: Workflow;
  INGESTION_FINALIZER_WORKFLOW: Workflow;
  ENRICHMENT_WORKFLOW: Workflow;
  CAMPAIGN_WORKFLOW: Workflow;
  DAILY_CRON_WORKFLOW: Workflow;

  // --- Vars (from wrangler.toml [vars]) ---
  ENVIRONMENT: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_AI_GATEWAY_SLUG: string;
  CLAUDE_MAX_RPM?: string;
  MARTY_LAB_OPUS_MODEL?: string;
  MARTY_LAB_HAIKU_MODEL?: string;
  MARTY_LAB_CODE_PATCH_MODEL?: string;
  MARTY_NORMAL_MODEL?: string;
  MARTY_MAX_MODEL?: string;
  PROSPECT_CLASSIFIER_MODEL?: string;
  PROSPECT_LIST_CLASSIFIER_MODEL?: string;
  PROSPECT_ORG_EXTRACTOR_MODEL?: string;
  PROSPECT_PRODUCTION_SAMPLE_RATE?: string;
  MARTY_RUNTIME_GIT_SHA?: string;
  MEDINA_BUILD_SHA?: string;
  FIREFLIES_PIPELINE_VERSION?: string;
  // Premium deck rendering is orchestrated by the Worker but executed by a
  // separate Node/Playwright service. Keep optional so the HTML-first fallback
  // can deploy before the renderer service is provisioned.
  DECK_RENDERER_ENABLED?: string;
  DECK_RENDERER_PROVIDER?: 'cloudflare' | 'external' | string;
  DECK_RENDERER_URL?: string;
  DECK_RENDERER_TOKEN?: string;
  // Optional: gateway-level token. Only required when the AI Gateway has
  // "Authenticated Gateway" enabled. Set via `wrangler secret put CLOUDFLARE_AI_GATEWAY_TOKEN`.
  CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
  // Frontend origin the OAuth callback redirects back to after storing tokens.
  // Defaults to http://localhost:3000 when unset.
  FRONTEND_URL?: string;
  // Comma-separated list of allowed CORS origins.
  ALLOWED_ORIGINS?: string;

  // --- Secrets (via `wrangler secret put`) ---
  AZURE_CLIENT_ID: string;
  AZURE_CLIENT_SECRET?: string;
  AZURE_TENANT_ID: string;
  AZURE_REDIRECT_URI?: string;
  AZURE_CLIENT_CERT_PRIVATE_KEY?: string;
  AZURE_CLIENT_CERT_THUMBPRINT?: string;
  OUTLOOK_AUTH_MODE?: 'app_only' | 'delegated_fallback';
  OUTLOOK_DELEGATED_FALLBACK_ENABLED?: string;
  OUTLOOK_SYSTEM_SENDER_EMAIL?: string;
  OUTLOOK_WEBHOOK_BASE_URL?: string;

  ANTHROPIC_API_KEY: string;
  GOOGLE_GEMINI_API_KEY: string;
  GEMINI_MAX_RPM?: string;
  RAG_RETRIEVAL_VERSION?: string;
  RAG_EMBEDDING_PROFILE?: string;
  RAG_V2_QUEUE_DISPATCH_BATCH?: string;
  RAG_V2_QUEUE_MAX_ACTIVE?: string;
  MINILM_EMBEDDING_ENDPOINT?: string;
  MINILM_EMBEDDING_API_KEY?: string;

  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;

  REVERSECONTACT_API_KEY: string;

  FIREFLY_WEBHOOK_SECRET: string;

  TOKEN_ENCRYPTION_KEY: string;
  PIPELINES_INTERNAL_TOKEN?: string;
  JWT_SECRET: string;

  // --- Signup ---
  // Comma-separated list of first-class internal email domains, e.g. "medinavc.com,medinacapital.com".
  INTERNAL_DOMAINS?: string;
  // Legacy override for self-signup. When unset, INTERNAL_DOMAINS is used.
  ALLOWED_SIGNUP_DOMAINS?: string;
  // Org assigned to self-signups.
  DEFAULT_SIGNUP_ORG_ID?: string;
}

// Cloudflare Workflows types.
// WorkflowEntrypoint, WorkflowStep, and WorkflowEvent come from the
// 'cloudflare:workers' runtime module (declared by @cloudflare/workers-types).
// Workflow classes MUST extend the runtime's WorkflowEntrypoint — a userland
// shim will silently fail (missing __WORKFLOW_ENTRYPOINT_BRAND symbol).
//
// The Workflow / WorkflowInstance interfaces below type the BINDING
// (env.INGESTION_WORKFLOW, env.CAMPAIGN_WORKFLOW, etc.), not the entrypoint class.
export interface Workflow {
  create(options: { id?: string; params?: unknown }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

export interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string }>;
}

export type PipelineWorkflowName = 'ingestion' | 'enrichment' | 'campaign';

export interface PipelineWorkflowDispatch {
  workflow: PipelineWorkflowName;
  id?: string;
  params?: unknown;
}

export interface PipelinesService {
  triggerWorkflow(input: PipelineWorkflowDispatch): Promise<{ id: string }>;
}
