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

  // --- Queues ---
  AUDIT_QUEUE: Queue<AuditEvent>;
  AUDIT_DLQ: Queue<AuditEvent>;
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
  WEBHOOK_DLQ: Queue<WebhookQueueMessage>;
  RAG_REINDEX_QUEUE?: Queue<RagReindexQueueMessage>;

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
  AZURE_CLIENT_SECRET: string;
  AZURE_TENANT_ID: string;
  AZURE_REDIRECT_URI: string;

  ANTHROPIC_API_KEY: string;
  GOOGLE_GEMINI_API_KEY: string;
  GEMINI_MAX_RPM?: string;
  RAG_RETRIEVAL_VERSION?: string;
  RAG_EMBEDDING_PROFILE?: string;
  RAG_V2_EMBEDDING_BATCH_SIZE?: string;
  RAG_V2_QUEUE_DISPATCH_BATCH?: string;
  RAG_V2_QUEUE_MAX_ACTIVE?: string;
  SEMANTIC_INTELLIGENCE_ENABLED?: string;
  SEMANTIC_INTELLIGENCE_WATCHDOG_ENABLED?: string;
  SEMANTIC_INTELLIGENCE_BURST_TICKS?: string;
  MINILM_EMBEDDING_ENDPOINT?: string;
  MINILM_EMBEDDING_API_KEY?: string;

  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;

  REVERSECONTACT_API_KEY: string;

  FIREFLY_WEBHOOK_SECRET: string;

  TOKEN_ENCRYPTION_KEY: string;
  JWT_SECRET: string;

  // --- Signup ---
  // Comma-separated list of email domains permitted for self-signup, e.g. "medinavc.com".
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
