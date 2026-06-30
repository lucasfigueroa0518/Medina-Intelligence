// TRD §7.4 — Firefly→Outlook reconciliation: confidence scoring (pure logic).
//
// This module holds the *decision* half of reconciliation with zero I/O so it
// can be unit-tested exhaustively. src/lib/reconciliation.ts owns the D1 reads
// (gather candidates + attendees) and the writes (attach transcript, flip
// statuses); it hands plain data structures to `scoreReconciliation` and acts
// on the returned decision.
//
// Why a scorer instead of the old phased thresholds:
//   The prior matcher required ±15min + ≥2 attendee overlap (Phase 1) or
//   ±24h + ≥3 overlap + reschedule (Phase 2), first-candidate-wins. That model
//   silently stranded legitimate transcript/calendar matches when:
//     • the Outlook organizer was dropped from attendees[] (a 2-person meeting
//       the internal user organized then has overlap=1, never clears ≥2),
//     • Firefly's *recording* start drifted >15min from the scheduled time,
//     • the only hard evidence was ONE external attendee + time + title,
//     • duplicate Outlook rows (organizer-copy vs attendee-copy carry distinct
//       outlook_event_id) made first-match-wins pick an arbitrary duplicate.
//
//   The scorer replaces hard phases with weighted evidence + an explicit
//   ambiguity guard: a transcript is attached only when a single *logical*
//   meeting clears MATCH_THRESHOLD and beats the next distinct meeting by
//   AMBIGUITY_MARGIN. Duplicate Outlook rows of the *same* meeting collapse to
//   one logical candidate; genuinely competing meetings stay `pending` with a
//   diagnostic rather than guess.

export interface AttendeeRef {
  email: string;
  /** Resolved from event_attendees.user_id (internal user) — drives the
   *  external-vs-internal weighting. */
  isInternal: boolean;
}

export interface FireflyMeeting {
  id: string;
  /** ISO-8601 recording start. */
  startTime: string;
  title: string;
  transcriptR2Key: string | null;
  attendees: AttendeeRef[];
}

export interface OutlookCandidate {
  id: string;
  /** ISO-8601 scheduled start. */
  startTime: string;
  createdAt: string | null;
  updatedAt: string | null;
  title: string;
  attendees: AttendeeRef[];
  /** Set when this Outlook row already carries a transcript pointer. Lets the
   *  scorer (a) recognise an idempotent re-run when the key matches the Firefly
   *  row, and (b) refuse to steal a transcript that belongs to a different
   *  Firefly meeting. */
  existingTranscriptR2Key: string | null;
}

export interface ReconcileWeights {
  // Time proximity (additive points by absolute |Δstart|).
  timeWithin10Min: number;
  timeWithin30Min: number;
  timeWithin90Min: number;
  timeWithin6H: number;
  /** Only granted beyond 90min when the candidate shows a reschedule signal. */
  timeRescheduleFar: number;
  /** Candidates beyond this many minutes are excluded entirely. */
  maxDeltaMinutes: number;
  /** A candidate updated more than this long after creation looks rescheduled. */
  rescheduleEditGapMinutes: number;

  // Attendee overlap.
  perExternalOverlap: number;
  externalOverlapCap: number;
  perInternalOverlap: number;
  internalOverlapCap: number;

  // Title (over *distinctive* tokens only; generic titles contribute nothing).
  titleStrong: number;
  titleWeak: number;
  titleStrongJaccard: number;
  titleWeakJaccard: number;

  // Decision gates.
  matchThreshold: number;
  ambiguityMargin: number;
  /** Two candidates are duplicate rows of one meeting if their starts are
   *  within this many minutes AND attendee sets + titles align. */
  duplicateWindowMinutes: number;
  duplicateAttendeeJaccard: number;
}

export const DEFAULT_WEIGHTS: ReconcileWeights = {
  timeWithin10Min: 40,
  timeWithin30Min: 32,
  timeWithin90Min: 22,
  timeWithin6H: 10,
  timeRescheduleFar: 5,
  maxDeltaMinutes: 24 * 60,
  rescheduleEditGapMinutes: 60,

  perExternalOverlap: 35,
  externalOverlapCap: 70,
  perInternalOverlap: 8,
  internalOverlapCap: 24,

  titleStrong: 20,
  titleWeak: 8,
  titleStrongJaccard: 0.6,
  titleWeakJaccard: 0.3,

  matchThreshold: 55,
  ambiguityMargin: 15,
  duplicateWindowMinutes: 10,
  duplicateAttendeeJaccard: 0.8,
};

