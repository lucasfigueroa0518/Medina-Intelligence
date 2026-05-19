export type RoutedSourceIntent = 'platform' | 'meeting' | 'event_window' | 'slack' | 'email' | 'document' | 'firm_state' | 'mixed' | 'none';

export interface RoutedToolCall {
  tool: 'inspect_platform_telemetry' | 'search_events' | 'recall' | 'get_firm_relationship_snapshot';
  input: Record<string, unknown>;
  reason: string;
}

export interface SourceRoutingPlan {
  intent: RoutedSourceIntent;
  calls: RoutedToolCall[];
}

const MEETING_RE = /\b(meeting|meetings|transcript|transcripts|calendar|event|events|call|calls|webinar|town hall)\b/i;
const EVENT_WINDOW_RE = /\b(recent|upcoming|next|past|window|schedule|calendar|this week|last week|next week)\b/i;
const MEETING_CONTENT_RE = /\b(discussed|discussion|said|talked about|recap|summary|summarize|decisions?|action items?|transcripts?|notes?)\b/i;
const SLACK_RE = /\b(slack|channel|channels|dm|dms)\b/i;
const EMAIL_RE = /\b(email|emails|inbox|sent mail|outlook|thread|threads)\b/i;
const DOCUMENT_RE = /\b(document|documents|doc|docs|pdf|deck|presentation|spreadsheet|xlsx|csv|attachment|file|files|memo|report)\b/i;
const FIRM_STATE_RE = /\b(portfolio compan(?:y|ies)|portfolio co(?:mpany|mpanies|s)?|portco(?:s)?|current portfolio|our portfolio|portfolio financial|portfolio ranking|current investments?|active pipeline|deal pipeline|pipeline compan(?:y|ies)|watchlist|current holdings?)\b/i;
const PLATFORM_RE = /\b(platform|system status|system health|sync(?:ed|ing)?|sync jobs?|task runs?|cron|workflow|work queue|queue|dead[- ]?letter|ingest(?:ed|ion|ing)?|backfill(?:ed|ing)?|connector|outlook token|delta token|indexed|indexing|scheduler|schedule|cadence|rate limits?|upstream budget)\b/i;
const PLATFORM_COVERAGE_RE = /\b(data completeness|document coverage|email coverage|meeting coverage|embedding coverage|searchable|searchability|vector(?:s|ize)?|embedded\s+(?:documents?|emails?|meetings?|conversations?)|(?:documents?|emails?|meetings?|conversations?)\s+embedded)\b/i;
const PLATFORM_RUNTIME_RE = /\b(marty runtime|runtime fingerprint|agent tool schema|deploy sha|commit sha|what model are you running|which model are you running)\b/i;
const PLATFORM_PIPELINE_RE = /\b(company enrichment|contact enrichment|enrichment workflow|news enrichment|news feed|news pipeline|gemini(?: api)?|gemini calls?|calling gemini|api call telemetry)\b/i;
const PLATFORM_PIPELINE_QUESTION_RE = /\b(how often|how consistent|consistently|happening|running|called|calling|cadence|frequency|schedule|scheduler|cron|workflow|pipeline|rate limit|system|platform)\b/i;

export function planDeterministicSourceRouting(query: string, opts: { deepDive?: boolean } = {}): SourceRoutingPlan {
  const clean = query.replace(/\s+/g, ' ').trim();
  const calls: RoutedToolCall[] = [];
  const platform = PLATFORM_RE.test(clean)
    || PLATFORM_COVERAGE_RE.test(clean)
    || PLATFORM_RUNTIME_RE.test(clean)
    || (PLATFORM_PIPELINE_RE.test(clean) && PLATFORM_PIPELINE_QUESTION_RE.test(clean));
  const meeting = MEETING_RE.test(clean);
  const eventWindow = meeting && EVENT_WINDOW_RE.test(clean);
  const meetingContent = meeting && MEETING_CONTENT_RE.test(clean);
  const slack = SLACK_RE.test(clean);
  const email = EMAIL_RE.test(clean) && !slack;
  const document = DOCUMENT_RE.test(clean);
  const firmState = FIRM_STATE_RE.test(clean);
  const limit = opts.deepDive ? 30 : 12;

  if (platform) {
    calls.push({
      tool: 'inspect_platform_telemetry',
      input: {
        query: clean,
        topic: 'auto',
        limit: opts.deepDive ? 25 : 10,
      },
      reason: 'platform-telemetry query: deterministic operational metrics for ingestion, backfills, enrichment/news cadence, provider budgets, queues, coverage, or sync health',
    });
  }

  if (firmState && !platform) {
    calls.push({
      tool: 'get_firm_relationship_snapshot',
      input: {
        include_pipeline: true,
        limit: opts.deepDive ? 500 : 300,
      },
      reason: 'firm-state query: deterministic current portfolio/pipeline/watchlist snapshot',
    });
  }

  if ((meeting || eventWindow) && !platform) {
    calls.push({
      tool: 'search_events',
      input: {
        keyword: trimRouterKeyword(clean),
        timeframe: eventWindow ? 'recent_and_upcoming' : 'recent_and_upcoming',
        include_transcript_excerpt: meetingContent,
        limit,
      },
      reason: meetingContent
        ? 'meeting/event query: deterministic calendar + transcript-backed event lookup'
        : 'meeting/event query: deterministic calendar/event lookup',
    });
  }

  if (meetingContent && !platform) {
    calls.push({
      tool: 'recall',
      input: {
        query: clean,
        source_types: ['meeting'],
        limit,
      },
      reason: 'meeting content query: deterministic meeting-scoped recall',
    });
  }

  if (slack && !platform) {
    calls.push({
      tool: 'recall',
      input: { query: clean, source_types: ['slack'], limit },
      reason: 'Slack-specific query: deterministic Slack-scoped recall',
    });
  }

  if (email && !platform) {
    calls.push({
      tool: 'recall',
      input: { query: clean, source_types: ['email'], limit },
      reason: 'email-specific query: deterministic email-scoped recall',
    });
  }

  if (document && !platform) {
    calls.push({
      tool: 'recall',
      input: { query: clean, source_types: ['document'], limit },
      reason: 'document-specific query: deterministic document-scoped recall',
    });
  }

  const intent: RoutedSourceIntent =
    calls.length === 0 ? 'none'
      : calls.length > 1 ? 'mixed'
        : platform ? 'platform'
          : firmState ? 'firm_state'
            : meeting ? (eventWindow ? 'event_window' : 'meeting')
              : slack ? 'slack'
                : email ? 'email'
                  : document ? 'document'
                    : 'none';

  return { intent, calls: dedupeCalls(calls) };
}

function trimRouterKeyword(query: string): string {
  return query
    .replace(/\b(give me|show me|window into|recent|upcoming|meetings?|events?|calendar|transcripts?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function dedupeCalls(calls: RoutedToolCall[]): RoutedToolCall[] {
  const seen = new Set<string>();
  const out: RoutedToolCall[] = [];
  for (const call of calls) {
    const key = `${call.tool}:${JSON.stringify(call.input)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(call);
  }
  return out;
}

export const __sourceRouterTestHooks = {
  planDeterministicSourceRouting,
};
