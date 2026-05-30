import type { Env } from '../types/env';
import type { AgentSession, AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { preprocessQuery, retrieveContext, TOKEN_BUDGET, type RetrievalOptions } from '../lib/retrieval';
import { buildSourcesAndContext, filterCitationSourcesForViewer, type CitationSource } from '../lib/citations';
import { normalizeCitationMarkers } from '../lib/citation-format';
import { verifySampleClaims } from '../lib/citation-verifier';
import { callClaude, callClaudeStreaming } from '../lib/claude';
import type { ToolDefinition } from '../lib/claude';
import { extractTextFromFile } from '../lib/file-extraction';
import { assembleSessionAttachments, type UploadSummary } from '../lib/chat-uploads';
import {
  createDeckArtifactTool,
  createDocumentArtifactTool,
  editDocumentArtifactTool,
  findDocumentsTool,
  getDeckJobSnapshot,
  normalizeDocumentCards,
  type MartyDocumentCard,
} from '../lib/document-artifacts';
import { SESSION_TITLE_PROMPT } from '../prompts/session-title';
import { estimateTokens, truncateToTokens } from '../lib/tokens';
import { emitAudit } from '../lib/audit';
import {
  searchContacts, searchCompanies, searchDeals, searchProspects, queryDealFlow, getProspectEvidence, searchConversations,
  searchEvents, recall, sweepConversations,
  getFirmRelationshipSnapshotTool, setFirmCompanyRelationshipTool,
  getContactDetail, getCompanyDetail, getDealDetail,
  createContactTool, updateContactTool,
  createCompanyTool, updateCompanyTool,
  createDealTool, updateDealTool,
  addNoteTool, addDealActionItemTool,
  applyTagTool, deleteEntityTool,
  // Phase 2 — God Mode write tools
  deleteContactFieldTool, deleteCompanyFieldTool, deleteDealFieldTool,
  linkConversationToDealTool, linkEventToDealTool,
  unlinkConversationFromDealTool, unlinkEventFromDealTool,
  addContactToDealTool, removeContactFromDealTool,
  dismissObservationTool,
  approveHeldProposalTool, dismissHeldProposalTool,
  lockFieldPermanentlyTool, unlockFieldTool,
} from '../lib/agent-tools';
import { webSearch, readUrl } from '../lib/agent-web-search';
import {
  registerActiveRequest,
  cancelRequest,
  unregisterRequest,
  wasCancelledIncludingKV,
} from '../lib/agent-cancellation';
import {
  appendAgentRunEvent,
  createAgentRun,
  fetchAgentRunEvents,
  markAgentRunCancelRequested,
  updateAgentRunStatus,
} from '../lib/agent-runs';
import { MAX_MODE_LIMITS, NORMAL_MODE_LIMITS } from '../lib/max-mode';
import { CLAUDE_HAIKU_MODEL, resolveMartyMaxModel, resolveMartyNormalModel } from '../lib/model-policy';
import {
  buildLiveMartyRuntimeFingerprint,
  buildMartyBaseSystemPrompt,
  buildMartyMaxModePrompt,
} from '../lib/marty-runtime';
import { buildMaxSetTool, compactMaxSetResultForContext, detectMaxSetIntent } from '../lib/max-set-builder';
import {
  buildMaxExecutionPlan,
  cancelMaxModeJobs,
  classifyMaxRequest,
  createQueuedMaxModeJob,
  enqueueMaxModeJob,
  repairStaleMaxModeJobs,
  updateMaxModeJobProgress,
  type MaxExecutionPlan,
  type MaxTaskShape,
} from '../lib/max-orchestrator';
import { TurnSourceRegistry } from '../lib/turn-source-registry';
import { planDeterministicSourceRouting } from '../lib/source-router';
import { inspectPlatformTelemetryTool } from '../lib/platform-telemetry';

function normalizeMartySentenceSpacing(text: string): string {
  if (!text) return text;
  const fixProse = (part: string) =>
    part.replace(/([a-z0-9\]\)"'`*_])([.!?])([*_~`]*)(?=[A-Z])/g, '$1$2$3 ');
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map(part => part.startsWith('`') ? part : fixProse(part))
    .join('');
}

function normalizeMartyOutputText(text: string, validSourceIds?: Set<number>): {
  text: string;
  validCitationsUsed: number;
  invalidCitationsStripped: number;
  labeledCitationsCanonicalized: number;
} {
  const normalized = normalizeCitationMarkers(text, validSourceIds);
  return {
    text: normalizeMartySentenceSpacing(normalized.text),
    validCitationsUsed: normalized.stats.valid_citations_used,
    invalidCitationsStripped: normalized.stats.invalid_citations_stripped,
    labeledCitationsCanonicalized: normalized.stats.labeled_citations_canonicalized,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions for Claude
// ---------------------------------------------------------------------------

const AGENT_TOOLS: ToolDefinition[] = [
  // PRIMARY RETRIEVAL — call this FIRST for any content question
  {
    name: 'recall',
    description: 'Semantic search across the firm intelligence — emails, Slack messages, meeting transcripts, documents, contacts, companies. THIS IS YOUR PRIMARY TOOL for any question about CRM content. Use inspect_platform_telemetry instead for operational platform questions such as ingestion counts, backfills, sync health, embedding coverage, work queues, enrichment/news cadence, Gemini/API budget/circuit status, or connector/token status. Always call recall FIRST when the user asks about communications, meetings, history, what was discussed, who said what, or any specific person/company/deal context. Results are already access-filtered for the current authenticated user; never try broader searches to bypass missing private content. The pre-populated SOURCES list at the top of context is just the initial framing — call recall to dig deeper, retrieve a specific source type, or recover when SOURCES looks empty for an asked-for type. Treat each returned source date as authoritative: relative phrases in an excerpt ("next week", "currently", "now") are relative to that source date, not today. Examples: "what\'s been happening on Slack" → recall("recent slack activity", source_types=["slack"]). "summarize the NeuralSeek meeting" → recall("NeuralSeek meeting", source_types=["meeting"]). "find Patrick\'s pitch emails" → recall("Patrick Dyer pitch", source_types=["email"]).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query. Be specific.' },
        source_types: {
          type: 'array',
          items: { type: 'string', enum: ['email', 'slack', 'meeting', 'document'] },
          description: 'Filter to specific source types. Use this when the user asked about a specific channel (Slack, email, meetings, docs). Default: all types.',
        },
        limit: { type: 'number', description: 'Max results. Default 20; in MAX mode default 50. Max 50.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'inspect_platform_telemetry',
    description: 'Authoritative operational telemetry for the Medina/MARTy platform itself. Use this before answering questions about email/document ingestion, whether a user has run a backfill, Outlook connector or token status, sync jobs, task runs, enrichment scheduler cadence, company/contact enrichment freshness, news refresh cadence, Gemini/API usage budget, Gemini circuit/cooldown state, embedding/searchability coverage, work-queue/dead-letter health, runtime/deploy/model fingerprint, or why something may not be searchable. Do not infer these platform metrics from CRM recall/search results. Owner/super-admin users can inspect org-wide telemetry; non-owner users are limited to their own ingestion where allowed.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['auto', 'user_ingestion', 'data_coverage', 'pipeline_health', 'work_queue', 'platform_overview'],
          description: 'Use auto unless the user clearly asked for a specific telemetry family.',
        },
        query: { type: 'string', description: 'The user’s original platform/system question.' },
        subject: { type: 'string', description: 'Optional person/user name to inspect, e.g. Raul.' },
        user_id: { type: 'string', description: 'Optional exact platform user ID.' },
        email: { type: 'string', description: 'Optional exact platform user email.' },
        days_back: { type: 'number', description: 'Optional lookback hint for future telemetry expansion.' },
        limit: { type: 'number', description: 'Max recent runs/items to return. Default 10, max 50.' },
      },
    },
  },

  // DOCUMENT INTELLIGENCE + ARTIFACTS
  {
    name: 'find_documents',
    description: 'Find and surface existing database documents for MARTy chat. Use this when the user asks to show, find, open, preview, download, send, work with, or reference a document/deck/PDF/spreadsheet/presentation, and also when a highly relevant document should be subtly surfaced as supporting context. Returns document cards with Preview, Download, and Send to MARTy actions. Use mode="dominant" for explicit document tasks; mode="compact" when the document is secondary support.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Document search query. Include likely title, company, deal, topic, and file kind when known.' },
        document_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional document_type filters such as pitch_deck, deal_pitch, spreadsheet, presentation, memo, report, legal, financials.',
        },
        entity_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional CRM entity IDs to scope linked documents.',
        },
        limit: { type: 'number', description: 'Max documents to return. For singular requests like "pull up the X deck", use 1. Default 6, max 20.' },
        mode: { type: 'string', enum: ['auto', 'compact', 'dominant'], description: 'UI surfacing mode. Use dominant for document-centric requests.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_document_artifact',
    description: 'Create a polished, fully usable editable document artifact and save it to Documents. Supports docx, xlsx, pptx, and pdf. Use when the user asks MARTy to prepare, draft, build, create, generate, or export a memo/model/deck/summary/file. Never create title-only, skeletal, placeholder, or empty-section files. For memos, include a concise executive frame, evidence-backed body sections, risk/open-question/action structure where relevant, and no raw markup.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'] },
        title: { type: 'string', description: 'Human-readable document title.' },
        structured_content: {
          type: 'object',
          description: 'Complete structured content. docx/pdf: subtitle, concise summary, metadata, and substantive sections with paragraphs, bullets, numbered lists, checklists, and tables; no empty headings or placeholder sections. xlsx: multiple sheets with headers, rows, and formulas where natural. pptx: 6-10 Medina-dark executive slides; use layout/headline/takeaway, evidence_blocks, metrics, tables, and speaker_notes where useful. Older simple title/body/bullets slides are still accepted.',
        },
        source_document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional source document IDs used to create the artifact.',
        },
      },
      required: ['kind', 'title', 'structured_content'],
    },
  },
  {
    name: 'create_deck_artifact',
    description: 'Create a premium artifact-tool presentation deck bundle and save it to Documents. Use for decks, slide decks, PowerPoint presentations, board/IC decks, recaps, pitches, and any request where visual composition matters. Premium mode produces editable PPTX plus HTML/PDF companion exports after source-ledger, contact-sheet, and critic QA.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full deck request, including audience, objective, sources, and desired storyline.' },
        title: { type: 'string', description: 'Human-readable deck title.' },
        audience: { type: 'string', description: 'Audience such as internal IC, LP, board, founder, sales, diligence, or weekly recap.' },
        objective: { type: 'string', enum: ['inform', 'persuade', 'decide', 'update', 'sell'], description: 'Primary deck objective.' },
        style_pack: { type: 'string', enum: ['medina_default', 'banker_clean', 'consulting_editorial', 'founder_story', 'lp_report'], description: 'Medina default unless a different audience-specific style is needed.' },
        output_formats: { type: 'array', items: { type: 'string', enum: ['html', 'pdf', 'pptx'] }, description: 'Requested outputs. Defaults to html, pdf, and pptx.' },
        quality_mode: { type: 'string', enum: ['fast', 'premium'], description: 'Use premium unless the user explicitly asks for rough/fast.' },
        structured_content: { type: 'object', description: 'Optional complete deck content. Include slides, metrics, tables, evidence_blocks, and speaker_notes when known.' },
        source_document_ids: { type: 'array', items: { type: 'string' }, description: 'Optional source document IDs used to create the deck.' },
        source_packet: {
          type: 'object',
          description: 'Optional source ledger for premium artifact-tool decks. Include internal_sources with ids/titles/excerpts, web_sources with URLs/titles/dates/excerpts, and open_questions for missing evidence. Every factual claim should map to a source or open question.',
          properties: {
            internal_sources: { type: 'array', items: { type: 'object' } },
            web_sources: { type: 'array', items: { type: 'object' } },
            open_questions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_document_artifact',
    description: 'Create a new edited copy/version of an existing document. Never mutates the original. Use when the user asks to revise, duplicate, update, convert, summarize into, or alter an existing document.',
    input_schema: {
      type: 'object',
      properties: {
        source_document_id: { type: 'string', description: 'ID of the source document to copy/edit.' },
        instructions: { type: 'string', description: 'Specific edit/conversion instructions.' },
        output_kind: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'], description: 'Optional output type. Defaults to the source file type when possible.' },
        title: { type: 'string', description: 'Optional title for the new edited copy.' },
      },
      required: ['source_document_id', 'instructions'],
    },
  },

  // READ TOOLS
  {
    name: 'search_contacts',
    description: 'Search contacts by keyword, filter by type or follow-up status. Use when asked about contacts broadly.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by name, email, or company name' },
        contact_type: { type: 'string', enum: ['individual', 'family', 'institutional_investor', 'company'] },
        has_followup_overdue: { type: 'boolean', description: 'Only show contacts with overdue follow-ups' },
        limit: { type: 'number', description: 'Max results. Default 20; in MAX mode default 100. Max 50 normally, 200 in MAX mode.' },
      },
    },
  },
  {
    name: 'search_companies',
    description: 'Search companies by keyword, type, or sector. Use when asked about companies broadly.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by name, domain, or description' },
        company_type: { type: 'string' },
        sector: { type: 'string' },
        limit: { type: 'number', description: 'Max results. Default 20; in MAX mode default 100. Max 50 normally, 200 in MAX mode.' },
      },
    },
  },
  {
    name: 'get_firm_relationship_snapshot',
    description: 'Return the authoritative Medina firm relationship state for companies: current portfolio, active pipeline, watchlist, passed, exited, and unknown. Use before answering current portfolio, investments, portfolio companies, or pipeline-vs-portfolio questions.',
    input_schema: {
      type: 'object',
      properties: {
        include_pipeline: { type: 'boolean', description: 'Include pipeline and watchlist buckets. Defaults true.' },
        limit: { type: 'number', description: 'Maximum companies to inspect. Default 300.' },
      },
    },
  },
  {
    name: 'set_firm_company_relationship',
    description: 'Persistently mark a company as current portfolio, active pipeline, watchlist, passed, exited, or other in the authoritative firm relationship log. Use immediately when the user says a company is/also is/no longer is a portfolio company or asks to update portfolio/pipeline status.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'Existing company ID if known.' },
        company_name: { type: 'string', description: 'Company name. The tool resolves or creates the company if needed.' },
        relationship_state: {
          type: 'string',
          enum: ['current_portfolio', 'active_pipeline', 'watchlist', 'passed', 'exited', 'other'],
          description: 'Defaults to current_portfolio.',
        },
        effective_date: { type: 'string', description: 'Optional YYYY-MM-DD effective date.' },
        notes: { type: 'string', description: 'Optional reason/source note.' },
        create_if_missing: { type: 'boolean', description: 'Create the company if no matching company exists. Defaults true.' },
      },
    },
  },
  {
    name: 'search_deals',
    description: 'Search deals by keyword, stage, or company. Use when asked about the pipeline or deals broadly.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by title or company name' },
        stage: { type: 'string', description: 'Filter by stage: new, talking, due_diligence, term_sheet, closed (legacy values may also exist)' },
        company_id: { type: 'string' },
        limit: { type: 'number', description: 'Max results. Default 20; in MAX mode default 100. Max 50 normally, 200 in MAX mode.' },
      },
    },
  },
  {
    name: 'query_deal_flow',
    description: 'Exact aggregate prospect/deal-flow counts from the prospect intelligence tables. Use for "how many prospects", sector counts such as fintech, recent flow, source coverage, and high-signal vs lazy enrichment rollups. Counts are firm-visible and do not depend on source-content ACL.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Lookback window. Default 180 days.' },
        sector: { type: 'string', description: 'Optional exact sector key/label such as fintech, cybersecurity, ai_data, aerospace_defense, or materials_manufacturing.' },
        include_provisional: { type: 'boolean', description: 'Include provisional prospects. Default true.' },
        limit: { type: 'number', description: 'Max recent prospects to include. Default 20, max 100.' },
      },
    },
  },
  {
    name: 'search_prospects',
    description: 'Search derived prospect identities. Default sort is recency first, then deterministic signal strength. Use sector to slice "show me fintech".',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by prospect name or domain.' },
        sector: { type: 'string', description: 'Exact sector key/label such as fintech, cybersecurity, ai_data, aerospace_defense, or uncategorized.' },
        status: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Status filter. Defaults to active and provisional.',
        },
        enrichment_priority: { type: 'string', enum: ['eager', 'lazy'], description: 'Filter by signal-strength enrichment priority.' },
        limit: { type: 'number', description: 'Max results. Default 20; in MAX mode default 100. Max 50 normally, 200 in MAX mode.' },
      },
    },
  },
  {
    name: 'get_prospect_evidence',
    description: 'Drill into the source evidence for a prospect. Prospect identity/counts remain visible, while private conversation, meeting, or document snippets are replaced with placeholders when the viewer lacks source access.',
    input_schema: {
      type: 'object',
      properties: {
        prospect_id: { type: 'string', description: 'Prospect UUID from search_prospects or query_deal_flow.' },
        limit: { type: 'number', description: 'Max evidence rows. Default 20; max follows mode limits.' },
      },
      required: ['prospect_id'],
    },
  },
  {
    name: 'search_conversations',
    description: 'Search emails, Slack messages, and manual conversation rows stored in the conversations table. This does NOT search Firefly meeting transcripts or calendar events; use search_events for meetings, calendar windows, events, and transcript-backed recaps. In MAX mode, prefer sweep_conversations for exhaustive all/every/list/export/count communication jobs.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Token-aware search by subject, body preview, sender, recipients, or linked participant names' },
        source: { type: 'string', enum: ['outlook', 'slack', 'manual', 'all'], description: 'Filter by conversation channel. Default: all. Meeting transcripts are not conversations; use search_events.' },
        contact_id: { type: 'string', description: 'Filter conversations involving a specific contact' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'all'], description: 'Filter by direction. Default: all' },
        days_back: { type: 'number', description: 'How many days back to search. Use 0 for all time. Default: 30, or 365 in MAX mode. Max: 3650.' },
        limit: { type: 'number', description: 'Max results. Default 20; in MAX mode default 250. Max 50 normally, 1000 in MAX mode.' },
      },
    },
  },
  {
    name: 'search_events',
    description: 'Deterministic SQL search over the events table: calendar events, meetings, calls, hosted events, and Firefly transcript-backed meeting records. Use this for recent/upcoming meetings, event windows, meeting recaps, transcript availability, action items from meetings, or whenever a user asks about meetings/events/calendar. Pair with recall(source_types=["meeting"]) when the user needs transcript content, but never infer "no transcripts" from search_conversations.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Optional high-signal event/company/person/topic term. Do not pass generic words like recent, upcoming, meetings, or events.' },
        event_type: { type: 'string', enum: ['meeting', 'conference', 'call', 'email_thread', 'hosted_event', 'in_person', 'other', 'all'], description: 'Optional event type. Default: all.' },
        source: { type: 'string', enum: ['outlook', 'firefly', 'manual', 'all'], description: 'Optional event source. Use firefly for transcript-backed Firefly meetings. Default: all.' },
        timeframe: { type: 'string', enum: ['recent', 'upcoming', 'past', 'recent_and_upcoming', 'all'], description: 'Default: recent_and_upcoming.' },
        start_date: { type: 'string', description: 'Inclusive ISO/date lower bound. Optional.' },
        end_date: { type: 'string', description: 'Inclusive ISO/date upper bound. Optional.' },
        days_back: { type: 'number', description: 'Lookback window when start_date is omitted. Default 60.' },
        days_forward: { type: 'number', description: 'Forward window when end_date is omitted. Default 90.' },
        has_transcript: { type: 'boolean', description: 'Filter by transcript availability. Omit to include both transcript and calendar-only events.' },
        include_transcript_excerpt: { type: 'boolean', description: 'Fetch a short transcript excerpt from R2 when available. Use for meeting-content questions; keep false for calendar windows.' },
        limit: { type: 'number', description: 'Max events. Default 20; in MAX mode default 100. Max 50 normally, 200 in MAX mode.' },
      },
    },
  },
  {
    name: 'sweep_conversations',
    description: 'MAX-mode deterministic sweep over the conversations table for exhaustive all/every/list/export/count tasks. Use this instead of recall when the user needs a broad roster or aggregation across many touchpoints, such as invite lists, all Bank of America touchpoints, everyone who showed funding interest, or every startup mention in a sector. It can return hundreds of SQL-filtered rows and optionally deduplicate To/Cc recipients. Use a few high-signal terms like event name/company/sector, plus exact sender/date filters when known; do not pass the whole user request as the only search strategy if better filters are available.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional broad query text. If all_terms/any_terms are omitted, high-signal terms are derived and OR-matched across subject/body preview/sender/To/Cc.' },
        all_terms: { type: 'array', items: { type: 'string' }, description: 'Every term/phrase must appear somewhere in subject/body preview/sender/To/Cc. Use sparingly for precise anchors.' },
        any_terms: { type: 'array', items: { type: 'string' }, description: 'At least one term/phrase must appear. Good for aliases like ["Intelligent Infrastructure", "Virtual Town Hall", "May 7"].' },
        source: { type: 'string', enum: ['outlook', 'email', 'slack', 'manual', 'all'], description: 'Filter communication source. Use email/outlook for email invite lists.' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'internal', 'all'], description: 'Optional direction filter.' },
        from_emails: { type: 'array', items: { type: 'string' }, description: 'Exact sender emails, e.g. Tony/Raul, for invite-list sweeps.' },
        participant_emails: { type: 'array', items: { type: 'string' }, description: 'Emails that must appear as sender, To, or Cc.' },
        start_date: { type: 'string', description: 'Inclusive ISO/date lower bound on sent_at.' },
        end_date: { type: 'string', description: 'Inclusive ISO/date upper bound on sent_at.' },
        days_back: { type: 'number', description: 'Optional relative lookback. Omit for all-time sweeps.' },
        include_recipients: { type: 'boolean', description: 'When true, deduplicates To/Cc recipients into first_name/email rows for mail merges.' },
        include_body: { type: 'boolean', description: 'When true, fetches fuller R2 body excerpts for returned rows. Keep false for pure recipient/export sweeps.' },
        body_fetch_limit: { type: 'number', description: 'Max full bodies to fetch when include_body is true. Default 80, max 200 in MAX mode.' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Optional recipient domains to exclude from rollup, e.g. an internal email domain.' },
        limit: { type: 'number', description: 'Rows to return. Default 300 in MAX mode, max 1000.' },
        offset: { type: 'number', description: 'Pagination offset. If has_more is true, call again with the next offset before finalizing exhaustive answers.' },
      },
    },
  },
  {
    name: 'build_max_set',
    description: 'MAX-only exhaustive set builder for explicit all/every/list/export/count/touchpoint/ever-involved questions. Prefer this over recall and lower-level sweeps when the user needs a complete roster or broad aggregation across communications, events, campaigns, CRM entities, documents, and tasks. Do not use it for shortlist/recommendation questions like "best people", "heaviest hitters", or "who should I invite" unless the user explicitly asks for the full universe first; use recall/search tools for those ranked recommendations. It deduplicates candidates, assigns confirmed/probable/needs_review/excluded buckets, reports coverage/gaps, and auto-creates an XLSX for large or export/mail-merge outputs.',
    input_schema: {
      type: 'object',
      properties: {
        task_type: {
          type: 'string',
          enum: ['invite_roster', 'touchpoint_roster', 'entity_theme_set', 'funding_interest_gap', 'firm_involvement', 'open_loops', 'account_map', 'campaign_response_set', 'document_list_reconstruction', 'deal_process_history', 'candidate_slate', 'generic_set'],
          description: 'The exhaustive set-building workflow. Infer from the user request when obvious.',
        },
        entity_kind: {
          type: 'string',
          enum: ['person', 'company', 'firm', 'startup', 'deal', 'touchpoint', 'mixed'],
          description: 'The thing being collected.',
        },
        query: { type: 'string', description: 'Original user goal or concise search objective.' },
        include_terms: { type: 'array', items: { type: 'string' }, description: 'High-signal required/positive terms, event names, company names, sectors, or intent phrases.' },
        exclude_terms: { type: 'array', items: { type: 'string' }, description: 'Terms that should push candidates into Excluded.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Aliases/variants such as BofA, Merrill, or abbreviated event names.' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Email/web domains that identify relevant entities, without @ when possible.' },
        date_range: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Inclusive lower date/ISO bound.' },
            end: { type: 'string', description: 'Inclusive upper date/ISO bound.' },
          },
        },
        named_people: { type: 'array', items: { type: 'string' }, description: 'Named people that should anchor the search.' },
        source_families: {
          type: 'array',
          items: { type: 'string', enum: ['communications', 'events', 'campaigns', 'contacts', 'companies', 'deals', 'documents', 'tasks'] },
          description: 'Optional source families to search. Omit for task-specific defaults.',
        },
        output_columns: { type: 'array', items: { type: 'string' }, description: 'Optional XLSX/chat columns. Defaults to mail-merge columns for invite/mail-merge tasks.' },
        artifact_kind: { type: 'string', enum: ['xlsx', 'none'], description: 'Use xlsx for exports/mail merge, none to suppress artifacts.' },
        create_artifact: { type: 'boolean', description: 'Force artifact creation on/off. By default large/export/mail-merge results create XLSX automatically.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_contact_detail',
    description: 'Get full details for a specific contact including their conversations, deals, tags, and associations. Use when asked about a specific person.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'The contact UUID' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'get_company_detail',
    description: 'Get full details for a specific company including contacts, deals, tags, and news.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
      },
      required: ['company_id'],
    },
  },
  {
    name: 'get_deal_detail',
    description: 'Get full details for a specific deal including contacts, action items, and notes.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
      },
      required: ['deal_id'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information about people, companies, markets, news, or any topic. Use when internal data is insufficient or when asked about external/current events.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        num_results: { type: 'number', description: 'Number of source links to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_url',
    description: 'Fetch and read the text content from a specific URL. Use to read articles, press releases, or web pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
  // WRITE TOOLS
  {
    name: 'create_contact',
    description: 'Create a new contact in the CRM. Use when asked to add a person.',
    input_schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        contact_type: { type: 'string', enum: ['individual', 'family', 'institutional_investor', 'company'] },
        company_name: { type: 'string', description: 'Will link to existing company or create a new one' },
        job_title: { type: 'string' },
        linkedin_url: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['full_name'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update fields on an existing contact.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Key-value pairs of fields to update (full_name, email, phone, job_title, linkedin_url, bio_summary, contact_type, relationship_status, engagement_status, next_followup_date, location, etc.)',
        },
      },
      required: ['contact_id', 'fields'],
    },
  },
  {
    name: 'create_company',
    description: 'Create a new company in the CRM.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        domain: { type: 'string' },
        website: { type: 'string' },
        sector: { type: 'string' },
        company_type: { type: 'string' },
        location: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_company',
    description: 'Update fields on an existing company.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Key-value pairs of fields to update',
        },
      },
      required: ['company_id', 'fields'],
    },
  },
  {
    name: 'create_deal',
    description: 'Create a new deal in the pipeline. Requires a company.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        company_name: { type: 'string', description: 'Name of an existing company' },
        company_id: { type: 'string', description: 'Or provide company ID directly' },
        stage: { type: 'string', description: 'new, talking, due_diligence, term_sheet, closed (legacy values may also exist)' },
        amount: { type: 'number' },
        valuation: { type: 'number' },
        description: { type: 'string' },
        expected_close: { type: 'string', description: 'ISO 8601 date' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_deal',
    description: 'Update fields on an existing deal. Can change stage, amount, notes, etc.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Key-value pairs (title, stage, amount, valuation, probability, expected_close, notes, etc.)',
        },
      },
      required: ['deal_id', 'fields'],
    },
  },
  {
    name: 'add_note',
    description: 'Add a note to a contact or deal.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'deal'] },
        entity_id: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['entity_type', 'entity_id', 'content'],
    },
  },
  {
    name: 'add_deal_action_item',
    description: 'Add an action item / to-do to a deal.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        description: { type: 'string' },
        assignee_id: { type: 'string', description: 'Optional user ID to assign' },
        due_date: { type: 'string', description: 'Optional ISO 8601 date' },
      },
      required: ['deal_id', 'description'],
    },
  },
  {
    name: 'apply_tag',
    description: 'Apply a tag to a contact or company. Creates the tag if it does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company'] },
        entity_id: { type: 'string' },
        tag_name: { type: 'string' },
      },
      required: ['entity_type', 'entity_id', 'tag_name'],
    },
  },
  {
    name: 'delete_entity',
    description: 'Delete a contact, company, or deal. Will ask for confirmation before proceeding.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal', 'prospect'] },
        entity_id: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Set to true to confirm deletion' },
      },
      required: ['entity_type', 'entity_id'],
    },
  },

  // ── Phase 2 (MARTy Write Capability) — additional write tools ──
  // Field deletions: clears one column on an entity. Routes through
  // entity-writes (lock checks + entity_field_state sync).
  {
    name: 'delete_contact_field',
    description: 'Clear a single field on a contact (sets it to null). Use for "remove Tony\'s old phone" / "clear the location field". Refuses if the field is permanently locked or under a 180-day human-edit lock from another user.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        field_name: { type: 'string', description: 'e.g. phone, email, location, job_title, bio_summary' },
      },
      required: ['contact_id', 'field_name'],
    },
  },
  {
    name: 'delete_company_field',
    description: 'Clear a single field on a company.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
        field_name: { type: 'string' },
      },
      required: ['company_id', 'field_name'],
    },
  },
  {
    name: 'delete_deal_field',
    description: 'Clear a single field on a deal.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        field_name: { type: 'string' },
      },
      required: ['deal_id', 'field_name'],
    },
  },

  // Conversation/event ↔ deal linkage — uses T1's Phase B junction tables.
  {
    name: 'link_conversation_to_deal',
    description: 'Link an email/Slack/transcript conversation to a deal. Use when the user says things like "this thread is about the Acme deal" or "tag this conversation under <deal>".',
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        deal_id: { type: 'string' },
      },
      required: ['conversation_id', 'deal_id'],
    },
  },
  {
    name: 'link_event_to_deal',
    description: 'Link a calendar event/meeting to a deal.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        deal_id: { type: 'string' },
      },
      required: ['event_id', 'deal_id'],
    },
  },
  {
    name: 'unlink_conversation_from_deal',
    description: 'Remove a conversation\'s direct link to a deal. Confirm before executing — destructive operation.',
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        deal_id: { type: 'string' },
      },
      required: ['conversation_id', 'deal_id'],
    },
  },
  {
    name: 'unlink_event_from_deal',
    description: 'Remove an event\'s direct link to a deal. Confirm before executing — destructive operation.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        deal_id: { type: 'string' },
      },
      required: ['event_id', 'deal_id'],
    },
  },

  // Contact ↔ deal membership (deal_contacts table).
  {
    name: 'add_contact_to_deal',
    description: 'Add a contact to a deal\'s contact list. side defaults to "them" (counterparty); use "us" for internal Medina contacts.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        contact_id: { type: 'string' },
        role: { type: 'string', description: 'e.g. CEO, GC, Lead Investor (optional)' },
        side: { type: 'string', enum: ['us', 'them'], description: 'Default: "them"' },
      },
      required: ['deal_id', 'contact_id'],
    },
  },
  {
    name: 'remove_contact_from_deal',
    description: 'Remove a contact from a deal\'s contact list. Confirm before executing — destructive operation.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        contact_id: { type: 'string' },
      },
      required: ['deal_id', 'contact_id'],
    },
  },

  // Observation + held-proposal + lock tools — extends Q11/Q12 + Wave 6 UX.
  {
    name: 'dismiss_observation',
    description: 'Dismiss a synthetic observation (personal_update, follow_up_commitment, etc.) for an entity. Re-sightings clear the dismissal automatically.',
    input_schema: {
      type: 'object',
      properties: {
        observation_id: { type: 'string' },
      },
      required: ['observation_id'],
    },
  },
  {
    name: 'approve_held_proposal',
    description: 'Approve a held value or held deletion sitting in entity_field_state.pending_proposals/pending_deletions. Commits as a fresh human edit (resets corroboration history).',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal', 'prospect'] },
        entity_id: { type: 'string' },
        field_name: { type: 'string' },
        value: { type: 'string', description: 'Required unless is_deletion=true' },
        is_deletion: { type: 'boolean', description: 'true = approve a held deletion (clears the field)' },
      },
      required: ['entity_type', 'entity_id', 'field_name'],
    },
  },
  {
    name: 'dismiss_held_proposal',
    description: 'Dismiss a held value or held deletion. Stamps the value into rejected_values for the 90-day no-re-ask rule.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal', 'prospect'] },
        entity_id: { type: 'string' },
        field_name: { type: 'string' },
        value: { type: 'string' },
        is_deletion: { type: 'boolean' },
      },
      required: ['entity_type', 'entity_id', 'field_name'],
    },
  },
  {
    name: 'lock_field_permanently',
    description: 'Permanently lock a field from automated proposals. Owner-only. Use when the user wants a curated value (manual_edit) protected from future LLM/enrichment overwrites indefinitely.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal', 'prospect'] },
        entity_id: { type: 'string' },
        field_name: { type: 'string' },
      },
      required: ['entity_type', 'entity_id', 'field_name'],
    },
  },
  {
    name: 'unlock_field',
    description: 'Remove a permanent lock from a field. Owner-only. Re-enables automated proposals (still subject to the 180-day human-edit lock).',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal'] },
        entity_id: { type: 'string' },
        field_name: { type: 'string' },
      },
      required: ['entity_type', 'entity_id', 'field_name'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function executeTool(
  toolName: string,
  toolInput: any,
  ctx: AuthContext,
  env: Env,
  toolContext: {
    deepDive?: boolean;
    signal?: AbortSignal;
    jobId?: string;
    sessionId?: string | null;
    requestId?: string | null;
    assistantMessageId?: string | null;
  } = {}
): Promise<any> {
  switch (toolName) {
    case 'search_contacts': return searchContacts(ctx, toolInput, env, toolContext);
    case 'search_companies': return searchCompanies(ctx, toolInput, env, toolContext);
    case 'inspect_platform_telemetry': return inspectPlatformTelemetryTool(ctx, toolInput || {}, env);
    case 'get_firm_relationship_snapshot': return getFirmRelationshipSnapshotTool(ctx, toolInput || {}, env);
    case 'set_firm_company_relationship': return setFirmCompanyRelationshipTool(ctx, toolInput || {}, env);
    case 'search_deals': return searchDeals(ctx, toolInput, env, toolContext);
    case 'query_deal_flow': return queryDealFlow(ctx, toolInput || {}, env);
    case 'search_prospects': return searchProspects(ctx, toolInput || {}, env, toolContext);
    case 'get_prospect_evidence': return getProspectEvidence(ctx, toolInput || {}, env, toolContext);
    case 'search_conversations': return searchConversations(ctx, toolInput, env, toolContext);
    case 'search_events': return searchEvents(ctx, toolInput, env, toolContext);
    case 'sweep_conversations': return sweepConversations(ctx, toolInput, env, toolContext);
    case 'build_max_set': return buildMaxSetTool(ctx, toolInput, env, toolContext);
    case 'find_documents': return findDocumentsTool(ctx, toolInput, env);
    case 'create_deck_artifact': return createDeckArtifactTool(ctx, toolInput, env, toolContext);
    case 'create_document_artifact': return createDocumentArtifactTool(ctx, toolInput, env);
    case 'edit_document_artifact': return editDocumentArtifactTool(ctx, toolInput, env);
    case 'recall':
      console.log(`[agent:tool:recall] ${JSON.stringify({
        query: typeof toolInput?.query === 'string' ? toolInput.query.slice(0, 80) : null,
        source_types: Array.isArray(toolInput?.source_types) ? toolInput.source_types : null,
        limit: typeof toolInput?.limit === 'number' ? toolInput.limit : null,
      })}`);
      return recall(ctx, toolInput, env, toolContext);
    case 'get_contact_detail': return getContactDetail(ctx, toolInput.contact_id, env, toolContext);
    case 'get_company_detail': return getCompanyDetail(ctx, toolInput.company_id, env, toolContext);
    case 'get_deal_detail': return getDealDetail(ctx, toolInput.deal_id, env, toolContext);
    case 'web_search': return webSearch(toolInput.query, toolInput.num_results, ctx, env);
    case 'read_url': return readUrl(toolInput.url);
    // Phase 1 refactor — these now take ctx (with userRole) so the
    // entity-writes lock checks can enforce the same-user exception.
    case 'create_contact': return createContactTool(ctx, toolInput, env);
    case 'update_contact': return updateContactTool(ctx, toolInput, env);
    case 'create_company': return createCompanyTool(ctx, toolInput, env);
    case 'update_company': return updateCompanyTool(ctx, toolInput, env);
    case 'create_deal': return createDealTool(ctx, toolInput, env);
    case 'update_deal': return updateDealTool(ctx, toolInput, env);
    case 'add_note': return addNoteTool(ctx.orgId, ctx.userId, toolInput, env);
    case 'add_deal_action_item': return addDealActionItemTool(ctx.orgId, ctx.userId, toolInput, env);
    case 'apply_tag': return applyTagTool(ctx.orgId, toolInput, env);
    // Phase 2 (God Mode) — additional write tools.
    case 'delete_contact_field': return deleteContactFieldTool(ctx, toolInput, env);
    case 'delete_company_field': return deleteCompanyFieldTool(ctx, toolInput, env);
    case 'delete_deal_field': return deleteDealFieldTool(ctx, toolInput, env);
    case 'link_conversation_to_deal': return linkConversationToDealTool(ctx, toolInput, env);
    case 'link_event_to_deal': return linkEventToDealTool(ctx, toolInput, env);
    case 'unlink_conversation_from_deal': return unlinkConversationFromDealTool(ctx, toolInput, env);
    case 'unlink_event_from_deal': return unlinkEventFromDealTool(ctx, toolInput, env);
    case 'add_contact_to_deal': return addContactToDealTool(ctx, toolInput, env);
    case 'remove_contact_from_deal': return removeContactFromDealTool(ctx, toolInput, env);
    case 'dismiss_observation': return dismissObservationTool(ctx, toolInput, env);
    case 'approve_held_proposal': return approveHeldProposalTool(ctx, toolInput, env);
    case 'dismiss_held_proposal': return dismissHeldProposalTool(ctx, toolInput, env);
    case 'lock_field_permanently': return lockFieldPermanentlyTool(ctx, toolInput, env);
    case 'unlock_field': return unlockFieldTool(ctx, toolInput, env);
    case 'delete_entity': return deleteEntityTool(ctx.orgId, ctx.userId, toolInput, env);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Session endpoints
// ---------------------------------------------------------------------------

const STALE_AGENT_TURN_MINUTES = 10;
const FORCED_MAX_SET_TIMEOUT_MS = 120_000;
const STREAMING_MAX_SET_TIMEOUT_MS = 50_000;

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

function normalizeClientSessionId(value: unknown): string | null {
  const id = normalizeSessionId(value);
  if (!id) return null;
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
    ? id
    : null;
}

function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
  return /^[a-f0-9-]{16,80}$/i.test(trimmed) ? trimmed : null;
}

async function createAgentSessionRecord(
  ctx: AuthContext,
  env: Env,
  contextEntityType: string | null = null,
  contextEntityId: string | null = null,
  preferredId: string | null = null
): Promise<AgentSession> {
  const id = preferredId || crypto.randomUUID();
  const now = new Date().toISOString();
  await env.D1.prepare(
    `INSERT INTO agent_sessions (id, org_id, user_id, context_entity_type, context_entity_id, turn_count, last_activity_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(id, ctx.orgId, ctx.userId, contextEntityType, contextEntityId, now, now).run();

  return {
    id,
    org_id: ctx.orgId,
    user_id: ctx.userId,
    context_entity_type: contextEntityType,
    context_entity_id: contextEntityId,
    turn_count: 0,
    user_role: ctx.userRole,
    last_activity_at: now,
    created_at: now,
  };
}

async function loadAccessibleAgentSession(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<AgentSession | null> {
  const exact = await env.D1.prepare(
    `SELECT * FROM agent_sessions
     WHERE id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.orgId, ctx.userId).first<AgentSession>();
  if (exact) return exact;

  // Some long-lived browser tokens can outlive a user-id normalization. Keep
  // tenant isolation, but allow the same verified email inside the same org to
  // recover its own sessions.
  if (ctx.email) {
    const sameEmail = await env.D1.prepare(
      `SELECT s.*
       FROM agent_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?
         AND s.org_id = ?
         AND lower(u.email) = lower(?)
         AND s.deleted_at IS NULL`
    ).bind(id, ctx.orgId, ctx.email).first<AgentSession>();
    if (sameEmail) return sameEmail;
  }

  return null;
}

async function repairAgentSessionTurnCount(
  sessionId: string,
  env: Env
): Promise<void> {
  await env.D1.prepare(
    `UPDATE agent_sessions
     SET turn_count = (
       SELECT COALESCE(MAX(turn_index) + 1, 0)
       FROM agent_messages
       WHERE session_id = ?
     )
     WHERE id = ?
       AND turn_count < (
         SELECT COALESCE(MAX(turn_index) + 1, 0)
         FROM agent_messages
         WHERE session_id = ?
       )`
  ).bind(sessionId, sessionId, sessionId).run().catch(() => {});
}

async function markStaleRunningAgentTurns(
  ctx: AuthContext,
  env: Env,
  sessionId?: string
): Promise<void> {
  const cutoffExpr = `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${STALE_AGENT_TURN_MINUTES} minutes')`;
  const staleMessage = `This MARTy response stopped before completion. I marked it as stale so the session can be used again. Please retry the request.`;
  const sessionFilter = sessionId ? 'AND m.session_id = ?' : '';
  const activeDurableMaxPredicate = `NOT EXISTS (
         SELECT 1
         FROM max_mode_jobs j
         WHERE j.assistant_message_id = m.id
           AND j.status IN ('queued','running','cancelling')
           AND COALESCE(j.heartbeat_at, j.updated_at, j.created_at) >= ${cutoffExpr}
       )`;
  const accessPredicate = `EXISTS (
         SELECT 1
         FROM agent_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.id = m.session_id
           AND s.org_id = ?
           AND s.deleted_at IS NULL
           AND (s.user_id = ? OR lower(u.email) = lower(?))
       )`;
  const staleSessionRows = await env.D1.prepare(
    `SELECT DISTINCT m.session_id
     FROM agent_messages m
     WHERE m.role = 'assistant'
       AND json_extract(m.metadata, '$.status') = 'running'
       AND m.created_at < ${cutoffExpr}
       AND ${activeDurableMaxPredicate}
       AND ${accessPredicate}
       ${sessionFilter}
     LIMIT 50`
  ).bind(
    ...(sessionId
      ? [ctx.orgId, ctx.userId, ctx.email || '', sessionId]
      : [ctx.orgId, ctx.userId, ctx.email || ''])
  ).all<{ session_id: string }>().catch(() => ({ results: [] as { session_id: string }[] }));

  const bindValues = sessionId
    ? [staleMessage, ctx.orgId, ctx.userId, ctx.email || '', sessionId]
    : [staleMessage, ctx.orgId, ctx.userId, ctx.email || ''];

  await env.D1.prepare(
    `UPDATE agent_messages AS m
     SET content = CASE WHEN m.content = '' THEN ? ELSE m.content END,
         metadata = json_set(
           CASE WHEN json_valid(COALESCE(m.metadata, '{}')) THEN COALESCE(m.metadata, '{}') ELSE '{}' END,
           '$.status', 'error',
           '$.error', 'REQUEST_STALE',
           '$.retryable', 1
         )
     WHERE m.role = 'assistant'
       AND json_extract(m.metadata, '$.status') = 'running'
       AND m.created_at < ${cutoffExpr}
       AND ${activeDurableMaxPredicate}
       AND ${accessPredicate}
       ${sessionFilter}`
  ).bind(...bindValues).run().catch(() => {});

  await repairStaleMaxModeJobs(env, ctx, sessionId, STALE_AGENT_TURN_MINUTES).catch(() => 0);

  for (const row of staleSessionRows.results) {
    if (row.session_id) {
      await repairAgentSessionTurnCount(row.session_id, env);
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getNextAgentTurnIndex(
  sessionId: string,
  env: Env
): Promise<number> {
  const row = await env.D1.prepare(
    `SELECT
       COALESCE(s.turn_count, 0) AS turn_count,
       COALESCE(MAX(m.turn_index) + 1, 0) AS next_message_index
     FROM agent_sessions s
     LEFT JOIN agent_messages m ON m.session_id = s.id
     WHERE s.id = ?
     GROUP BY s.id`
  ).bind(sessionId).first<{ turn_count: number; next_message_index: number }>();
  return Math.max(Number(row?.turn_count || 0), Number(row?.next_message_index || 0));
}

async function getRunningAssistantTurn(
  sessionId: string,
  env: Env
): Promise<{ id: string; request_id: string | null; created_at: string } | null> {
  const row = await env.D1.prepare(
    `SELECT id, json_extract(metadata, '$.request_id') AS request_id, created_at
     FROM agent_messages
     WHERE session_id = ?
       AND role = 'assistant'
       AND json_extract(metadata, '$.status') = 'running'
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(sessionId).first<{ id: string; request_id: string | null; created_at: string }>();
  return row || null;
}

async function markAgentTurnCancelled(
  env: Env,
  ctx: AuthContext,
  opts: {
    requestId?: string | null;
    assistantMessageId?: string | null;
    sessionId?: string | null;
    reason?: string;
    kind?: 'user_stop' | 'interrupt' | 'timeout' | 'server_cancel';
  }
): Promise<number> {
  const now = new Date().toISOString();
  const message = opts.reason || 'Stopped by user.';
  const kind = opts.kind || 'user_stop';
  const predicates = [
    `m.role = 'assistant'`,
    `json_extract(m.metadata, '$.status') = 'running'`,
    `EXISTS (
       SELECT 1
       FROM agent_sessions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = m.session_id
         AND s.org_id = ?
         AND s.deleted_at IS NULL
         AND (s.user_id = ? OR lower(u.email) = lower(?))
     )`,
  ];
  const binds: any[] = [message, ctx.userId, now, kind, message, ctx.orgId, ctx.userId, ctx.email || ''];
  if (opts.requestId) {
    predicates.push(`json_extract(m.metadata, '$.request_id') = ?`);
    binds.push(opts.requestId);
  }
  if (opts.assistantMessageId) {
    predicates.push(`m.id = ?`);
    binds.push(opts.assistantMessageId);
  }
  if (opts.sessionId) {
    predicates.push(`m.session_id = ?`);
    binds.push(opts.sessionId);
  }
  if (!opts.requestId && !opts.assistantMessageId && !opts.sessionId) return 0;

  const result = await env.D1.prepare(
    `UPDATE agent_messages AS m
        SET content = CASE WHEN trim(COALESCE(m.content, '')) = '' THEN ? ELSE m.content END,
            metadata = json_set(
              CASE WHEN json_valid(COALESCE(m.metadata, '{}')) THEN COALESCE(m.metadata, '{}') ELSE '{}' END,
              '$.status', 'cancelled',
              '$.cancelled', 1,
              '$.cancelled_by', ?,
              '$.cancelled_at', ?,
              '$.cancel_kind', ?,
              '$.cancel_reason', ?,
              '$.retryable', 1
            )
      WHERE ${predicates.join(' AND ')}`
  ).bind(...binds).run();
  const changed = Number(result.meta?.changes || 0);
  if (changed > 0) {
    await markDurableToolCallsCancelled(env, ctx, opts).catch(() => {});
  }
  return changed;
}

async function markDurableToolCallsCancelled(
  env: Env,
  ctx: AuthContext,
  opts: {
    requestId?: string | null;
    assistantMessageId?: string | null;
    sessionId?: string | null;
  }
): Promise<void> {
  const predicates = [
    `m.role = 'assistant'`,
    `EXISTS (
       SELECT 1
       FROM agent_sessions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = m.session_id
         AND s.org_id = ?
         AND s.deleted_at IS NULL
         AND (s.user_id = ? OR lower(u.email) = lower(?))
     )`,
  ];
  const binds: any[] = [ctx.orgId, ctx.userId, ctx.email || ''];
  if (opts.requestId) {
    predicates.push(`json_extract(m.metadata, '$.request_id') = ?`);
    binds.push(opts.requestId);
  }
  if (opts.assistantMessageId) {
    predicates.push(`m.id = ?`);
    binds.push(opts.assistantMessageId);
  }
  if (opts.sessionId) {
    predicates.push(`m.session_id = ?`);
    binds.push(opts.sessionId);
  }
  if (!opts.requestId && !opts.assistantMessageId && !opts.sessionId) return;

  const rows = await env.D1.prepare(
    `SELECT m.id, m.session_id, m.metadata
       FROM agent_messages m
      WHERE ${predicates.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT 20`
  ).bind(...binds).all<{ id: string; session_id: string; metadata: string | null }>();
  const now = new Date().toISOString();
  const updates = rows.results.map(row => {
    const metadata = safeParseJsonObject(row.metadata);
    const toolCalls = normalizeDurableToolCalls(metadata.tool_calls).map(tool => {
      const runs = tool.runs.map(run => (
        isTerminalDurableToolStatus(run.status)
          ? run
          : { ...run, status: 'cancelled' as DurableToolStatus, completed_at: now, result: { ...(run.result || {}), cancelled: true } }
      ));
      return {
        ...tool,
        status: aggregateDurableToolStatus(runs),
        activeRunId: undefined,
        runs,
        updated_at: now,
      };
    });
    if (toolCalls.length === 0) return null;
    metadata.tool_calls = compactToolStateForStorage(toolCalls);
    return env.D1.prepare(
      `UPDATE agent_messages SET metadata = ? WHERE id = ? AND session_id = ?`
    ).bind(JSON.stringify(metadata), row.id, row.session_id);
  }).filter(Boolean) as D1PreparedStatement[];
  if (updates.length > 0) await env.D1.batch(updates);
}

async function reserveAgentTurn(
  env: Env,
  sessionId: string,
  userMessageId: string,
  assistantMessageId: string,
  turnIndex: number,
  query: string,
  attachmentsJson: string,
  metadataJson: string
): Promise<void> {
  await env.D1.batch([
    env.D1.prepare(
      `INSERT INTO agent_messages (id, session_id, turn_index, role, content, attachments, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(userMessageId, sessionId, turnIndex, query, attachmentsJson),
    env.D1.prepare(
      `INSERT INTO agent_messages (id, session_id, turn_index, role, content, metadata, created_at)
       VALUES (?, ?, ?, 'assistant', '', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(assistantMessageId, sessionId, turnIndex + 1, metadataJson),
    env.D1.prepare(
      `UPDATE agent_sessions
       SET turn_count = CASE WHEN turn_count < ? THEN ? ELSE turn_count END,
           last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).bind(turnIndex + 2, turnIndex + 2, sessionId),
  ]);
}

function isAgentRunningReservationConflict(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return message.includes('idx_agent_messages_one_running_assistant_per_session')
    || (message.includes('UNIQUE constraint failed') && message.includes('agent_messages'));
}

async function touchAgentSessionActivity(
  env: Env,
  sessionId: string
): Promise<void> {
  await env.D1.prepare(
    `UPDATE agent_sessions
     SET last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(sessionId).run().catch(() => {});
}

function encodeSseEvent(data: any): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function encodeSseDone(): Uint8Array {
  return new TextEncoder().encode('data: [DONE]\n\n');
}

async function persistRunEventSafe(
  env: Env,
  runId: string | null | undefined,
  ctx: AuthContext,
  sessionId: string,
  eventType: string,
  payload: unknown
): Promise<void> {
  if (!runId) return;
  await appendAgentRunEvent(env, {
    runId,
    orgId: ctx.orgId,
    sessionId,
    eventType,
    payload,
  }).catch(error => {
    console.warn('[agent:runs] event append failed:', error?.message || error);
  });
}

function safeModelErrorText(): string {
  return 'MARTy hit a model handoff issue. Retry is safe.';
}

type DurableToolStatus = 'started' | 'executing' | 'done' | 'error' | 'cancelled';

type DurableToolRun = {
  id: string;
  input?: any;
  result?: any;
  status: DurableToolStatus;
  started_at?: string;
  completed_at?: string;
};

type DurableToolCall = {
  id: string;
  tool: string;
  input?: any;
  result?: any;
  status: DurableToolStatus;
  collapsed: boolean;
  activeRunId?: string;
  runs: DurableToolRun[];
  updated_at: string;
};

const TOOL_STATE_MAX_STRING = 4000;
const TOOL_STATE_MAX_ARRAY_ITEMS = 80;
const TOOL_STATE_MAX_OBJECT_KEYS = 80;
const TOOL_STATE_MAX_JSON = 60_000;

function safeParseJsonObject(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function truncateToolString(value: string): string {
  return value.length > TOOL_STATE_MAX_STRING
    ? `${value.slice(0, TOOL_STATE_MAX_STRING)}... [truncated ${value.length - TOOL_STATE_MAX_STRING} chars]`
    : value;
}

function sanitizeToolPayload(value: any, depth = 0): any {
  if (value == null) return value;
  if (typeof value === 'string') return truncateToolString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 5) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, TOOL_STATE_MAX_ARRAY_ITEMS).map(item => sanitizeToolPayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, nested] of Object.entries(value).slice(0, TOOL_STATE_MAX_OBJECT_KEYS)) {
      if (/base64|raw_html|html_content|file_bytes|bytes|buffer/i.test(key)) {
        out[key] = '[omitted]';
      } else {
        out[key] = sanitizeToolPayload(nested, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function compactToolStateForStorage(toolCalls: DurableToolCall[]): DurableToolCall[] {
  const sanitized = toolCalls.map(tool => sanitizeToolPayload(tool) as DurableToolCall);
  let json = JSON.stringify(sanitized);
  if (json.length <= TOOL_STATE_MAX_JSON) return sanitized;

  const trimmed = sanitized.map(tool => ({
    ...tool,
    runs: (tool.runs || []).slice(-6).map(run => ({
      ...run,
      result: run.result ? sanitizeToolPayload(run.result, 2) : run.result,
    })),
  }));
  json = JSON.stringify(trimmed);
  if (json.length <= TOOL_STATE_MAX_JSON) return trimmed;

  return trimmed.map(tool => ({
    ...tool,
    runs: (tool.runs || []).slice(-3).map(run => ({
      ...run,
      result: run.result ? { summary: 'Tool result persisted in run events; metadata copy truncated.' } : run.result,
    })),
  }));
}

function isTerminalDurableToolStatus(status: DurableToolStatus | string | undefined): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

function aggregateDurableToolStatus(runs: DurableToolRun[]): DurableToolStatus {
  if (runs.some(run => run.status === 'executing')) return 'executing';
  if (runs.some(run => run.status === 'started')) return 'started';
  if (runs.length > 0 && runs.every(run => run.status === 'cancelled')) return 'cancelled';
  if (runs.length > 0 && runs.every(run => run.status === 'error')) return 'error';
  return 'done';
}

function findLastOpenDurableRunIndex(runs: DurableToolRun[]): number {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    if (!isTerminalDurableToolStatus(runs[i]?.status)) return i;
  }
  return -1;
}

function normalizeDurableToolCalls(value: unknown): DurableToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object' && typeof (item as any).tool === 'string')
    .map(item => {
      const tool = item as any;
      const runs = Array.isArray(tool.runs)
        ? tool.runs
            .filter((run: any) => run && typeof run === 'object')
            .map((run: any) => ({
              id: typeof run.id === 'string' && run.id ? run.id : crypto.randomUUID(),
              input: run.input,
              result: run.result,
              status: isTerminalDurableToolStatus(run.status) || run.status === 'started' || run.status === 'executing'
                ? run.status as DurableToolStatus
                : 'done',
              started_at: typeof run.started_at === 'string' ? run.started_at : undefined,
              completed_at: typeof run.completed_at === 'string' ? run.completed_at : undefined,
            }))
        : [];
      const fallbackRun: DurableToolRun = {
        id: typeof tool.id === 'string' && tool.id ? `${tool.id}:run` : crypto.randomUUID(),
        input: tool.input,
        result: tool.result,
        status: isTerminalDurableToolStatus(tool.status) || tool.status === 'started' || tool.status === 'executing'
          ? tool.status as DurableToolStatus
          : 'done',
      };
      const normalizedRuns = runs.length > 0 ? runs : [fallbackRun];
      return {
        id: typeof tool.id === 'string' && tool.id ? tool.id : crypto.randomUUID(),
        tool: tool.tool,
        input: tool.input,
        result: tool.result,
        status: aggregateDurableToolStatus(normalizedRuns),
        collapsed: tool.collapsed !== false,
        activeRunId: typeof tool.activeRunId === 'string' ? tool.activeRunId : undefined,
        runs: normalizedRuns,
        updated_at: typeof tool.updated_at === 'string' ? tool.updated_at : new Date().toISOString(),
      };
    });
}

function upsertDurableToolEvent(toolCalls: DurableToolCall[], event: any): DurableToolCall[] {
  if (!event?.tool || !event?.status) return toolCalls;
  const status = String(event.status) as DurableToolStatus;
  if (!['started', 'executing', 'done', 'error', 'cancelled'].includes(status)) return toolCalls;

  const toolName = String(event.tool);
  const now = new Date().toISOString();
  const existingIndex = toolCalls.findIndex(tool => tool.tool === toolName);
  const createRun = (runStatus: DurableToolStatus): DurableToolRun => ({
    id: crypto.randomUUID(),
    input: sanitizeToolPayload(event.input),
    result: sanitizeToolPayload(event.result),
    status: runStatus,
    started_at: now,
    completed_at: isTerminalDurableToolStatus(runStatus) ? now : undefined,
  });

  if (existingIndex === -1) {
    const run = createRun(status);
    return compactToolStateForStorage([
      ...toolCalls,
      {
        id: crypto.randomUUID(),
        tool: toolName,
        input: run.input,
        result: run.result,
        status: run.status,
        collapsed: true,
        activeRunId: isTerminalDurableToolStatus(run.status) ? undefined : run.id,
        runs: [run],
        updated_at: now,
      },
    ]);
  }

  const next = toolCalls.map(tool => ({ ...tool, runs: [...(tool.runs || [])] }));
  const existing = next[existingIndex];
  const runs = existing.runs.length > 0
    ? existing.runs.map(run => ({ ...run }))
    : [{
        id: crypto.randomUUID(),
        input: existing.input,
        result: existing.result,
        status: existing.status,
      } as DurableToolRun];
  let activeRunId = existing.activeRunId;

  if (status === 'started') {
    const run = createRun('started');
    runs.push(run);
    activeRunId = run.id;
  } else if (status === 'executing') {
    let runIndex = runs.findIndex(run => run.id === activeRunId && !isTerminalDurableToolStatus(run.status));
    if (runIndex < 0) runIndex = findLastOpenDurableRunIndex(runs);
    if (runIndex < 0) {
      const run = createRun('executing');
      runs.push(run);
      activeRunId = run.id;
    } else {
      runs[runIndex] = {
        ...runs[runIndex],
        status: 'executing',
        input: event.input !== undefined ? sanitizeToolPayload(event.input) : runs[runIndex].input,
      };
      activeRunId = runs[runIndex].id;
    }
  } else {
    let runIndex = runs.findIndex(run => run.id === activeRunId && !isTerminalDurableToolStatus(run.status));
    if (runIndex < 0) runIndex = findLastOpenDurableRunIndex(runs);
    if (runIndex < 0) {
      runs.push(createRun(status));
    } else {
      runs[runIndex] = {
        ...runs[runIndex],
        status,
        result: event.result !== undefined ? sanitizeToolPayload(event.result) : runs[runIndex].result,
        completed_at: now,
      };
    }
    activeRunId = undefined;
  }

  const latestRun = runs[runs.length - 1];
  next[existingIndex] = {
    ...existing,
    input: latestRun?.input,
    result: latestRun?.result,
    status: aggregateDurableToolStatus(runs),
    runs,
    activeRunId,
    updated_at: now,
  };
  return compactToolStateForStorage(next);
}

async function persistAssistantToolCallsMetadata(
  env: Env,
  assistantMessageId: string,
  sessionId: string,
  toolCalls: DurableToolCall[]
): Promise<void> {
  if (!assistantMessageId || !sessionId) return;
  const row = await env.D1.prepare(
    `SELECT metadata FROM agent_messages WHERE id = ? AND session_id = ? LIMIT 1`
  ).bind(assistantMessageId, sessionId).first<{ metadata: string | null }>().catch(() => null);
  const metadata = safeParseJsonObject(row?.metadata);
  metadata.tool_calls = compactToolStateForStorage(toolCalls);
  await env.D1.prepare(
    `UPDATE agent_messages SET metadata = ? WHERE id = ? AND session_id = ?`
  ).bind(JSON.stringify(metadata), assistantMessageId, sessionId).run().catch(error => {
    console.warn('[agent:tools] metadata persist failed:', error?.message || error);
  });
}

function safeDeckJobForMessage(job: any): Record<string, any> | null {
  if (!job?.id) return null;
  return {
    id: job.id,
    assistant_message_id: job.assistant_message_id || null,
    status: job.status,
    phase: job.phase,
    title: job.title,
    artifact_visibility: job.artifact_visibility || null,
    status_label: job.status_label,
    revision_round: job.revision_round,
    max_revision_rounds: job.max_revision_rounds,
    qa_summary: job.qa_summary || null,
    qa_findings: Array.isArray(job.qa_findings) ? job.qa_findings.slice(0, 12) : [],
    blocked_reason: job.blocked_reason || null,
    visible_document_cards: normalizeDocumentCards(job.visible_document_cards || []),
    diagnostic_document_cards: normalizeDocumentCards(job.diagnostic_document_cards || []),
    last_event_seq: Number(job.last_event_seq || 0),
    last_event_message: job.last_event_message || '',
  };
}

export const __agentToolStateTestHooks = {
  upsertDurableToolEvent,
  normalizeDurableToolCalls,
  compactToolStateForStorage,
  safeDeckJobForMessage,
};

function compactRoutedToolResult(tool: string, result: any): any {
  if (!result || typeof result !== 'object') return result;
  if (tool === 'inspect_platform_telemetry') {
    const compact: Record<string, unknown> = {
      ok: result.ok,
      topic: result.topic,
      error: result.error,
      message: result.message,
      access_scope: result.access_scope,
    };
    if (result.user) compact.user = result.user;
    if (result.email_ingestion) compact.email_ingestion = result.email_ingestion;
    if (result.backfill) compact.backfill = result.backfill;
    if (result.runtime) compact.runtime = result.runtime;
    if (result.coverage) compact.coverage = result.coverage;
    if (result.work_queue) compact.work_queue = result.work_queue;
    if (result.pipeline_health) compact.pipeline_health = result.pipeline_health;
    if (result.schedule_contract) compact.schedule_contract = result.schedule_contract;
    if (result.settings) compact.settings = result.settings;
    if (result.operational_cadence) compact.operational_cadence = result.operational_cadence;
    if (Array.isArray(result.recent_sync_jobs)) compact.recent_sync_jobs = result.recent_sync_jobs.slice(0, 8);
    if (Array.isArray(result.recent_task_runs)) compact.recent_task_runs = result.recent_task_runs.slice(0, 8);
    if (result.recent_activity) {
      compact.recent_activity = {
        recent_matched_conversations: Array.isArray(result.recent_activity.recent_matched_conversations)
          ? result.recent_activity.recent_matched_conversations.slice(0, 5)
          : [],
        user_related_sync_runs: Array.isArray(result.recent_activity.user_related_sync_runs)
          ? result.recent_activity.user_related_sync_runs.slice(0, 8)
          : [],
        recent_org_ingestion_runs: Array.isArray(result.recent_activity.recent_org_ingestion_runs)
          ? result.recent_activity.recent_org_ingestion_runs.slice(0, 5)
          : [],
        user_related_task_runs: Array.isArray(result.recent_activity.user_related_task_runs)
          ? result.recent_activity.user_related_task_runs.slice(0, 5)
          : [],
        user_related_work_queue: result.recent_activity.user_related_work_queue,
      };
    }
    if (Array.isArray(result.answer_guidance)) compact.answer_guidance = result.answer_guidance;
    if (Array.isArray(result.candidates)) compact.candidates = result.candidates.slice(0, 5);
    return compact;
  }
  if (tool === 'get_firm_relationship_snapshot') {
    return {
      current_portfolio: Array.isArray(result.current_portfolio) ? result.current_portfolio : [],
      active_pipeline: Array.isArray(result.active_pipeline) ? result.active_pipeline.slice(0, 80) : [],
      watchlist: Array.isArray(result.watchlist) ? result.watchlist.slice(0, 80) : [],
      passed_count: Array.isArray(result.passed) ? result.passed.length : undefined,
      exited_count: Array.isArray(result.exited) ? result.exited.length : undefined,
      counts: result.counts,
      classification_rules: result.classification_rules,
      data_quality_warnings: Array.isArray(result.data_quality_warnings)
        ? result.data_quality_warnings.slice(0, 25)
        : [],
      sources: Array.isArray(result.sources) ? result.sources.slice(0, 80) : [],
      note: result.note,
    };
  }
  if (tool === 'search_events') {
    const events = Array.isArray(result.events) ? result.events : [];
    return {
      events: events.slice(0, 20).map((event: any) => ({
        id: event.id,
        title: event.title,
        event_type: event.event_type,
        source: event.source,
        start_time: event.start_time,
        end_time: event.end_time,
        has_transcript: event.has_transcript,
        transcript_excerpt: event.transcript_excerpt,
        summary: event.summary,
        topics_discussed: event.topics_discussed,
        key_decisions: event.key_decisions,
        action_items: event.action_items,
        attendee_count: event.attendee_count,
      })),
      count: result.count,
      coverage: result.coverage,
      data_model_note: result.data_model_note,
      note: result.note,
    };
  }
  if (tool === 'recall') {
    return {
      results: Array.isArray(result.results) ? result.results.slice(0, 20) : undefined,
      sources: Array.isArray(result.sources) ? result.sources.slice(0, 20) : undefined,
      coverage: result.coverage,
      count: result.count,
      note: result.note,
    };
  }
  return result;
}

function titleFromQuery(query: string): string {
  const cleaned = query
    .replace(/\s+/g, ' ')
    .replace(/^(please|can you|could you|i need you to|i need to)\s+/i, '')
    .trim();
  if (!cleaned) return 'MARTy MAX Request';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1, 80);
}

function formatSourceStats(result: any): string {
  const stats = Array.isArray(result?.coverage?.stats) ? result.coverage.stats : [];
  if (stats.length === 0) return 'No source-family coverage was reported.';
  return stats
    .map((s: any) => {
      const errors = Array.isArray(s.errors) && s.errors.length > 0 ? `, errors: ${s.errors.length}` : '';
      const cap = s.cap_hit ? ', cap hit' : '';
      return `${s.source_family}: ${s.rows_scanned ?? 0} scanned / ${s.rows_returned ?? 0} returned / ${s.candidates_added ?? 0} candidates${cap}${errors}`;
    })
    .join('\n');
}

function formatMaxSetAnswer(result: any, elapsedMs: number): string {
  if (result?.error) {
    return [
      `MAX set-builder failed before it could complete: ${result.error}`,
      '',
      'I did not create an export because the deterministic set-builder did not return a safe result.',
    ].join('\n');
  }

  const confirmed = Array.isArray(result?.confirmed) ? result.confirmed.length : 0;
  const probable = Array.isArray(result?.probable) ? result.probable.length : 0;
  const needsReview = Array.isArray(result?.needs_review) ? result.needs_review.length : 0;
  const excluded = Array.isArray(result?.excluded) ? result.excluded.length : 0;
  const safety = result?.safety_status || 'unknown';
  const gate = result?.quality_gate || {};
  const artifact = result?.artifact_card;
  const gaps = Array.isArray(result?.gaps) ? result.gaps.filter(Boolean).slice(0, 8) : [];

  const lines = [
    `MAX set-builder finished in ${Math.round(elapsedMs / 1000)}s.`,
    '',
    `Status: **${safety}**`,
    `Counts: **${confirmed} confirmed**, **${probable} probable**, **${needsReview} needs review**, **${excluded} excluded**.`,
  ];

  if (artifact) {
    lines.push('', `Workbook: **${artifact.title || 'MAX export'}** is ready in the card above.`);
  } else if (gate.artifact_allowed === false || result?.note) {
    lines.push('', `Artifact: ${gate.artifact_suppressed_reason || result.note || 'No workbook was created.'}`);
  }

  if (gate.reasons?.length) {
    lines.push('', 'Quality gate:', ...gate.reasons.slice(0, 8).map((reason: string) => `- ${reason}`));
  }

  if (gaps.length > 0) {
    lines.push('', 'Gaps:', ...gaps.map((gap: string) => `- ${gap}`));
  }

  lines.push('', 'Coverage:', formatSourceStats(result));

  return lines.join('\n');
}

async function createMaxModeJobRecordSafe(
  env: Env,
  ctx: AuthContext,
  input: {
    sessionId: string;
    assistantMessageId: string;
    requestId: string;
    agentRunId?: string | null;
    query: string;
    maxInput: any;
  }
): Promise<string | null> {
  const jobId = crypto.randomUUID();
  try {
    await env.D1.prepare(
      `INSERT INTO max_mode_jobs
         (id, org_id, user_id, query, task_type, entity_kind, status,
          session_id, assistant_message_id, request_id, agent_run_id,
          heartbeat_at, progress_json)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
    ).bind(
      jobId,
      ctx.orgId,
      ctx.userId,
      input.query,
      input.maxInput?.task_type || 'generic_set',
      input.maxInput?.entity_kind || 'mixed',
      input.sessionId,
      input.assistantMessageId,
      input.requestId,
      input.agentRunId || null,
      JSON.stringify({ phase: 'started', started_at: new Date().toISOString() })
    ).run();
    return jobId;
  } catch (error: any) {
    console.warn('[max-mode:job] create failed:', error?.message || error);
    return null;
  }
}

async function updateMaxModeJobRecordSafe(
  env: Env,
  jobId: string | null | undefined,
  input: {
    status: 'completed' | 'failed' | 'cancelled';
    result?: any;
    artifactDocumentId?: string | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  if (!jobId) return;
  try {
    await env.D1.prepare(
      `UPDATE max_mode_jobs
          SET status = ?,
              result_json = COALESCE(?, result_json),
              artifact_document_id = COALESCE(?, artifact_document_id),
              error_message = COALESCE(?, error_message),
              progress_json = json_set(
                CASE WHEN json_valid(COALESCE(progress_json, '{}')) THEN COALESCE(progress_json, '{}') ELSE '{}' END,
                '$.phase', ?,
                '$.updated_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
              ),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END
        WHERE id = ?`
    ).bind(
      input.status,
      input.result ? JSON.stringify(input.result) : null,
      input.artifactDocumentId || null,
      input.errorMessage || null,
      input.status,
      input.status,
      jobId
    ).run();
  } catch (error: any) {
    console.warn('[max-mode:job] update failed:', error?.message || error);
  }
}

async function persistImmediateAgentResult(
  env: Env,
  ctx: AuthContext,
  session: AgentSession,
  assistantMessageId: string,
  requestId: string,
  runtimeFingerprint: any,
  deepDive: boolean,
  content: string,
  status: 'done' | 'error',
  documentCards: MartyDocumentCard[] = [],
  error?: string,
  toolCalls: DurableToolCall[] = []
): Promise<void> {
  const metadataObj: Record<string, any> = {
    status,
    request_id: requestId,
    runtime_fingerprint: runtimeFingerprint,
    deep_dive: deepDive,
  };
  if (error) metadataObj.error = error;
  const normalizedCards = normalizeDocumentCards(documentCards);
  if (normalizedCards.length > 0) metadataObj.document_cards = normalizedCards;
  const normalizedTools = compactToolStateForStorage(toolCalls);
  if (normalizedTools.length > 0) metadataObj.tool_calls = normalizedTools;
  const output = normalizeMartyOutputText(content, new Set());
  if (output.invalidCitationsStripped > 0) {
    metadataObj.invalid_citations_stripped = output.invalidCitationsStripped;
  }
  if (output.labeledCitationsCanonicalized > 0) {
    metadataObj.labeled_citations_canonicalized = output.labeledCitationsCanonicalized;
  }
  await env.D1.prepare(
    `UPDATE agent_messages SET content = ?, sources_json = ?, metadata = ? WHERE id = ?`
  ).bind(
    output.text,
    null,
    JSON.stringify(metadataObj),
    assistantMessageId
  ).run();
  if (normalizedCards.length > 0) {
    await linkDocumentCardsToMessage(normalizedCards, assistantMessageId, ctx, env);
  }
  await touchAgentSessionActivity(env, session.id);
}

function durableMaxAcceptedText(plan: MaxExecutionPlan): string {
  const families = plan.source_families.join(', ');
  if (plan.task_shape === 'set_builder') {
    return `MAX accepted. I’m building the set in the background across ${families} and will attach the export here when it is ready.`;
  }
  if (plan.artifact.required) {
    return `MAX accepted. I’m running a durable ${plan.task_shape.replace(/_/g, ' ')} across ${families} and will attach the report here when it is ready.`;
  }
  return `MAX accepted. I’m running the durable sweep across ${families} and will update this answer when it completes.`;
}

async function persistDurableMaxAccepted(
  env: Env,
  session: AgentSession,
  assistantMessageId: string,
  requestId: string,
  runId: string,
  runtimeFingerprint: any,
  plan: MaxExecutionPlan,
  jobId: string,
  workQueueId?: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const tool = plan.task_shape === 'set_builder' ? 'build_max_set' : 'max_evidence_report';
  const input = plan.task_shape === 'set_builder'
    ? plan.max_set_input
    : { query: plan.search_query, plan };
  const metadata = {
    status: 'running',
    request_id: requestId,
    run_id: runId,
    runtime_fingerprint: runtimeFingerprint,
    deep_dive: true,
    durable: true,
    max_job: {
      id: jobId,
      status: 'queued',
      task_shape: plan.task_shape,
      source_families: plan.source_families,
      work_queue_id: workQueueId || null,
    },
    tool_calls: [{
      id: `${tool}:${jobId}`,
      tool,
      input,
      status: 'executing',
      collapsed: true,
      activeRunId: jobId,
      updated_at: now,
      runs: [{
        id: jobId,
        input,
        status: 'executing',
      }],
    }],
  };
  await env.D1.prepare(
    `UPDATE agent_messages
        SET content = ?,
            metadata = ?
      WHERE id = ? AND session_id = ?`
  ).bind(
    durableMaxAcceptedText(plan),
    JSON.stringify(metadata),
    assistantMessageId,
    session.id
  ).run();
  await touchAgentSessionActivity(env, session.id);
}

function createDurableMaxAcceptedResponse(args: {
  env: Env;
  session: AgentSession;
  requestId: string;
  runId: string;
  jobId: string;
  plan: MaxExecutionPlan;
  runtimeFingerprint: any;
  turnAttachments: UploadSummary[];
  sessionAttachments: Awaited<ReturnType<typeof assembleSessionAttachments>>;
}): Response {
  const {
    session,
    requestId,
    runId,
    jobId,
    plan,
    runtimeFingerprint,
    turnAttachments,
    sessionAttachments,
  } = args;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeSseEvent({ type: 'session', session_id: session.id }));
      controller.enqueue(encodeSseEvent({ type: 'request', request_id: requestId }));
      controller.enqueue(encodeSseEvent({ type: 'run', run_id: runId, request_id: requestId, session_id: session.id, durable: true }));
      controller.enqueue(encodeSseEvent({ type: 'runtime', runtime_fingerprint: runtimeFingerprint }));
      controller.enqueue(encodeSseEvent({ type: 'sources', sources: [] }));
      controller.enqueue(encodeSseEvent({
        type: 'attachments',
        turn_attachments: turnAttachments,
        session_attachments: sessionAttachments.summaries,
        bytes_used: sessionAttachments.bytesUsed,
        bytes_total: sessionAttachments.bytesTotal,
      }));
      controller.enqueue(encodeSseEvent({
        type: 'max_step',
        durable: true,
        job_id: jobId,
        run_id: runId,
        request_id: requestId,
        session_id: session.id,
        task_shape: plan.task_shape,
        step: 'planned',
        status: 'queued',
        source_families: plan.source_families,
        message: durableMaxAcceptedText(plan),
      }));
      controller.enqueue(encodeSseEvent({
        type: 'tool_call',
        tool: plan.task_shape === 'set_builder' ? 'build_max_set' : 'max_evidence_report',
        input: plan.task_shape === 'set_builder' ? plan.max_set_input : { query: plan.search_query, plan },
        status: 'executing',
        durable: true,
        job_id: jobId,
      }));
      controller.enqueue(encodeSseEvent({ text: durableMaxAcceptedText(plan) }));
      controller.enqueue(encodeSseDone());
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function createStreamingMaxSetResponse(args: {
  ctx: AuthContext;
  env: Env;
  session: AgentSession;
  query: string;
  input: any;
  requestId: string;
  runId?: string;
  assistantMessageId: string;
  runtimeFingerprint: any;
  turnAttachments: UploadSummary[];
  sessionAttachments: Awaited<ReturnType<typeof assembleSessionAttachments>>;
  turnIndex: number;
  signal?: AbortSignal;
}): Response {
  const {
    ctx,
    env,
    session,
    query,
    input,
    requestId,
    runId,
    assistantMessageId,
    runtimeFingerprint,
    turnAttachments,
    sessionAttachments,
    turnIndex,
    signal,
  } = args;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: any) => controller.enqueue(encodeSseEvent(data));
      const started = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let maxJobId: string | null = null;
      let durableToolCalls: DurableToolCall[] = [];
      const recordToolEvent = async (event: any) => {
        if (event?.type !== 'tool_call' && event?.type !== 'tool_result') return;
        durableToolCalls = upsertDurableToolEvent(durableToolCalls, event);
        await persistAssistantToolCallsMetadata(env, assistantMessageId, session.id, durableToolCalls);
      };
      try {
        emit({ type: 'session', session_id: session.id });
        emit({ type: 'request', request_id: requestId });
        if (runId) emit({ type: 'run', run_id: runId, request_id: requestId, session_id: session.id });
        emit({ type: 'runtime', runtime_fingerprint: runtimeFingerprint });
        emit({ type: 'sources', sources: [] });
        emit({
          type: 'attachments',
          turn_attachments: turnAttachments,
          session_attachments: sessionAttachments.summaries,
          bytes_used: sessionAttachments.bytesUsed,
          bytes_total: sessionAttachments.bytesTotal,
        });
        if (signal?.aborted) throw new Error('MARTy request cancelled');
        maxJobId = await createMaxModeJobRecordSafe(env, ctx, {
          sessionId: session.id,
          assistantMessageId,
          requestId,
          agentRunId: runId,
          query,
          maxInput: input,
        });
        if (maxJobId) {
          emit({ type: 'max_step', job_id: maxJobId, step: 'started', status: 'running' });
          await persistRunEventSafe(env, runId, ctx, session.id, 'max_step', {
            type: 'max_step',
            job_id: maxJobId,
            step: 'started',
            status: 'running',
          });
        }
        const initialToolEvent = { type: 'tool_call', tool: 'build_max_set', input, status: 'executing', forced: true };
        emit(initialToolEvent);
        await recordToolEvent(initialToolEvent);

        heartbeat = setInterval(() => {
          try {
            const heartbeatEvent = {
              type: 'tool_call',
              tool: 'build_max_set',
              status: 'executing',
              forced: true,
              heartbeat: true,
              elapsed_ms: Date.now() - started,
            };
            emit(heartbeatEvent);
            void recordToolEvent(heartbeatEvent);
          } catch {
            // The client may have disconnected; the main path will handle it.
          }
        }, 15_000);

        const abortPromise = new Promise<never>((_, reject) => {
          if (!signal) return;
          if (signal.aborted) reject(new Error('MARTy request cancelled'));
          else signal.addEventListener('abort', () => reject(new Error('MARTy request cancelled')), { once: true });
        });
        const result: any = await withTimeout(
          Promise.race([
            buildMaxSetTool(ctx, input, env, { deepDive: true, signal, jobId: maxJobId || runId }),
            abortPromise,
          ]),
          STREAMING_MAX_SET_TIMEOUT_MS,
          `MAX set-builder exceeded ${Math.round(STREAMING_MAX_SET_TIMEOUT_MS / 1000)}s before returning.`
        );
        if (signal?.aborted || await wasCancelledIncludingKV(requestId, env)) {
          throw new Error('MARTy request cancelled');
        }
        if (heartbeat) clearInterval(heartbeat);

        const compact = compactMaxSetResultForContext(result);
        const documentCards = normalizeDocumentCards(result?.document_cards || []);
        if (documentCards.length > 0) {
          emit({ type: 'document_cards', document_cards: documentCards });
        }
        const doneToolEvent = { type: 'tool_result', tool: 'build_max_set', result: compact, status: 'done', forced: true };
        emit(doneToolEvent);
        await recordToolEvent(doneToolEvent);

        const finalText = formatMaxSetAnswer(result, Date.now() - started);
        emit({ text: finalText });
        await persistRunEventSafe(env, runId, ctx, session.id, 'max_complete', {
          type: 'max_complete',
          job_id: maxJobId,
          safety_status: result?.safety_status,
          counts: {
            confirmed: Array.isArray(result?.confirmed) ? result.confirmed.length : 0,
            probable: Array.isArray(result?.probable) ? result.probable.length : 0,
            needs_review: Array.isArray(result?.needs_review) ? result.needs_review.length : 0,
          },
        });
        await updateMaxModeJobRecordSafe(env, maxJobId, {
          status: result?.error ? 'failed' : 'completed',
          result: compact,
          artifactDocumentId: documentCards[0]?.document_id || result?.artifact_card?.document_id || null,
          errorMessage: result?.error || null,
        });
        await persistImmediateAgentResult(
          env,
          ctx,
          session,
          assistantMessageId,
          requestId,
          runtimeFingerprint,
          true,
          finalText,
          result?.error ? 'error' : 'done',
          documentCards,
          result?.error,
          durableToolCalls
        );
        await updateAgentRunStatus(env, runId, result?.error ? 'error' : 'completed', {
          errorCode: result?.error ? 'MAX_SET_ERROR' : null,
          errorJson: result?.error ? result : undefined,
        }).catch(() => {});

        if (turnIndex === 0 && !session.title) {
          await env.D1.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?')
            .bind(titleFromQuery(query), session.id)
            .run()
            .catch(() => {});
        }
      } catch (error: any) {
        if (heartbeat) clearInterval(heartbeat);
        const message = String(error?.message || error);
        if (signal?.aborted || /cancelled/i.test(message)) {
          const finalText = '_(cancelled before MARTy finished the MAX set-builder run)_';
          const cancelledToolEvent = { type: 'tool_result', tool: 'build_max_set', result: { cancelled: true }, status: 'cancelled', forced: true };
          emit(cancelledToolEvent);
          await recordToolEvent(cancelledToolEvent);
          emit({ text: finalText });
          await markAgentTurnCancelled(env, ctx, {
            assistantMessageId,
            sessionId: session.id,
            reason: 'Stopped by user.',
            kind: 'user_stop',
          }).catch(() => 0);
          await updateMaxModeJobRecordSafe(env, maxJobId, {
            status: 'cancelled',
            errorMessage: 'Stopped by user.',
          });
          await updateAgentRunStatus(env, runId, 'cancelled').catch(() => {});
          return;
        }
        const finalText = [
          `MAX mode failed before it could return the set-builder result: ${message}`,
          '',
          'I did not create an export because the run did not complete safely.',
        ].join('\n');
        const errorToolEvent = { type: 'tool_result', tool: 'build_max_set', result: { error: message }, status: 'error', forced: true };
        emit(errorToolEvent);
        await recordToolEvent(errorToolEvent);
        emit({ text: finalText });
        await persistImmediateAgentResult(
          env,
          ctx,
          session,
          assistantMessageId,
          requestId,
          runtimeFingerprint,
          true,
          finalText,
          'error',
          [],
          message,
          durableToolCalls
        ).catch(() => {});
        await updateMaxModeJobRecordSafe(env, maxJobId, {
          status: 'failed',
          errorMessage: message,
        });
        await updateAgentRunStatus(env, runId, 'error', {
          errorCode: 'MAX_MODE_STREAMING_ERROR',
          errorJson: { message },
        }).catch(() => {});
      } finally {
        unregisterRequest(requestId);
        controller.enqueue(encodeSseDone());
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export async function listSessions(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await markStaleRunningAgentTurns(ctx, env);
  const rows = await env.D1.prepare(
    `SELECT DISTINCT s.*
     FROM agent_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.org_id = ?
       AND s.deleted_at IS NULL
       AND (s.user_id = ? OR lower(u.email) = lower(?))
     ORDER BY last_activity_at DESC LIMIT 100`
  ).bind(ctx.orgId, ctx.userId, ctx.email || '').all();
  return jsonResponse({ sessions: rows.results });
}

export async function createSession(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  let contextEntityType: string | null = null;
  let contextEntityId: string | null = null;
  let clientSessionId: string | null = null;
  try {
    const body = await parseJsonBody<any>(request);
    contextEntityType = typeof body?.context_entity_type === 'string' ? body.context_entity_type : null;
    contextEntityId = typeof body?.context_entity_id === 'string' ? body.context_entity_id : null;
    clientSessionId = normalizeClientSessionId(body?.client_session_id);
  } catch {
    // Empty bodies are allowed; this endpoint mostly exists so the client can
    // create a durable chat target before handing a turn to the stream.
  }

  if (clientSessionId) {
    const existing = await loadAccessibleAgentSession(clientSessionId, ctx, env);
    if (existing) return jsonResponse({ session: existing });
  }

  const session = await createAgentSessionRecord(ctx, env, contextEntityType, contextEntityId, clientSessionId);
  return jsonResponse({ session });
}

export async function getSessionMessages(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const normalizedId = normalizeSessionId(id);
  if (!normalizedId) return errorResponse('SESSION_NOT_FOUND', 404, 'That MARTy session no longer exists.');
  await markStaleRunningAgentTurns(ctx, env, normalizedId);
  const session = await loadAccessibleAgentSession(normalizedId, ctx, env);
  if (!session) return errorResponse('SESSION_NOT_FOUND', 404, 'That MARTy session no longer exists.');

  const messages = await env.D1.prepare(
    'SELECT * FROM agent_messages WHERE session_id = ? ORDER BY turn_index ASC'
  ).bind(normalizedId).all<Record<string, any>>();
  const assistantMessageIds = messages.results
    .filter(m => m.role === 'assistant' && typeof m.id === 'string')
    .map(m => m.id);
  const deckJobsByMessage = new Map<string, any[]>();
  if (assistantMessageIds.length > 0) {
    const placeholders = assistantMessageIds.map(() => '?').join(',');
    const jobs = await env.D1.prepare(
      `SELECT id, assistant_message_id
         FROM deck_artifact_jobs
        WHERE org_id = ?
          AND session_id = ?
          AND assistant_message_id IN (${placeholders})
        ORDER BY created_at ASC`
    ).bind(ctx.orgId, normalizedId, ...assistantMessageIds).all<{ id: string; assistant_message_id: string }>().catch(() => ({ results: [] as { id: string; assistant_message_id: string }[] }));
    for (const jobRow of jobs.results) {
      const snapshot = await getDeckJobSnapshot(ctx, env, jobRow.id).catch(() => null);
      const safeSnapshot = safeDeckJobForMessage(snapshot);
      if (!safeSnapshot || !jobRow.assistant_message_id) continue;
      const existing = deckJobsByMessage.get(jobRow.assistant_message_id) || [];
      existing.push(safeSnapshot);
      deckJobsByMessage.set(jobRow.assistant_message_id, existing);
    }
  }
  const hydratedMessages: Array<Record<string, any> & {
    sources: CitationSource[] | null;
    attachments: UploadSummary[] | null;
  }> = (messages.results as any[]).map(m => ({
    ...m,
    metadata: (() => {
      const metadata = safeParseJsonObject(m.metadata);
      const deckJobs = deckJobsByMessage.get(m.id);
      if (deckJobs?.length) {
        metadata.deck_jobs = deckJobs;
        const visibleCards = normalizeDocumentCards(deckJobs.flatMap(job => job.visible_document_cards || []));
        if (visibleCards.length > 0) {
          metadata.document_cards = normalizeDocumentCards([
            ...(Array.isArray(metadata.document_cards) ? metadata.document_cards : []),
            ...visibleCards,
          ]);
        }
      }
      return JSON.stringify(metadata);
    })(),
    sources: m.sources_json ? safeParseJson<CitationSource[]>(m.sources_json) : null,
    attachments: m.attachments ? safeParseJson<UploadSummary[]>(m.attachments) : null,
  }));
  for (const message of hydratedMessages) {
    if (!message.sources || message.sources.length === 0) continue;
    const filteredSources = await filterCitationSourcesForViewer(message.sources, ctx.orgId, env, ctx);
    if (filteredSources.length !== message.sources.length) {
      message.sources = filteredSources;
      if (message.role === 'assistant') {
        message.content = 'This prior MARTy response included private sources you cannot read, so its generated content is hidden for this viewer.';
      }
    }
  }
  return jsonResponse({ session, messages: hydratedMessages });
}

function safeParseJson<T>(json: string): T | null {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function linkDocumentCardsToMessage(
  cards: MartyDocumentCard[],
  assistantMessageId: string,
  ctx: AuthContext,
  env: Env
) {
  const normalized = normalizeDocumentCards(cards);
  if (normalized.length === 0) return;
  const stmts = normalized.map(card =>
    env.D1.prepare(
      `INSERT OR IGNORE INTO document_links
         (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at, created_by)
       VALUES (?, ?, ?, 'agent_message', ?, ?, 'llm_extracted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
    ).bind(
      crypto.randomUUID(),
      card.document_id,
      ctx.orgId,
      assistantMessageId,
      card.generated ? 'derived' : 'mentioned',
      ctx.userId
    )
  );
  await env.D1.batch(stmts).catch(e => {
    console.warn('[agent:documents] failed linking cards to message:', e?.message || e);
  });
}

export async function deleteSession(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const normalizedId = normalizeSessionId(id);
  const session = normalizedId ? await loadAccessibleAgentSession(normalizedId, ctx, env) : null;
  if (!session) return errorResponse('SESSION_NOT_FOUND', 404);

  await env.D1.batch([
    env.D1.prepare('DELETE FROM agent_messages WHERE session_id = ?').bind(normalizedId),
    env.D1.prepare('DELETE FROM rag_query_logs WHERE session_id = ?').bind(normalizedId),
    env.D1.prepare('DELETE FROM agent_sessions WHERE id = ?').bind(normalizedId),
  ]);
  return jsonResponse({ ok: true });
}

export async function updateSessionTitle(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ title: string }>(request);
  if (!body?.title) return errorResponse('VALIDATION_ERROR', 400, 'title required');

  const normalizedId = normalizeSessionId(id);
  const session = normalizedId ? await loadAccessibleAgentSession(normalizedId, ctx, env) : null;
  if (!session) return errorResponse('SESSION_NOT_FOUND', 404);

  await env.D1.prepare(
    'UPDATE agent_sessions SET title = ? WHERE id = ?'
  ).bind(body.title.trim().slice(0, 80), normalizedId).run();
  return jsonResponse({ ok: true });
}

export async function logCitationClick(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{
    message_id?: string;
    source_id: number;
    source_type?: string;
    source_table?: string;
    source_row_id?: string;
  }>(request);
  if (!body || typeof body.source_id !== 'number') {
    return errorResponse('VALIDATION_ERROR', 400);
  }
  try {
    await env.D1.prepare(
      `INSERT INTO marty_citation_clicks
         (id, org_id, user_id, message_id, source_id, source_type, source_table, source_row_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      ctx.orgId,
      ctx.userId,
      body.message_id || null,
      body.source_id,
      body.source_type || null,
      body.source_table || null,
      body.source_row_id || null
    ).run();
  } catch (e) {
    console.error('[citations] click log failed:', e);
  }
  return jsonResponse({ ok: true });
}

// POST /api/agent/cancel — abort an in-flight queryAgent request.
// Body: { request_id: string } (the ID emitted as the first stream event).
// Returns 200 even if the request isn't currently running on this isolate —
// we still write the cross-isolate KV marker so a different isolate's poll
// catches it. The response indicates whether we hit a local controller.
export async function cancelAgentRequest(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ request_id?: string; run_id?: string; session_id?: string }>(request);
  const requestId = body?.request_id ? normalizeRequestId(body.request_id) : null;
  const runId = body?.run_id ? normalizeRequestId(body.run_id) : null;
  const sessionId = body?.session_id ? normalizeSessionId(body.session_id) : null;
  if (!requestId && !runId && !sessionId) {
    return errorResponse('VALIDATION_ERROR', 400, 'request_id, run_id, or session_id required');
  }
  const result = requestId
    ? await cancelRequest(requestId, env)
    : { local: false };
  await markAgentRunCancelRequested(env, ctx, { runId, requestId, sessionId }).catch(() => 0);
  const cancelledMaxJobs = await cancelMaxModeJobs(env, ctx, { runId, requestId, sessionId }).catch(() => 0);
  const cancelledRows = await markAgentTurnCancelled(env, ctx, {
    requestId,
    sessionId,
    reason: 'Stopped by user.',
    kind: 'user_stop',
  }).catch(() => 0);
  // Audit the cancel for debugging — keeps a trace in case Lucas reports
  // "I clicked stop and nothing happened."
  console.log(`[agent:cancel] request=${requestId || 'n/a'} run=${runId || 'n/a'} session=${sessionId || 'n/a'} user=${ctx.userId} local=${result.local} rows=${cancelledRows} max_jobs=${cancelledMaxJobs}`);
  return jsonResponse({ ok: true, local: result.local, cancelled_rows: cancelledRows, cancelled_max_jobs: cancelledMaxJobs });
}

export async function getAgentRunEvents(
  request: Request,
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const afterSeq = Math.max(0, Number(url.searchParams.get('after_seq') || 0));
  const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait_ms') || 0), 0), 25_000);

  const started = Date.now();
  let snapshot = await fetchAgentRunEvents(env, ctx, runId, afterSeq);
  while (snapshot.run && snapshot.events.length === 0 && waitMs > 0 && Date.now() - started < waitMs) {
    await new Promise(resolve => setTimeout(resolve, 750));
    snapshot = await fetchAgentRunEvents(env, ctx, runId, afterSeq);
  }
  if (!snapshot.run) return errorResponse('RUN_NOT_FOUND', 404, 'That MARTy run no longer exists.');
  return jsonResponse({
    run: snapshot.run,
    events: snapshot.events,
    latest_seq: snapshot.events.length > 0
      ? snapshot.events[snapshot.events.length - 1].seq
      : afterSeq,
  });
}

export async function getSessionTrace(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const logs = await env.D1.prepare(
    `SELECT * FROM rag_query_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(id).all();
  return jsonResponse({ logs: logs.results });
}

// ---------------------------------------------------------------------------
// God Mode query (streaming SSE with tool use)
// ---------------------------------------------------------------------------

export async function queryAgent(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || '';

  let query: string;
  let sessionId: string | null;
  let contextEntityType: string | null = null;
  let contextEntityId: string | null = null;
  let uploadedText: string | undefined;
  let deepDive = false;
  let uploadIds: string[] = [];
  let clientRequestId: string | null = null;
  let interruptRequestId: string | null = null;
  let interruptRunning = false;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    query = (form.get('query') as string) || '';
    sessionId = normalizeSessionId(form.get('session_id'));
    contextEntityType = (form.get('context_entity_type') as string) || null;
    contextEntityId = (form.get('context_entity_id') as string) || null;
    deepDive = (form.get('deep_dive') as string) === 'true';
    clientRequestId = normalizeRequestId(form.get('client_request_id'));
    interruptRequestId = normalizeRequestId(form.get('interrupt_request_id'));
    interruptRunning = (form.get('interrupt_running') as string) === 'true' || Boolean(interruptRequestId);
    // Legacy single-file path — kept until the multi-upload flow is verified
    // end-to-end. New clients should pre-upload via /api/agent/upload-file and
    // pass `upload_ids` instead.
    const file = form.get('file') as File | null;
    if (file && file.size > 0) {
      // Wave 5 Phase A: legacy single-file path — extraction now throws
      // on parser failure. Catch and proceed with empty text rather than
      // crashing the agent turn.
      try {
        uploadedText = await extractTextFromFile(file);
      } catch (e: any) {
        console.error(`[agent] legacy upload extract failed: ${e?.message || e}`);
        uploadedText = '';
      }
    }
    const rawIds = form.get('upload_ids');
    if (typeof rawIds === 'string' && rawIds.trim()) {
      try { uploadIds = JSON.parse(rawIds); } catch { /* ignore */ }
    }
  } else {
    const body = await parseJsonBody<any>(request);
    if (!body?.query) return errorResponse('VALIDATION_ERROR', 400);
    query = body.query;
    sessionId = normalizeSessionId(body.session_id);
    contextEntityType = body.context_entity_type || null;
    contextEntityId = body.context_entity_id || null;
    deepDive = !!body.deep_dive;
    clientRequestId = normalizeRequestId(body.client_request_id);
    interruptRequestId = normalizeRequestId(body.interrupt_request_id);
    interruptRunning = !!body.interrupt_running || Boolean(interruptRequestId);
    if (Array.isArray(body.upload_ids)) {
      uploadIds = body.upload_ids.filter((x: unknown): x is string => typeof x === 'string');
    }
  }

  if (!query) return errorResponse('VALIDATION_ERROR', 400);
  const runtimeFingerprint = buildLiveMartyRuntimeFingerprint(env, { deepDive });

  // --- Load or create session ---
  let session: AgentSession;
  if (sessionId) {
    await markStaleRunningAgentTurns(ctx, env, sessionId);
    const existing = await loadAccessibleAgentSession(sessionId, ctx, env);
    if (existing) {
      session = existing;
    } else {
      console.warn(`[agent] client supplied missing/stale session ${sessionId}; creating a replacement`);
      session = await createAgentSessionRecord(ctx, env, contextEntityType, contextEntityId);
    }
  } else {
    session = await createAgentSessionRecord(ctx, env, contextEntityType, contextEntityId);
  }
  session.user_role = ctx.userRole;

  // --- Tag any newly-referenced uploads to this session ---
  // Uploads created against `null` session (when the chat input had no session
  // yet) need to inherit the session_id at first reference. Owner check is
  // built into the WHERE clause so a forged upload_id from another user is a
  // no-op.
  if (uploadIds.length > 0) {
    const placeholders = uploadIds.map(() => '?').join(',');
    await env.D1.prepare(
      `UPDATE chat_uploads SET session_id = ?
       WHERE id IN (${placeholders}) AND user_id = ? AND (session_id IS NULL OR session_id = ?)`
    ).bind(session.id, ...uploadIds, ctx.userId, session.id).run().catch(() => {});
  }

  // --- MAX mode rate limiting (check only — increment moved post-retrieval) ---
  const retrievalOptions: RetrievalOptions = { deepDive };
  const ddKey = deepDive
    ? `deep_dive:${ctx.userId}:${new Date().toISOString().slice(0, 13)}`
    : null;
  if (deepDive && ddKey) {
    const ddCount = parseInt(await env.KV.get(ddKey) || '0');
    if (ddCount >= 10) {
      return jsonResponse({
        error: 'MAX mode limit reached',
        message: "You've hit your hourly MAX mode limit. Try again in a few minutes — Agile queries still work.",
        retryable: false,
      }, 429);
    }
  }
  const maxSetIntent = deepDive ? detectMaxSetIntent(query, { currentUserEmail: ctx.email }) : { shouldBuild: false, reason: null, input: null };
  const maxClassification = deepDive
    ? classifyMaxRequest(query, maxSetIntent)
    : { task_shape: 'mixed' as const, should_run_durably: false, reason: 'not_max_mode' };

  const runningTurn = await getRunningAssistantTurn(session.id, env);
  if (runningTurn) {
    const interruptMatches = interruptRunning
      && (!interruptRequestId || runningTurn.request_id === interruptRequestId);
      if (interruptMatches) {
        if (runningTurn.request_id) {
          await cancelRequest(runningTurn.request_id, env).catch(() => ({ local: false }));
        }
        await markAgentRunCancelRequested(env, ctx, {
          requestId: runningTurn.request_id,
          sessionId: session.id,
        }).catch(() => 0);
        await cancelMaxModeJobs(env, ctx, {
          requestId: runningTurn.request_id,
          sessionId: session.id,
        }, 'Stopped because the user sent a new prompt.').catch(() => 0);
        await markAgentTurnCancelled(env, ctx, {
          assistantMessageId: runningTurn.id,
          sessionId: session.id,
        reason: 'Stopped because the user sent a new prompt.',
        kind: 'interrupt',
      }).catch(() => 0);
      await repairAgentSessionTurnCount(session.id, env);
    } else {
      return jsonResponse({
        error: 'AGENT_TURN_RUNNING',
        message: 'MARTy is already working on this session. Send again to interrupt the current response, or press Stop first.',
        retryable: false,
        session_id: session.id,
        request_id: runningTurn.request_id,
        assistant_message_id: runningTurn.id,
      }, 409);
    }
  }

  let turnIndex = await getNextAgentTurnIndex(session.id, env);

  // ---- Wave-1 cancellation: per-request AbortController ----
  // Create this before retrieval so the durable placeholder can expose a
  // cancellation handle even if the user navigates away before streaming starts.
  const requestId = clientRequestId || crypto.randomUUID();
  const agentRunId = crypto.randomUUID();
  const cancelController = registerActiveRequest(requestId);

  // --- Per-session attachment replay (Approach A + 50 MB cap) ---
  const sessionAttachments = await assembleSessionAttachments(session.id, ctx.userId, env);
  // Filter the summaries down to only the uploads referenced by this turn —
  // those are what we render under the user message bubble. Aged-out and
  // older session attachments still ride along in `sessionAttachments` for
  // the model's benefit, but the message bubble shouldn't be cluttered with
  // them.
  const turnAttachments: UploadSummary[] = uploadIds.length > 0
    ? sessionAttachments.summaries.filter(s => uploadIds.includes(s.id))
    : [];
  const attachmentsJson = turnAttachments.length > 0 ? JSON.stringify(turnAttachments) : '[]';

  // Save the user turn before expensive retrieval/model work and reserve the
    // next two turn indexes immediately. Without this, a disconnected MAX run
  // can leave turn_count stale and later retries will duplicate turn indexes.
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  try {
    await reserveAgentTurn(
      env,
      session.id,
      userMessageId,
      assistantMessageId,
      turnIndex,
      query,
      attachmentsJson,
      JSON.stringify({ status: 'running', request_id: requestId, run_id: agentRunId, runtime_fingerprint: runtimeFingerprint, deep_dive: deepDive })
    );
  } catch (e) {
    if (isAgentRunningReservationConflict(e)) {
      const activeTurn = await getRunningAssistantTurn(session.id, env);
      const interruptMatches = interruptRunning
        && activeTurn
        && (!interruptRequestId || activeTurn.request_id === interruptRequestId);
      if (interruptMatches) {
        if (activeTurn.request_id) {
          await cancelRequest(activeTurn.request_id, env).catch(() => ({ local: false }));
        }
        await markAgentRunCancelRequested(env, ctx, {
          requestId: activeTurn.request_id,
          sessionId: session.id,
        }).catch(() => 0);
        await cancelMaxModeJobs(env, ctx, {
          requestId: activeTurn.request_id,
          sessionId: session.id,
        }, 'Stopped because the user sent a new prompt.').catch(() => 0);
        await markAgentTurnCancelled(env, ctx, {
          assistantMessageId: activeTurn.id,
          sessionId: session.id,
          reason: 'Stopped because the user sent a new prompt.',
          kind: 'interrupt',
        }).catch(() => 0);
        await repairAgentSessionTurnCount(session.id, env);
        turnIndex = await getNextAgentTurnIndex(session.id, env);
        try {
          await reserveAgentTurn(
            env,
            session.id,
            userMessageId,
            assistantMessageId,
            turnIndex,
            query,
            attachmentsJson,
            JSON.stringify({ status: 'running', request_id: requestId, run_id: agentRunId, runtime_fingerprint: runtimeFingerprint, deep_dive: deepDive })
          );
        } catch (retryError) {
          unregisterRequest(requestId);
          if (isAgentRunningReservationConflict(retryError)) {
            const stillActive = await getRunningAssistantTurn(session.id, env);
            return jsonResponse({
              error: 'AGENT_TURN_RUNNING',
              message: 'MARTy is still stopping the previous response. Try again in a moment.',
              retryable: true,
              session_id: session.id,
              request_id: stillActive?.request_id || null,
              assistant_message_id: stillActive?.id || null,
            }, 409);
          }
          throw retryError;
        }
      } else {
        unregisterRequest(requestId);
        return jsonResponse({
          error: 'AGENT_TURN_RUNNING',
          message: 'MARTy is already working on this session. Send again to interrupt the current response, or press Stop first.',
          retryable: false,
          session_id: session.id,
          request_id: activeTurn?.request_id || null,
          assistant_message_id: activeTurn?.id || null,
        }, 409);
      }
    } else {
      unregisterRequest(requestId);
      throw e;
    }
  }

  await createAgentRun(env, ctx, {
    id: agentRunId,
    sessionId: session.id,
    assistantMessageId,
    requestId,
    mode: deepDive ? 'max' : 'agile',
    status: 'running',
  }).catch(error => {
    console.warn('[agent:runs] create failed:', error?.message || error);
  });
  await persistRunEventSafe(env, agentRunId, ctx, session.id, 'run', {
    type: 'run',
    run_id: agentRunId,
    request_id: requestId,
    session_id: session.id,
    mode: deepDive ? 'max' : 'agile',
  });
  let durableToolCalls: DurableToolCall[] = [];
  const recordToolEvent = async (event: any) => {
    if (event?.type !== 'tool_call' && event?.type !== 'tool_result') return;
    durableToolCalls = upsertDurableToolEvent(durableToolCalls, event);
    await persistAssistantToolCallsMetadata(env, assistantMessageId, session.id, durableToolCalls);
  };

  if (deepDive && maxClassification.should_run_durably) {
    const plan = buildMaxExecutionPlan(query, maxClassification.task_shape, maxSetIntent);
    const maxJobId = await createQueuedMaxModeJob(env, ctx, {
      sessionId: session.id,
      assistantMessageId,
      requestId,
      agentRunId,
      query,
      plan,
      maxSetInput: maxSetIntent.input,
    });
    const enqueueResult = await enqueueMaxModeJob(env, ctx, {
      job_id: maxJobId,
      org_id: ctx.orgId,
      user_id: ctx.userId,
      session_id: session.id,
      assistant_message_id: assistantMessageId,
      request_id: requestId,
      agent_run_id: agentRunId,
      query,
      plan,
      max_set_input: maxSetIntent.input,
      runtime_fingerprint: runtimeFingerprint,
    });
    if (ddKey) {
      const ddCount = parseInt(await env.KV.get(ddKey) || '0');
      await env.KV.put(ddKey, String(ddCount + 1), { expirationTtl: 7200 }).catch(() => {});
    }
    await persistRunEventSafe(env, agentRunId, ctx, session.id, 'planned', {
      type: 'max_step',
      durable: true,
      job_id: maxJobId,
      run_id: agentRunId,
      request_id: requestId,
      session_id: session.id,
      task_shape: plan.task_shape,
      step: 'planned',
      status: 'queued',
      source_families: plan.source_families,
      work_queue_id: enqueueResult.workQueueId || null,
      reason: maxClassification.reason,
    });
    await persistDurableMaxAccepted(
      env,
      session,
      assistantMessageId,
      requestId,
      agentRunId,
      runtimeFingerprint,
      plan,
      maxJobId,
      enqueueResult.workQueueId || null
    );
    unregisterRequest(requestId);
    return createDurableMaxAcceptedResponse({
      env,
      session,
      requestId,
      runId: agentRunId,
      jobId: maxJobId,
      plan,
      runtimeFingerprint,
      turnAttachments,
      sessionAttachments,
    });
  }

  // --- Pre-process query & retrieve RAG context ---
  const t0 = Date.now();
  let pq: Awaited<ReturnType<typeof preprocessQuery>>;
  let internal: any[];
  let news: any[];
  let stats: { emails: number; meetings: number; documents: number; contacts: number; companies: number } | undefined;
  try {
    pq = await preprocessQuery(query, session, env, retrievalOptions);
    if (session.context_entity_id && !pq.entityIds.includes(session.context_entity_id)) {
      pq.entityIds.push(session.context_entity_id);
    }
    const result = await retrieveContext(pq, env, retrievalOptions);
    internal = result.internal;
    news = result.news;
    stats = result.stats;
  } catch (e: any) {
    const errMsg = String(e?.message || e);
    console.error('[agent] retrieval failed:', errMsg);
    await updateAgentRunStatus(env, agentRunId, 'error', {
      errorCode: 'RETRIEVAL_FAILED',
      errorJson: { phase: 'retrieval', message: errMsg },
    }).catch(() => {});

    await env.D1.prepare(
      `UPDATE agent_messages SET content = ?, metadata = ? WHERE id = ?`
    ).bind(
      'I ran into a problem retrieving context for that question. Try again, or rephrase.',
      JSON.stringify({ status: 'error', retrieval_failed: true, request_id: requestId, deep_dive: deepDive, error: errMsg, runtime_fingerprint: runtimeFingerprint }),
      assistantMessageId
    ).run().catch(() => {});
    await touchAgentSessionActivity(env, session.id);
    unregisterRequest(requestId);

    // Defense-in-depth refund: even though we moved the increment to post-retrieval,
    // any future code path that increments earlier still gets refunded here.
    if (ddKey) {
      const current = parseInt(await env.KV.get(ddKey) || '0');
      if (current > 0) {
        await env.KV.put(ddKey, String(current - 1), { expirationTtl: 7200 }).catch(() => {});
      }
    }

    return jsonResponse({
      error: 'Retrieval failed',
      message: 'I ran into a problem retrieving context for that question. Try again, or rephrase.',
      retryable: true,
    }, 500);
  }
  const tRetrieve = Date.now() - t0;

  if (cancelController.signal.aborted || await wasCancelledIncludingKV(requestId, env)) {
    await markAgentTurnCancelled(env, ctx, {
      assistantMessageId,
      sessionId: session.id,
      reason: 'Stopped by user.',
      kind: 'user_stop',
    }).catch(() => 0);
    await updateAgentRunStatus(env, agentRunId, 'cancelled').catch(() => {});
    unregisterRequest(requestId);
    const cancelledStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeSseEvent({ type: 'session', session_id: session.id }));
        controller.enqueue(encodeSseEvent({ type: 'request', request_id: requestId }));
        controller.enqueue(encodeSseEvent({ type: 'run', run_id: agentRunId, request_id: requestId, session_id: session.id }));
        controller.enqueue(encodeSseEvent({ text: '_(stopped)_' }));
        controller.enqueue(encodeSseDone());
        controller.close();
      },
    });
    return new Response(cancelledStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // --- Increment MAX mode quota only after retrieval succeeded ---
  if (ddKey) {
    const ddCount = parseInt(await env.KV.get(ddKey) || '0');
    await env.KV.put(ddKey, String(ddCount + 1), { expirationTtl: 7200 }).catch(() => {});
  }

  // --- Load session history ---
  // Fetch recent turns. We guarantee the last 3 complete exchanges (6 messages)
  // are always included so MARTy can resolve pronouns and references, then
  // fill remaining token budget with older context.
  const MIN_RECENT_MESSAGES = 6;
  const historyMsgs = await env.D1.prepare(
    'SELECT role, content, turn_index FROM agent_messages WHERE session_id = ? AND turn_index < ? ORDER BY turn_index DESC LIMIT 20'
  ).bind(session.id, turnIndex).all<{ role: string; content: string; turn_index: number }>();

  const allHistory = historyMsgs.results.reverse();
  const recentCount = Math.min(MIN_RECENT_MESSAGES, allHistory.length);
  const olderMessages = allHistory.slice(0, allHistory.length - recentCount);
  const recentMessages = allHistory.slice(allHistory.length - recentCount);

  let recentTokens = 0;
  for (const m of recentMessages) recentTokens += estimateTokens(m.content);

  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  let historyTokens = 0;
  const olderBudget = TOKEN_BUDGET.session_history - recentTokens;
  for (const m of olderMessages) {
    const t = estimateTokens(m.content);
    if (historyTokens + t > olderBudget) break;
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
    historyTokens += t;
  }
  for (const m of recentMessages) {
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }

  // --- Assemble context with numbered sources ---
  // Pass `query` so buildSourcesAndContext can emit Chunk 2 sentinels:
  // empty-sources notice when retrieval is dry, and source-type-mismatch
  // banner when user asked about (e.g.) Slack but only emails came back.
  const { sources, contextBlock } = await buildSourcesAndContext(
    internal,
    news,
    uploadedText,
    ctx.orgId,
    env,
    query,
    { deepDive, viewer: ctx }
  );
  const sourceRegistry = new TurnSourceRegistry(sources);
  const routedSourceResults: Array<{ tool: string; reason: string; result: any }> = [];
  const preludeEvents: any[] = [];
  const sourceRoutingPlan = planDeterministicSourceRouting(query, { deepDive });
  if (sourceRoutingPlan.calls.length > 0) {
    for (const routedCall of sourceRoutingPlan.calls) {
      if (cancelController.signal.aborted || await wasCancelledIncludingKV(requestId, env)) break;
      preludeEvents.push({
        type: 'tool_call',
        tool: routedCall.tool,
        input: routedCall.input,
        status: 'executing',
        routed: true,
        reason: routedCall.reason,
      });
      await persistRunEventSafe(env, agentRunId, ctx, session.id, 'routed_tool_call', {
        type: 'routed_tool_call',
        tool: routedCall.tool,
        input: routedCall.input,
        reason: routedCall.reason,
      });
      try {
        const rawResult = await executeTool(routedCall.tool, routedCall.input, ctx, env, {
          deepDive,
          signal: cancelController.signal,
          jobId: agentRunId,
          sessionId: session.id,
          requestId,
          assistantMessageId,
        });
        const transformed = sourceRegistry.appendToolResult(routedCall.tool, rawResult);
        if (transformed.delta.length > 0) {
          preludeEvents.push({ type: 'sources_delta', sources: transformed.delta, routed: true });
          await persistRunEventSafe(env, agentRunId, ctx, session.id, 'sources_delta', {
            type: 'sources_delta',
            sources: transformed.delta,
            routed: true,
          });
        }
        const compact = compactRoutedToolResult(routedCall.tool, transformed.result);
        routedSourceResults.push({ tool: routedCall.tool, reason: routedCall.reason, result: compact });
        preludeEvents.push({
          type: 'tool_result',
          tool: routedCall.tool,
          result: compact,
          status: 'done',
          routed: true,
        });
      } catch (error: any) {
        const compactError = {
          error: 'ROUTED_RETRIEVAL_FAILED',
          message: 'A deterministic source-specific lookup failed before returning a safe result.',
          retryable: true,
        };
        routedSourceResults.push({ tool: routedCall.tool, reason: routedCall.reason, result: compactError });
        preludeEvents.push({
          type: 'tool_result',
          tool: routedCall.tool,
          result: compactError,
          status: 'error',
          routed: true,
        });
        await persistRunEventSafe(env, agentRunId, ctx, session.id, 'routed_tool_error', {
          type: 'routed_tool_error',
          tool: routedCall.tool,
          reason: routedCall.reason,
          message: String(error?.message || error),
        });
      }
    }
  }

  let forcedMaxSetResult: any = null;
  let compactForcedMaxSet: Record<string, unknown> | null = null;
  if (maxSetIntent.shouldBuild && maxSetIntent.input) {
    preludeEvents.push({
      type: 'tool_call',
      tool: 'build_max_set',
      input: maxSetIntent.input,
      status: 'executing',
      forced: true,
    });
    try {
      forcedMaxSetResult = await withTimeout(
        buildMaxSetTool(ctx, maxSetIntent.input, env, { deepDive: true, signal: cancelController.signal, jobId: agentRunId }),
        FORCED_MAX_SET_TIMEOUT_MS,
        `Forced MAX set-builder exceeded ${Math.round(FORCED_MAX_SET_TIMEOUT_MS / 1000)}s before returning.`
      );
      compactForcedMaxSet = compactMaxSetResultForContext(forcedMaxSetResult);
      if (Array.isArray(forcedMaxSetResult?.document_cards) && forcedMaxSetResult.document_cards.length > 0) {
        preludeEvents.push({ type: 'document_cards', document_cards: forcedMaxSetResult.document_cards });
      }
      preludeEvents.push({
        type: 'tool_result',
        tool: 'build_max_set',
        result: compactForcedMaxSet,
        status: 'done',
        forced: true,
      });
    } catch (error: any) {
      compactForcedMaxSet = {
        error: String(error?.message || error),
        instruction: 'The forced MAX set-builder failed. Do not fabricate a complete roster from recall snippets; report the failure and the available retrieval coverage.',
      };
      preludeEvents.push({
        type: 'tool_result',
        tool: 'build_max_set',
        result: compactForcedMaxSet,
        status: 'error',
        forced: true,
      });
    }
  }

  const maxSetContext = compactForcedMaxSet
    ? `\n\n--- FORCED MAX SET BUILDER RESULT ---\n${JSON.stringify(compactForcedMaxSet, null, 2)}\n--- END FORCED MAX SET BUILDER RESULT ---`
    : '';
  const routedSourceContext = routedSourceResults.length > 0
    ? `\n\n--- DETERMINISTIC SOURCE ROUTING (${sourceRoutingPlan.intent}) ---\n${JSON.stringify(routedSourceResults, null, 2)}\n--- END DETERMINISTIC SOURCE ROUTING ---`
    : '';

  const userText = `${contextBlock}${routedSourceContext}${maxSetContext}\n\n--- QUERY ---\n${query}`;
  if (sessionAttachments.contentBlocks.length > 0) {
    // Multi-block content: PDFs/images/text-extracted attachments first, then
    // the RAG context + the user's actual query as the final text block.
    messages.push({
      role: 'user',
      content: [
        ...sessionAttachments.contentBlocks,
        { type: 'text', text: userText },
      ],
    });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  // --- Stream Claude response with tool use ---
  let systemPrompt = buildMartyBaseSystemPrompt(ctx, new Date());
  if (deepDive) systemPrompt += buildMartyMaxModePrompt(stats);
  if (compactForcedMaxSet) {
    systemPrompt += `\n\nA deterministic MAX set-builder run has already been executed for this turn and is included under "FORCED MAX SET BUILDER RESULT". Treat it as the source of truth for roster/list/set contents and coverage. Do not create a second spreadsheet from recall snippets. If safety_status is unsafe_incomplete, explicitly say the export is not safe, do not imply the set is complete, and explain the quality_gate reasons plus the fastest path to a clean run. If the forced run has an artifact_card, tell the user the workbook is ready and summarize counts, coverage, and real gaps from that run.`;
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await callClaudeStreaming(
      {
        system: systemPrompt,
        messages,
        model: deepDive ? resolveMartyMaxModel(env) : resolveMartyNormalModel(env),
        orgId: ctx.orgId,
        priority: 'high',
        max_tokens: deepDive ? MAX_MODE_LIMITS.outputTokens : NORMAL_MODE_LIMITS.outputTokens,
        fallbackMaxTokens: deepDive ? MAX_MODE_LIMITS.fallbackOutputTokens : undefined,
        maxIterations: deepDive ? MAX_MODE_LIMITS.toolIterations : NORMAL_MODE_LIMITS.toolIterations,
        tools: AGENT_TOOLS,
        preludeEvents,
        onToolCall: (name, input) => {
          if (forcedMaxSetResult && name === 'build_max_set') return Promise.resolve(forcedMaxSetResult);
          if (forcedMaxSetResult && name === 'create_document_artifact' && !input?.custom_fields?.max_mode_set_builder) {
            return Promise.resolve({
              ok: false,
              error: 'MAX_SET_ARTIFACT_ALREADY_CREATED',
              message: 'A deterministic build_max_set workbook already exists for this exhaustive MAX query. Use that artifact instead of creating a model-authored duplicate from recall snippets.',
              document_cards: forcedMaxSetResult.document_cards || [],
              max_set_run_id: forcedMaxSetResult.run_id,
            });
          }
          return executeTool(name, input, ctx, env, {
            deepDive,
            signal: cancelController.signal,
            jobId: agentRunId,
            sessionId: session.id,
            requestId,
            assistantMessageId,
          });
        },
        onToolResult: async (name, rawResult) => {
          const transformed = sourceRegistry.appendToolResult(name, rawResult);
          if (transformed.delta.length > 0) {
            await persistRunEventSafe(env, agentRunId, ctx, session.id, 'sources_delta', {
              type: 'sources_delta',
              sources: transformed.delta,
              tool: name,
            });
            return {
              result: transformed.result,
              events: [{ type: 'sources_delta', sources: transformed.delta }],
            };
          }
          return { result: transformed.result };
        },
        signal: cancelController.signal,
      },
      env
    );
  } catch (e: any) {
    unregisterRequest(requestId);
    await updateAgentRunStatus(env, agentRunId, 'error', {
      errorCode: 'GENERATION_START_FAILED',
      errorJson: { phase: 'generation_start', message: String(e?.message || e) },
    }).catch(() => {});
    await env.D1.prepare(
      `UPDATE agent_messages SET content = ?, metadata = ? WHERE id = ?`
    ).bind(
      safeModelErrorText(),
      JSON.stringify({
        status: 'error',
        request_id: requestId,
        run_id: agentRunId,
        runtime_fingerprint: runtimeFingerprint,
        deep_dive: deepDive,
        error_code: 'GENERATION_START_FAILED',
      }),
      assistantMessageId
    ).run().catch(() => {});
    await touchAgentSessionActivity(env, session.id);
    return jsonResponse({
      error: 'Generation failed',
      message: safeModelErrorText(),
      retryable: true,
    }, 500);
  }

  // Tee stream to capture full response
  const [rawClientStream, captureStream] = stream.tee();

  // Prepend a session event + the numbered source list so the frontend can
  // render citation pills as soon as Claude starts streaming text.
  const encoder = new TextEncoder();
  const sessionEvent = encoder.encode(
    `data: ${JSON.stringify({ type: 'session', session_id: session.id })}\n\n`
  );
  // Cancellation key — client posts this back to /api/agent/cancel.
  const requestEvent = encoder.encode(
    `data: ${JSON.stringify({ type: 'request', request_id: requestId })}\n\n`
  );
  const runtimeEvent = encoder.encode(
    `data: ${JSON.stringify({ type: 'runtime', runtime_fingerprint: runtimeFingerprint })}\n\n`
  );
  const sourcesEvent = encoder.encode(
    `data: ${JSON.stringify({ type: 'sources', sources: sourceRegistry.all() })}\n\n`
  );
  const attachmentsEvent = encoder.encode(
    `data: ${JSON.stringify({
      type: 'attachments',
      turn_attachments: turnAttachments,
      session_attachments: sessionAttachments.summaries,
      bytes_used: sessionAttachments.bytesUsed,
      bytes_total: sessionAttachments.bytesTotal,
    })}\n\n`
  );
  const clientStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sessionEvent);
      controller.enqueue(requestEvent);
      controller.enqueue(runtimeEvent);
      controller.enqueue(sourcesEvent);
      controller.enqueue(attachmentsEvent);
      const reader = rawClientStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch { /* stream closed by client */ }
      finally { controller.close(); }
    },
  });

  ctxExec.waitUntil(
    (async () => {
      const reader = captureStream.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      const surfacedDocumentCards: MartyDocumentCard[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          const lines = text.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') continue;
            try {
              const evt = JSON.parse(jsonStr);
              if (evt.text) fullText += evt.text;
              if (evt.type === 'document_cards') {
                surfacedDocumentCards.push(...normalizeDocumentCards(evt.document_cards));
              } else if (evt.type === 'tool_result' && evt.result?.document_cards) {
                surfacedDocumentCards.push(...normalizeDocumentCards(evt.result.document_cards));
              }
              if (evt.type === 'tool_call' || evt.type === 'tool_result') {
                await recordToolEvent(evt);
              }
            } catch { /* skip */ }
          }
        }
      } catch (streamErr) {
        console.error('[Agent] stream capture error:', streamErr);
      }

      // Save assistant turn (full or partial), with the numbered source list
      // so reloading the session keeps inline pills working. If the request
      // was cancelled mid-stream, mark it in metadata so the UI can render
      // a "Cancelled" badge on reload.
      //
      // Wave-fix Chunk 2 (4-II): strip invalid [^N] markers before persist.
      // Audit 2026-05-05 caught the model emitting [^11] and [^12] when only
      // 10 sources existed. The streaming client already saw those markers
      // for a few hundred ms, but the persisted record (used on session
      // reload, in audit logs, in screenshots) gets a clean version with
      // the invalid markers replaced by an empty string. Count is recorded
      // in metadata for UI badging + the existing marty_citation_metrics
      // telemetry table.
      //
      // Audit 2026-05-16 extended this to the other recurring model drift:
      // labeled markers such as [^16 Slack]. Those are valid source intents
      // but invalid UI grammar, so canonicalize them to [^16] before storage.
      const cancelled = await wasCancelledIncludingKV(requestId, env);
      const documentCards = normalizeDocumentCards(surfacedDocumentCards);
      const rawContent = fullText || (
        cancelled
          ? '_(cancelled before MARTy started generating)_'
          : documentCards.length > 0
            ? 'I pulled the relevant document forward.'
            : ''
      );
      const finalSources = sourceRegistry.all();
      const normalizedOutput = normalizeMartyOutputText(
        rawContent,
        sourceRegistry.idSet()
      );

      const persistedContent = normalizedOutput.text || (
          cancelled
            ? '_(cancelled before MARTy started generating)_'
            : safeModelErrorText()
      );
      const sourcesJson = finalSources.length > 0 ? JSON.stringify(finalSources) : null;
      const metadataObj: Record<string, any> = {
        status: cancelled ? 'cancelled' : (fullText || documentCards.length > 0 ? 'done' : 'error'),
        request_id: requestId,
        run_id: agentRunId,
        runtime_fingerprint: runtimeFingerprint,
        deep_dive: deepDive,
      };
      if (cancelled) metadataObj.cancelled = true;
      if (!cancelled && !fullText && documentCards.length === 0) {
        metadataObj.error_code = 'NO_RESPONSE_RECEIVED';
      }
      if (normalizedOutput.invalidCitationsStripped > 0) {
        metadataObj.invalid_citations_stripped = normalizedOutput.invalidCitationsStripped;
      }
      if (normalizedOutput.labeledCitationsCanonicalized > 0) {
        metadataObj.labeled_citations_canonicalized = normalizedOutput.labeledCitationsCanonicalized;
      }
      if (documentCards.length > 0) {
        metadataObj.document_cards = documentCards;
      }
      const normalizedToolCalls = compactToolStateForStorage(durableToolCalls);
      if (normalizedToolCalls.length > 0) {
        metadataObj.tool_calls = normalizedToolCalls;
      }
      const metadataJson = JSON.stringify(metadataObj);
      await env.D1.prepare(
        `UPDATE agent_messages SET content = ?, sources_json = ?, metadata = ? WHERE id = ?`
      ).bind(persistedContent, sourcesJson, metadataJson, assistantMessageId).run();
      if (documentCards.length > 0) {
        await linkDocumentCardsToMessage(documentCards, assistantMessageId, ctx, env);
      }
      // Free the in-isolate controller entry (KV marker ages out on its own).
      unregisterRequest(requestId);
      await updateAgentRunStatus(
        env,
        agentRunId,
        cancelled ? 'cancelled' : (fullText || documentCards.length > 0 ? 'completed' : 'error'),
        !cancelled && !fullText && documentCards.length === 0
          ? { errorCode: 'NO_RESPONSE_RECEIVED', errorJson: { phase: 'stream_capture' } }
          : {}
      ).catch(() => {});

      // Citation telemetry — counts valid vs. invalid [^N] markers so we can
      // monitor citation hit rate and Claude hallucinating numbers.
      if (assistantMessageId && fullText) {
        try {
          await env.D1.prepare(
            `INSERT INTO marty_citation_metrics
               (id, org_id, user_id, session_id, message_id, sources_provided,
                citations_used, invalid_citations, response_length, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
          ).bind(
            crypto.randomUUID(), ctx.orgId, ctx.userId, session.id, assistantMessageId,
            finalSources.length,
            normalizedOutput.validCitationsUsed,
            normalizedOutput.invalidCitationsStripped,
            fullText.length
          ).run();
          if (normalizedOutput.invalidCitationsStripped > 0) {
            console.warn(`[citations] ${normalizedOutput.invalidCitationsStripped} invalid markers (sources=${finalSources.length}) in message ${assistantMessageId}`);
          }
        } catch (e) {
          console.error('[citations] metrics insert failed:', e);
        }
      }

      // Wave-fix Chunk 3 (5a) — sample claim-grounding verification.
      // Fires async via ctxExec.waitUntil so the user-facing response is
      // already complete by the time we call the judge model. 20% sample
      // rate inside verifySampleClaims; if not sampled, function returns
      // immediately. Operates on persistedContent (post-strip from Chunk 2)
      // so we never verify claims attached to invalid markers.
      if (assistantMessageId && persistedContent && finalSources.length > 0) {
        ctxExec.waitUntil(
          verifySampleClaims(assistantMessageId, ctx.orgId, persistedContent, finalSources, env)
        );
      }

      // Update session
      await touchAgentSessionActivity(env, session.id);

      // Auto-generate title on first turn
      if (turnIndex === 0 && !session.title) {
        try {
          const title = await callClaude(
            { system: SESSION_TITLE_PROMPT, user: query, max_tokens: 20, orgId: ctx.orgId, model: CLAUDE_HAIKU_MODEL },
            'low',
            env
          );
          await env.D1.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?')
            .bind(title.trim().slice(0, 80), session.id)
            .run();
        } catch { /* ignore */ }
      }

      // Persist RAG trace
      const traceKey = `${ctx.orgId}/rag_traces/${new Date().toISOString().slice(0, 7)}/${session.id}_${turnIndex}.txt`;
      try { await env.R2.put(traceKey, `${contextBlock}${routedSourceContext}${maxSetContext}`); } catch { /* ignore */ }

      // Log to rag_query_logs
      try {
        await env.D1.prepare(
          `INSERT INTO rag_query_logs
             (id, org_id, user_id, session_id, turn_index, original_query, processed_query,
              vectorize_internal_match_count, vectorize_news_match_count, post_filter_count,
              context_r2_key, latency_retrieval_ms, latency_total_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(
          crypto.randomUUID(), ctx.orgId, ctx.userId, session.id, turnIndex,
          query, JSON.stringify({ entity_ids: pq.entityIds }),
          internal.length, news.length, internal.length,
          traceKey, tRetrieve, Date.now() - t0
        ).run();
      } catch { /* ignore */ }
    })()
  );

  return new Response(clientStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