export interface CandidateSignals {
  /** Signed minutes (outlook − firefly); diagnostics show direction. */
  timeDeltaMinutes: number;
  timeScore: number;
  externalOverlap: number;
  internalOverlap: number;
  attendeeScore: number;
  /** Jaccard over distinctive tokens, 0..1. 0 when either title is generic. */
  titleSimilarity: number;
  titleScore: number;
  rescheduleSignal: boolean;
  total: number;
}

export interface ScoredCandidate {
  candidateId: string;
  signals: CandidateSignals;
  /** Eligible to *receive* the transcript: ≥1 external OR ≥2 internal overlaps,
   *  within the time window, and not already holding a different transcript. */
  attachEligible: boolean;
  alreadyHasDifferentTranscript: boolean;
  /** Canonical id of the logical-meeting group this row collapsed into. */
  duplicateOf: string | null;
  reasons: string[];
}

export interface LogicalGroup {
  canonicalId: string;
  memberIds: string[];
  score: number;
}

export type ReconcileOutcome =
  | 'matched'
  | 'ambiguous'
  | 'no_match'
  | 'already_reconciled'
  | 'no_candidates';

export interface ReconciliationDecision {
  outcome: ReconcileOutcome;
  chosenCandidateId: string | null;
  /** Score of the chosen logical group (null when nothing chosen). */
  confidence: number | null;
  /** best − secondBest across distinct logical groups (null when <2 groups). */
  margin: number | null;
  /** Every candidate, scored, sorted by total desc. */
  scored: ScoredCandidate[];
  logicalGroups: LogicalGroup[];
  /** One-line human summary for diagnostics/logs. */
  explanation: string;
}

// ── Title normalisation ──────────────────────────────────────────────────────

// Tokens that carry no identifying signal: filler/stopwords + the vocabulary of
// generic meeting titles. A title whose *distinctive* token set (everything
// outside this list, length ≥ 2, not a bare number) is empty is "generic" and
// contributes nothing to the score — matching "45 Min Meeting" to "45 Min
// Meeting" is not evidence of anything.
const GENERIC_TOKENS = new Set([
  'meeting', 'meet', 'call', 'sync', 'syncup', 'catchup', 'catch', 'up',
  'quick', 'weekly', 'biweekly', 'monthly', 'daily', 'standup', 'stand',
  'intro', 'introduction', 'introductory', 'chat', 'discussion', 'discuss',
  'check', 'checkin', 'touch', 'touchbase', 'base', 'zoom', 'teams', 'google',
  'hangout', 'webex', 'min', 'mins', 'minute', 'minutes', 'hour', 'hr',
  'new', 'untitled', 'event', 'appointment', 'invite', 'calendar', 'block',
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'to', 'of', 'on', 'at', 're',
  'vs', 'between', 'about',
]);

