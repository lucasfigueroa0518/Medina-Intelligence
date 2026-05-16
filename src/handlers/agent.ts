import type { Env } from '../types/env';
import type { AgentSession, AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { preprocessQuery, retrieveContext, TOKEN_BUDGET, type RetrievalOptions } from '../lib/retrieval';
import { buildSourcesAndContext, type CitationSource } from '../lib/citations';
import { normalizeCitationMarkers } from '../lib/citation-format';
import { verifySampleClaims } from '../lib/citation-verifier';
import { callClaude, callClaudeStreaming } from '../lib/claude';
import type { ToolDefinition } from '../lib/claude';
import { extractTextFromFile } from '../lib/file-extraction';
import { assembleSessionAttachments, type UploadSummary } from '../lib/chat-uploads';
import {
  createDocumentArtifactTool,
  editDocumentArtifactTool,
  findDocumentsTool,
  normalizeDocumentCards,
  type MartyDocumentCard,
} from '../lib/document-artifacts';
import { SESSION_TITLE_PROMPT } from '../prompts/session-title';
import { estimateTokens, truncateToTokens } from '../lib/tokens';
import { emitAudit } from '../lib/audit';
import {
  searchContacts, searchCompanies, searchDeals, searchConversations,
  searchEvents, recall, sweepConversations,
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
import { MAX_MODE_LIMITS, MAX_MODE_MODEL, NORMAL_MODE_LIMITS } from '../lib/max-mode';
import {
  buildLiveMartyRuntimeFingerprint,
  buildMartyBaseSystemPrompt,
  buildMartyMaxModePrompt,
} from '../lib/marty-runtime';
import { buildMaxSetTool, compactMaxSetResultForContext, detectMaxSetIntent } from '../lib/max-set-builder';

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
    description: 'Semantic search across the firm intelligence — emails, Slack messages, meeting transcripts, documents, contacts, companies. THIS IS YOUR PRIMARY TOOL for any question about CRM content. Always call this FIRST when the user asks about communications, meetings, history, what was discussed, who said what, or any specific person/company/deal context. Results are already access-filtered for the current authenticated user; never try broader searches to bypass missing private content. The pre-populated SOURCES list at the top of context is just the initial framing — call recall to dig deeper, retrieve a specific source type, or recover when SOURCES looks empty for an asked-for type. Treat each returned source date as authoritative: relative phrases in an excerpt ("next week", "currently", "now") are relative to that source date, not today. Examples: "what\'s been happening on Slack" → recall("recent slack activity", source_types=["slack"]). "summarize the NeuralSeek meeting" → recall("NeuralSeek meeting", source_types=["meeting"]). "find Patrick\'s pitch emails" → recall("Patrick Dyer pitch", source_types=["email"]).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query. Be specific.' },
        source_types: {
          type: 'array',
          items: { type: 'string', enum: ['email', 'slack', 'meeting', 'document'] },
          description: 'Filter to specific source types. Use this when the user asked about a specific channel (Slack, email, meetings, docs). Default: all types.',
        },
        limit: { type: 'number', description: 'Max results. Default 20; in Deep mode default 50. Max 50.' },
      },
      required: ['query'],
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
    description: 'Create a polished, fully usable editable document artifact and save it to Documents. Supports docx, xlsx, pptx, and pdf. Use when the user asks MARTy to prepare, draft, build, create, generate, or export a memo/model/deck/summary/file. Never create title-only or skeletal files.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'] },
        title: { type: 'string', description: 'Human-readable document title.' },
        structured_content: {
          type: 'object',
          description: 'Complete structured content. docx/pdf: subtitle, summary, metadata, sections with paragraphs, bullets, numbered lists, checklists, and tables. xlsx: multiple sheets with headers, rows, and formulas where natural. pptx: 6-10 Medina-dark executive slides; use layout/headline/takeaway, evidence_blocks, metrics, tables, and speaker_notes where useful. Older simple title/body/bullets slides are still accepted.',
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
        limit: { type: 'number', description: 'Max results. Default 20; in Deep mode default 100. Max 50 normally, 200 in Deep mode.' },
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
        limit: { type: 'number', description: 'Max results. Default 20; in Deep mode default 100. Max 50 normally, 200 in Deep mode.' },
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
        stage: { type: 'string', description: 'Filter by stage: prospect, initial_contact, due_diligence, term_sheet, negotiation, closed_won, closed_lost, on_hold' },
        company_id: { type: 'string' },
        limit: { type: 'number', description: 'Max results. Default 20; in Deep mode default 100. Max 50 normally, 200 in Deep mode.' },
      },
    },
  },
  {
    name: 'search_conversations',
    description: 'Search emails, Slack messages, and manual conversation rows stored in the conversations table. This does NOT search Firefly meeting transcripts or calendar events; use search_events for meetings, calendar windows, events, and transcript-backed recaps. In Deep mode, prefer sweep_conversations for exhaustive all/every/list/export/count communication jobs.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by subject, body preview, sender, To, or Cc' },
        source: { type: 'string', enum: ['outlook', 'slack', 'manual', 'all'], description: 'Filter by conversation channel. Default: all. Meeting transcripts are not conversations; use search_events.' },
        contact_id: { type: 'string', description: 'Filter conversations involving a specific contact' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'all'], description: 'Filter by direction. Default: all' },
        days_back: { type: 'number', description: 'How many days back to search. Default: 30, or 365 in Deep mode.' },
        limit: { type: 'number', description: 'Max results. Default 20; in Deep mode default 250. Max 50 normally, 1000 in Deep mode.' },
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
        limit: { type: 'number', description: 'Max events. Default 20; in Deep mode default 100. Max 50 normally, 200 in Deep mode.' },
      },
    },
  },
  {
    name: 'sweep_conversations',
    description: 'Deep-mode deterministic sweep over the conversations table for exhaustive all/every/list/export/count tasks. Use this instead of recall when the user needs a broad roster or aggregation across many touchpoints, such as invite lists, all Bank of America touchpoints, everyone who showed funding interest, or every startup mention in a sector. It can return hundreds of SQL-filtered rows and optionally deduplicate To/Cc recipients. Use a few high-signal terms like event name/company/sector, plus exact sender/date filters when known; do not pass the whole user request as the only search strategy if better filters are available.',
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
        body_fetch_limit: { type: 'number', description: 'Max full bodies to fetch when include_body is true. Default 80, max 200 in Deep mode.' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Optional recipient domains to exclude from rollup, e.g. medinavc.com.' },
        limit: { type: 'number', description: 'Rows to return. Default 300 in Deep mode, max 1000.' },
        offset: { type: 'number', description: 'Pagination offset. If has_more is true, call again with the next offset before finalizing exhaustive answers.' },
      },
    },
  },
  {
    name: 'build_max_set',
    description: 'Deep-only exhaustive set builder for all/every/list/export/count/touchpoint/ever-involved questions. Prefer this over recall and lower-level sweeps whenever the user needs a complete roster or broad aggregation across communications, events, campaigns, CRM entities, documents, and tasks. It deduplicates candidates, assigns confirmed/probable/needs_review/excluded buckets, reports coverage/gaps, and auto-creates an XLSX for large or export/mail-merge outputs.',
    input_schema: {
      type: 'object',
      properties: {
        task_type: {
          type: 'string',
          enum: ['invite_roster', 'touchpoint_roster', 'entity_theme_set', 'funding_interest_gap', 'firm_involvement', 'open_loops', 'account_map', 'campaign_response_set', 'document_list_reconstruction', 'deal_process_history', 'generic_set'],
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
        stage: { type: 'string', description: 'prospect, initial_contact, due_diligence, term_sheet, negotiation, closed_won, closed_lost, on_hold' },
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
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal'] },
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
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal'] },
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
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal'] },
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
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal'] },
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
  toolContext: { deepDive?: boolean } = {}
): Promise<any> {
  switch (toolName) {
    case 'search_contacts': return searchContacts(ctx, toolInput, env, toolContext);
    case 'search_companies': return searchCompanies(ctx, toolInput, env, toolContext);
    case 'search_deals': return searchDeals(ctx, toolInput, env, toolContext);
    case 'search_conversations': return searchConversations(ctx, toolInput, env, toolContext);
    case 'search_events': return searchEvents(ctx, toolInput, env, toolContext);
    case 'sweep_conversations': return sweepConversations(ctx, toolInput, env, toolContext);
    case 'build_max_set': return buildMaxSetTool(ctx, toolInput, env, toolContext);
    case 'find_documents': return findDocumentsTool(ctx, toolInput, env);
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

async function createAgentSessionRecord(
  ctx: AuthContext,
  env: Env,
  contextEntityType: string | null = null,
  contextEntityId: string | null = null
): Promise<AgentSession> {
  const id = crypto.randomUUID();
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
       AND ${accessPredicate}
       ${sessionFilter}`
  ).bind(...bindValues).run().catch(() => {});

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

function titleFromQuery(query: string): string {
  const cleaned = query
    .replace(/\s+/g, ' ')
    .replace(/^(please|can you|could you|i need you to|i need to)\s+/i, '')
    .trim();
  if (!cleaned) return 'MARTy Deep Request';
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
      `Deep set-builder failed before it could complete: ${result.error}`,
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
    `Deep set-builder finished in ${Math.round(elapsedMs / 1000)}s.`,
    '',
    `Status: **${safety}**`,
    `Counts: **${confirmed} confirmed**, **${probable} probable**, **${needsReview} needs review**, **${excluded} excluded**.`,
  ];

  if (artifact) {
    lines.push('', `Workbook: **${artifact.title || 'Deep export'}** is ready in the card above.`);
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
  error?: string
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

function createStreamingMaxSetResponse(args: {
  ctx: AuthContext;
  env: Env;
  session: AgentSession;
  query: string;
  input: any;
  requestId: string;
  assistantMessageId: string;
  runtimeFingerprint: any;
  turnAttachments: UploadSummary[];
  sessionAttachments: Awaited<ReturnType<typeof assembleSessionAttachments>>;
  turnIndex: number;
}): Response {
  const {
    ctx,
    env,
    session,
    query,
    input,
    requestId,
    assistantMessageId,
    runtimeFingerprint,
    turnAttachments,
    sessionAttachments,
    turnIndex,
  } = args;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: any) => controller.enqueue(encodeSseEvent(data));
      const started = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      try {
        emit({ type: 'session', session_id: session.id });
        emit({ type: 'request', request_id: requestId });
        emit({ type: 'runtime', runtime_fingerprint: runtimeFingerprint });
        emit({ type: 'sources', sources: [] });
        emit({
          type: 'attachments',
          turn_attachments: turnAttachments,
          session_attachments: sessionAttachments.summaries,
          bytes_used: sessionAttachments.bytesUsed,
          bytes_total: sessionAttachments.bytesTotal,
        });
        emit({ type: 'tool_call', tool: 'build_max_set', input, status: 'executing', forced: true });

        heartbeat = setInterval(() => {
          try {
            emit({
              type: 'tool_call',
              tool: 'build_max_set',
              status: 'executing',
              forced: true,
              heartbeat: true,
              elapsed_ms: Date.now() - started,
            });
          } catch {
            // The client may have disconnected; the main path will handle it.
          }
        }, 15_000);

        const result = await withTimeout(
          buildMaxSetTool(ctx, input, env, { deepDive: true }),
          STREAMING_MAX_SET_TIMEOUT_MS,
          `Deep set-builder exceeded ${Math.round(STREAMING_MAX_SET_TIMEOUT_MS / 1000)}s before returning.`
        );
        if (heartbeat) clearInterval(heartbeat);

        const compact = compactMaxSetResultForContext(result);
        const documentCards = normalizeDocumentCards(result?.document_cards || []);
        if (documentCards.length > 0) {
          emit({ type: 'document_cards', document_cards: documentCards });
        }
        emit({ type: 'tool_result', tool: 'build_max_set', result: compact, status: 'done', forced: true });

        const finalText = formatMaxSetAnswer(result, Date.now() - started);
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
          result?.error ? 'error' : 'done',
          documentCards,
          result?.error
        );

        if (turnIndex === 0 && !session.title) {
          await env.D1.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?')
            .bind(titleFromQuery(query), session.id)
            .run()
            .catch(() => {});
        }
      } catch (error: any) {
        if (heartbeat) clearInterval(heartbeat);
        const message = String(error?.message || error);
        const finalText = [
          `Deep mode failed before it could return the set-builder result: ${message}`,
          '',
          'I did not create an export because the run did not complete safely.',
        ].join('\n');
        emit({ type: 'tool_result', tool: 'build_max_set', result: { error: message }, status: 'error', forced: true });
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
          message
        ).catch(() => {});
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
  try {
    const body = await parseJsonBody<any>(request);
    contextEntityType = typeof body?.context_entity_type === 'string' ? body.context_entity_type : null;
    contextEntityId = typeof body?.context_entity_id === 'string' ? body.context_entity_id : null;
  } catch {
    // Empty bodies are allowed; this endpoint mostly exists so the client can
    // create a durable chat target before handing a turn to the stream.
  }

  const session = await createAgentSessionRecord(ctx, env, contextEntityType, contextEntityId);
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
  const hydratedMessages = messages.results.map(m => ({
    ...m,
    sources: m.sources_json ? safeParseJson<CitationSource[]>(m.sources_json) : null,
    attachments: m.attachments ? safeParseJson<UploadSummary[]>(m.attachments) : null,
  }));
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
  const body = await parseJsonBody<{ request_id?: string }>(request);
  if (!body?.request_id || typeof body.request_id !== 'string') {
    return errorResponse('VALIDATION_ERROR', 400, 'request_id required');
  }
  const result = await cancelRequest(body.request_id, env);
  // Audit the cancel for debugging — keeps a trace in case Lucas reports
  // "I clicked stop and nothing happened."
  console.log(`[agent:cancel] request=${body.request_id} user=${ctx.userId} local=${result.local}`);
  return jsonResponse({ ok: true, local: result.local });
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

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    query = (form.get('query') as string) || '';
    sessionId = normalizeSessionId(form.get('session_id'));
    contextEntityType = (form.get('context_entity_type') as string) || null;
    contextEntityId = (form.get('context_entity_id') as string) || null;
    deepDive = (form.get('deep_dive') as string) === 'true';
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

  // --- Deep mode rate limiting (check only — increment moved post-retrieval) ---
  const retrievalOptions: RetrievalOptions = { deepDive };
  const ddKey = deepDive
    ? `deep_dive:${ctx.userId}:${new Date().toISOString().slice(0, 13)}`
    : null;
  if (deepDive && ddKey) {
    const ddCount = parseInt(await env.KV.get(ddKey) || '0');
    if (ddCount >= 10) {
      return jsonResponse({
        error: 'Deep mode limit reached',
        message: "You've hit your hourly Deep mode limit. Try again in a few minutes — Agile queries still work.",
        retryable: false,
      }, 429);
    }
  }
  const maxSetIntent = deepDive ? detectMaxSetIntent(query, { currentUserEmail: ctx.email }) : { shouldBuild: false, reason: null, input: null };

  const runningTurn = await getRunningAssistantTurn(session.id, env);
  if (runningTurn) {
    return jsonResponse({
      error: 'AGENT_TURN_RUNNING',
      message: 'MARTy is already working on this session. I re-synced the conversation instead of starting a duplicate turn.',
      retryable: false,
      session_id: session.id,
      request_id: runningTurn.request_id,
      assistant_message_id: runningTurn.id,
    }, 409);
  }

  const turnIndex = await getNextAgentTurnIndex(session.id, env);

  // ---- Wave-1 cancellation: per-request AbortController ----
  // Create this before retrieval so the durable placeholder can expose a
  // cancellation handle even if the user navigates away before streaming starts.
  const requestId = crypto.randomUUID();
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
    // next two turn indexes immediately. Without this, a disconnected Deep run
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
      JSON.stringify({ status: 'running', request_id: requestId, runtime_fingerprint: runtimeFingerprint, deep_dive: deepDive })
    );
  } catch (e) {
    unregisterRequest(requestId);
    if (isAgentRunningReservationConflict(e)) {
      const activeTurn = await getRunningAssistantTurn(session.id, env);
      return jsonResponse({
        error: 'AGENT_TURN_RUNNING',
        message: 'MARTy is already working on this session. I re-synced the conversation instead of starting a duplicate turn.',
        retryable: false,
        session_id: session.id,
        request_id: activeTurn?.request_id || null,
        assistant_message_id: activeTurn?.id || null,
      }, 409);
    }
    throw e;
  }

  if (maxSetIntent.shouldBuild && maxSetIntent.input) {
    if (ddKey) {
      const ddCount = parseInt(await env.KV.get(ddKey) || '0');
      await env.KV.put(ddKey, String(ddCount + 1), { expirationTtl: 7200 }).catch(() => {});
    }
    return createStreamingMaxSetResponse({
      ctx,
      env,
      session,
      query,
      input: maxSetIntent.input,
      requestId,
      assistantMessageId,
      runtimeFingerprint,
      turnAttachments,
      sessionAttachments,
      turnIndex,
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

  // --- Increment Deep mode quota only after retrieval succeeded ---
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
    { deepDive }
  );

  let forcedMaxSetResult: any = null;
  let compactForcedMaxSet: Record<string, unknown> | null = null;
  const preludeEvents: any[] = [];
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
        buildMaxSetTool(ctx, maxSetIntent.input, env, { deepDive: true }),
        FORCED_MAX_SET_TIMEOUT_MS,
        `Forced Deep set-builder exceeded ${Math.round(FORCED_MAX_SET_TIMEOUT_MS / 1000)}s before returning.`
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
        instruction: 'The forced Deep set-builder failed. Do not fabricate a complete roster from recall snippets; report the failure and the available retrieval coverage.',
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
    ? `\n\n--- FORCED DEEP SET BUILDER RESULT ---\n${JSON.stringify(compactForcedMaxSet, null, 2)}\n--- END FORCED DEEP SET BUILDER RESULT ---`
    : '';

  const userText = `${contextBlock}${maxSetContext}\n\n--- QUERY ---\n${query}`;
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
    systemPrompt += `\n\nA deterministic Deep set-builder run has already been executed for this turn and is included under "FORCED DEEP SET BUILDER RESULT". Treat it as the source of truth for roster/list/set contents and coverage. Do not create a second spreadsheet from recall snippets. If safety_status is unsafe_incomplete, explicitly say the export is not safe, do not imply the set is complete, and explain the quality_gate reasons plus the fastest path to a clean run. If the forced run has an artifact_card, tell the user the workbook is ready and summarize counts, coverage, and real gaps from that run.`;
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await callClaudeStreaming(
      {
        system: systemPrompt,
        messages,
        model: deepDive ? (env.MARTY_MAX_MODEL || MAX_MODE_MODEL) : undefined,
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
              message: 'A deterministic build_max_set workbook already exists for this exhaustive Deep query. Use that artifact instead of creating a model-authored duplicate from recall snippets.',
              document_cards: forcedMaxSetResult.document_cards || [],
              max_set_run_id: forcedMaxSetResult.run_id,
            });
          }
          return executeTool(name, input, ctx, env, { deepDive });
        },
        signal: cancelController.signal,
      },
      env
    );
  } catch (e: any) {
    unregisterRequest(requestId);
    await env.D1.prepare(
      `UPDATE agent_messages SET content = ?, metadata = ? WHERE id = ?`
    ).bind(
      'I ran into a problem starting that MARTy response. Try again, or rephrase.',
      JSON.stringify({
        status: 'error',
        request_id: requestId,
        runtime_fingerprint: runtimeFingerprint,
        deep_dive: deepDive,
        error: String(e?.message || e),
      }),
      assistantMessageId
    ).run().catch(() => {});
    await touchAgentSessionActivity(env, session.id);
    return jsonResponse({
      error: 'Generation failed',
      message: 'I ran into a problem starting that MARTy response. Try again, or rephrase.',
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
    `data: ${JSON.stringify({ type: 'sources', sources })}\n\n`
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
      const normalizedOutput = normalizeMartyOutputText(
        rawContent,
        new Set(sources.map(s => s.id))
      );

      const persistedContent = normalizedOutput.text || (
          cancelled
            ? '_(cancelled before MARTy started generating)_'
            : 'Something went wrong — no response was received. Please try again.'
      );
      const sourcesJson = sources.length > 0 ? JSON.stringify(sources) : null;
      const metadataObj: Record<string, any> = {
        status: cancelled ? 'cancelled' : (fullText || documentCards.length > 0 ? 'done' : 'error'),
        request_id: requestId,
        runtime_fingerprint: runtimeFingerprint,
        deep_dive: deepDive,
      };
      if (cancelled) metadataObj.cancelled = true;
      if (normalizedOutput.invalidCitationsStripped > 0) {
        metadataObj.invalid_citations_stripped = normalizedOutput.invalidCitationsStripped;
      }
      if (normalizedOutput.labeledCitationsCanonicalized > 0) {
        metadataObj.labeled_citations_canonicalized = normalizedOutput.labeledCitationsCanonicalized;
      }
      if (documentCards.length > 0) {
        metadataObj.document_cards = documentCards;
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
            sources.length,
            normalizedOutput.validCitationsUsed,
            normalizedOutput.invalidCitationsStripped,
            fullText.length
          ).run();
          if (normalizedOutput.invalidCitationsStripped > 0) {
            console.warn(`[citations] ${normalizedOutput.invalidCitationsStripped} invalid markers (sources=${sources.length}) in message ${assistantMessageId}`);
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
      if (assistantMessageId && persistedContent && sources.length > 0) {
        ctxExec.waitUntil(
          verifySampleClaims(assistantMessageId, ctx.orgId, persistedContent, sources, env)
        );
      }

      // Update session
      await touchAgentSessionActivity(env, session.id);

      // Auto-generate title on first turn
      if (turnIndex === 0 && !session.title) {
        try {
          const title = await callClaude(
            { system: SESSION_TITLE_PROMPT, user: query, max_tokens: 20, orgId: ctx.orgId, model: 'claude-haiku-4-5-20251001' },
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
      try { await env.R2.put(traceKey, contextBlock); } catch { /* ignore */ }

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