export function normalizeTitle(title: string | null | undefined): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function distinctiveTokens(title: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const tok of normalizeTitle(title).split(' ')) {
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue; // bare numbers ("45", "30")
    if (GENERIC_TOKENS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

export function isGenericTitle(title: string | null | undefined): boolean {
  return distinctiveTokens(title).size === 0;
}

/** Jaccard over distinctive tokens. 0 when either title is generic — we never
 *  let two generic titles "match". */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = distinctiveTokens(a);
  const tb = distinctiveTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emailSet(attendees: AttendeeRef[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const a of attendees) {
    const e = String(a.email || '').trim().toLowerCase();
    if (!e) continue;
    // Internal wins if any row marks the email internal.
    m.set(e, (m.get(e) || false) || !!a.isInternal);
  }
  return m;
}

function minutesBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (a - b) / 60000;
}

function attendeeJaccard(a: Map<string, boolean>, b: Map<string, boolean>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const k of a.keys()) if (b.has(k)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Core scoring ─────────────────────────────────────────────────────────────

function scoreOne(
  firefly: FireflyMeeting,
  fireflyEmails: Map<string, boolean>,
  candidate: OutlookCandidate,
  w: ReconcileWeights
): ScoredCandidate {
  const reasons: string[] = [];
  const candEmails = emailSet(candidate.attendees);

  const signedDelta = minutesBetween(candidate.startTime, firefly.startTime);
  const absDelta = Math.abs(signedDelta);

  // Reschedule signal: the calendar row was edited well after it was created,
  // which is how a moved meeting looks (transcript recorded against the
  // original slot, calendar entry shifted).
  let rescheduleSignal = false;
  if (candidate.createdAt && candidate.updatedAt) {
    const editGap = minutesBetween(candidate.updatedAt, candidate.createdAt);
    rescheduleSignal = Number.isFinite(editGap) && editGap > w.rescheduleEditGapMinutes;
  }

  // Time score.
  let timeScore = 0;
  if (absDelta <= 10) timeScore = w.timeWithin10Min;
  else if (absDelta <= 30) timeScore = w.timeWithin30Min;
  else if (absDelta <= 90) timeScore = w.timeWithin90Min;
  else if (absDelta <= 360) timeScore = w.timeWithin6H;
  else if (absDelta <= w.maxDeltaMinutes && rescheduleSignal) timeScore = w.timeRescheduleFar;
  else timeScore = 0;

  // Attendee overlap, split internal/external.
  let externalOverlap = 0;
  let internalOverlap = 0;
  for (const [email] of candEmails) {
    if (!fireflyEmails.has(email)) continue;
    // External if neither side marked it internal.
    const internal = candEmails.get(email) || fireflyEmails.get(email);
    if (internal) internalOverlap++;
    else externalOverlap++;
  }
  const attendeeScore =
    Math.min(externalOverlap * w.perExternalOverlap, w.externalOverlapCap) +
    Math.min(internalOverlap * w.perInternalOverlap, w.internalOverlapCap);

  // Title.
  const sim = titleSimilarity(firefly.title, candidate.title);
  let titleScore = 0;
  if (sim >= w.titleStrongJaccard) titleScore = w.titleStrong;
  else if (sim >= w.titleWeakJaccard) titleScore = w.titleWeak;

  const beyondWindow = absDelta > w.maxDeltaMinutes;
  const total = beyondWindow ? 0 : timeScore + attendeeScore + titleScore;

  const alreadyHasDifferentTranscript =
    !!candidate.existingTranscriptR2Key &&
    candidate.existingTranscriptR2Key !== firefly.transcriptR2Key;

  // Attach-eligibility: identity must be grounded. A single internal overlap is
  // too weak (any colleague is on many of this person's meetings); we require
  // ≥1 external attendee OR ≥2 internal attendees in common.
  let attachEligible = true;
  if (beyondWindow) {
    attachEligible = false;
    reasons.push(`outside ±${w.maxDeltaMinutes}min window (Δ=${Math.round(signedDelta)}min)`);
  }
  if (externalOverlap === 0 && internalOverlap < 2) {
    attachEligible = false;
    reasons.push(
      `insufficient identity overlap (external=${externalOverlap}, internal=${internalOverlap}; need ≥1 external or ≥2 internal)`
    );
  }
  if (alreadyHasDifferentTranscript) {
    attachEligible = false;
    reasons.push('candidate already holds a different transcript — not stealing');
  }
  if (attachEligible && total < w.matchThreshold) {
    reasons.push(`score ${total} below match threshold ${w.matchThreshold}`);
  }
  if (externalOverlap > 0) reasons.push(`${externalOverlap} external attendee match`);
  if (internalOverlap > 0) reasons.push(`${internalOverlap} internal attendee match`);
  if (sim > 0) reasons.push(`title similarity ${sim.toFixed(2)}`);

  return {
    candidateId: candidate.id,
    signals: {
      timeDeltaMinutes: Number.isFinite(signedDelta) ? Math.round(signedDelta) : signedDelta,
      timeScore,
      externalOverlap,
      internalOverlap,
      attendeeScore,
      titleSimilarity: sim,
      titleScore,
      rescheduleSignal,
      total,
    },
    attachEligible,
    alreadyHasDifferentTranscript,
    duplicateOf: null,
    reasons,
  };
}

/**
 * Group attach-eligible candidates that are duplicate Outlook rows of the *same*
 * logical meeting (same time ± window, near-identical attendee sets, compatible
 * titles). Returns groups with a deterministic canonical pick (highest score,
 * then earliest start, then smallest id) so duplicates don't read as ambiguity.
 */
function collapseDuplicates(
  eligible: ScoredCandidate[],
  byId: Map<string, OutlookCandidate>,
  w: ReconcileWeights
): LogicalGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
  for (const c of eligible) parent.set(c.candidateId, c.candidateId);

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = byId.get(eligible[i].candidateId)!;
      const b = byId.get(eligible[j].candidateId)!;
      const closeInTime = Math.abs(minutesBetween(a.startTime, b.startTime)) <= w.duplicateWindowMinutes;
      const sameAttendees = attendeeJaccard(emailSet(a.attendees), emailSet(b.attendees)) >= w.duplicateAttendeeJaccard;
      const aGeneric = isGenericTitle(a.title);
      const bGeneric = isGenericTitle(b.title);
      const titleCompatible =
        (aGeneric && bGeneric) || titleSimilarity(a.title, b.title) >= w.titleStrongJaccard;
      if (closeInTime && sameAttendees && titleCompatible) union(a.id, b.id);
    }
  }

  const groups = new Map<string, ScoredCandidate[]>();
  for (const c of eligible) {
    const root = find(c.candidateId);
    let members = groups.get(root);
    if (!members) { members = []; groups.set(root, members); }
    members.push(c);
  }

  const result: LogicalGroup[] = [];
  for (const members of groups.values()) {
    const canonical = [...members].sort((x, y) => {
      if (y.signals.total !== x.signals.total) return y.signals.total - x.signals.total;
      const xs = Date.parse(byId.get(x.candidateId)!.startTime) || 0;
      const ys = Date.parse(byId.get(y.candidateId)!.startTime) || 0;
      if (xs !== ys) return xs - ys;
      return x.candidateId.localeCompare(y.candidateId);
    })[0];
    for (const m of members) m.duplicateOf = canonical.candidateId;
    result.push({
      canonicalId: canonical.candidateId,
      memberIds: members.map(m => m.candidateId),
      score: canonical.signals.total,
    });
  }
  result.sort((a, b) => b.score - a.score);
  return result;
}

/**
 * Score every Outlook candidate against one Firefly meeting and decide whether
 * to attach. Pure: no I/O, deterministic. The orchestrator in reconciliation.ts
 * applies the writes for an `outcome === 'matched'` (or treats
 * `already_reconciled` as a no-op success).
 */
export function scoreReconciliation(
  firefly: FireflyMeeting,
  candidates: OutlookCandidate[],
  weights?: Partial<ReconcileWeights>
): ReconciliationDecision {
  const w: ReconcileWeights = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const byId = new Map(candidates.map(c => [c.id, c]));
  const fireflyEmails = emailSet(firefly.attendees);

  // Idempotent re-run: a candidate already holding *this* transcript means the
  // pair is reconciled — surface it as such, never re-write.
  if (firefly.transcriptR2Key) {
    const already = candidates.find(c => c.existingTranscriptR2Key === firefly.transcriptR2Key);
    if (already) {
      return {
        outcome: 'already_reconciled',
        chosenCandidateId: already.id,
        confidence: null,
        margin: null,
        scored: candidates.map(c => scoreOne(firefly, fireflyEmails, c, w)),
        logicalGroups: [],
        explanation: `already attached to Outlook event ${already.id}`,
      };
    }
  }

  const scored = candidates
    .map(c => scoreOne(firefly, fireflyEmails, c, w))
    .sort((a, b) => b.signals.total - a.signals.total);

  if (candidates.length === 0) {
    return {
      outcome: 'no_candidates',
      chosenCandidateId: null,
      confidence: null,
      margin: null,
      scored,
      logicalGroups: [],
      explanation: 'no Outlook events in the search window',
    };
  }

  const eligible = scored.filter(c => c.attachEligible && c.signals.total >= w.matchThreshold);
  const groups = collapseDuplicates(eligible, byId, w);

  if (groups.length === 0) {
    const bestSeen = scored[0];
    return {
      outcome: 'no_match',
      chosenCandidateId: null,
      confidence: null,
      margin: null,
      scored,
      logicalGroups: [],
      explanation: bestSeen
        ? `no candidate cleared threshold ${w.matchThreshold} (best=${bestSeen.signals.total}: ${bestSeen.reasons.join('; ')})`
        : 'no viable candidate',
    };
  }

  const best = groups[0];
  const second = groups[1];
  const margin = second ? best.score - second.score : null;

  if (second && margin !== null && margin < w.ambiguityMargin) {
    return {
      outcome: 'ambiguous',
      chosenCandidateId: null,
      confidence: best.score,
      margin,
      scored,
      logicalGroups: groups,
      explanation:
        `ambiguous: ${groups.length} distinct meetings cleared threshold; ` +
        `top two within margin ${w.ambiguityMargin} ` +
        `(${best.canonicalId}=${best.score} vs ${second.canonicalId}=${second.score})`,
    };
  }

  return {
    outcome: 'matched',
    chosenCandidateId: best.canonicalId,
    confidence: best.score,
    margin,
    scored,
    logicalGroups: groups,
    explanation:
      `matched Outlook event ${best.canonicalId} (score ${best.score}` +
      (margin !== null ? `, margin ${margin}` : ', sole candidate') +
      (best.memberIds.length > 1 ? `, collapsed ${best.memberIds.length} duplicate rows` : '') +
      ')',
  };
}
