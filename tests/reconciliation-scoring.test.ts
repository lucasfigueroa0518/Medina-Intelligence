import { describe, expect, it } from 'vitest';
import {
  scoreReconciliation,
  titleSimilarity,
  isGenericTitle,
  distinctiveTokens,
  DEFAULT_WEIGHTS,
  type FireflyMeeting,
  type OutlookCandidate,
} from '../src/lib/reconciliation-scoring';
import { reconcileFireflyToOutlook } from '../src/lib/reconciliation';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TONY = { email: 'tony@medinavc.com', isInternal: true };
const RAVI = { email: 'ravi.jain@tdk-ventures.com', isInternal: false };
const ALICE = { email: 'alice@medinavc.com', isInternal: true };
const BOB = { email: 'bob@medinavc.com', isInternal: true };
const SAM = { email: 'sam@othercorp.com', isInternal: false };

const FF_START = '2026-06-01T17:00:00.000Z';

function fireflyMeeting(overrides: Partial<FireflyMeeting> = {}): FireflyMeeting {
  return {
    id: 'ff1',
    startTime: FF_START,
    // The real Tony row: distinctive owner name + a generic duration suffix.
    title: 'Tony Jimenez: 45 Min Meeting',
    transcriptR2Key: 'r2/transcripts/ff1.json',
    attendees: [TONY, RAVI],
    ...overrides,
  };
}

function outlookCandidate(overrides: Partial<OutlookCandidate> = {}): OutlookCandidate {
  return {
    id: 'ol1',
    startTime: FF_START,
    createdAt: '2026-05-25T12:00:00.000Z',
    updatedAt: '2026-05-25T12:00:00.000Z',
    title: 'Tony Jimenez: 45 Min Meeting',
    attendees: [TONY, RAVI],
    existingTranscriptR2Key: null,
    ...overrides,
  };
}

function plusMinutes(iso: string, mins: number): string {
  return new Date(Date.parse(iso) + mins * 60000).toISOString();
}

// ── Title helpers ────────────────────────────────────────────────────────────

describe('title helpers', () => {
  it('treats pure duration/meeting titles as generic', () => {
    expect(isGenericTitle('45 Min Meeting')).toBe(true);
    expect(isGenericTitle('Quick Sync')).toBe(true);
    expect(isGenericTitle('Zoom Meeting')).toBe(true);
    expect(isGenericTitle('Tony Jimenez: 45 Min Meeting')).toBe(false);
    expect([...distinctiveTokens('Tony Jimenez: 45 Min Meeting')].sort()).toEqual(['jimenez', 'tony']);
  });

  it('never matches two generic titles', () => {
    expect(titleSimilarity('45 Min Meeting', '30 Minute Meeting')).toBe(0);
  });

  it('scores distinctive overlap by Jaccard', () => {
    expect(titleSimilarity('Acme Corp Diligence', 'Acme Corp Diligence')).toBe(1);
    expect(titleSimilarity('Acme Corp Diligence', 'Acme Review')).toBeGreaterThan(0);
  });
});

// ── The Tony case ────────────────────────────────────────────────────────────

describe('scoreReconciliation — the Tony pending_reconciliation case', () => {
  it('matches a 2-person meeting (1 internal + 1 external) even with a GENERIC calendar title', () => {
    // This is the exact failure the old ≥2-overlap matcher could survive but
    // the organizer-dropped variant could not. Here the calendar title is
    // generic, so the whole match rests on attendee identity + time.
    const ff = fireflyMeeting();
    const candidate = outlookCandidate({
      title: '45 Min Meeting',                 // generic Outlook title
      startTime: plusMinutes(FF_START, 6),     // recording start drifted 6 min
    });

    const decision = scoreReconciliation(ff, [candidate]);

    expect(decision.outcome).toBe('matched');
    expect(decision.chosenCandidateId).toBe('ol1');
    // time(40, ≤10min) + external(35) + internal(8), title contributes 0.
    expect(decision.confidence).toBe(83);
    const scored = decision.scored[0];
    expect(scored.signals.externalOverlap).toBe(1);
    expect(scored.signals.internalOverlap).toBe(1);
    expect(scored.signals.titleScore).toBe(0);
    expect(scored.attachEligible).toBe(true);
  });

  it('still matches when recording start drifts beyond the old ±15min window', () => {
    const ff = fireflyMeeting();
    const candidate = outlookCandidate({
      title: '45 Min Meeting',
      startTime: plusMinutes(FF_START, 40), // would have failed the ±15min gate
    });

    const decision = scoreReconciliation(ff, [candidate]);
    expect(decision.outcome).toBe('matched');
    // time(22, ≤90min) + external(35) + internal(8) = 65
    expect(decision.confidence).toBe(65);
  });
});

// ── Safety: never false-attach on weak identity ──────────────────────────────

describe('scoreReconciliation — identity grounding', () => {
  it('does NOT match on a lone internal-user overlap', () => {
    // Only the internal user is shared — every colleague is on many of Tony's
    // meetings, so this must not attach.
    const ff = fireflyMeeting();
    const candidate = outlookCandidate({
      title: '45 Min Meeting',
      attendees: [TONY], // no external, single internal
      startTime: plusMinutes(FF_START, 3),
    });

    const decision = scoreReconciliation(ff, [candidate]);
    expect(decision.outcome).toBe('no_match');
    expect(decision.chosenCandidateId).toBeNull();
    expect(decision.scored[0].attachEligible).toBe(false);
    expect(decision.scored[0].reasons.join(' ')).toContain('insufficient identity overlap');
  });

  it('matches on two internal overlaps at a tight time (no external present)', () => {
    const ff = fireflyMeeting({ attendees: [TONY, ALICE] });
    const candidate = outlookCandidate({
      title: '45 Min Meeting',
      attendees: [TONY, ALICE],
      startTime: plusMinutes(FF_START, 4),
    });

    const decision = scoreReconciliation(ff, [candidate]);
    expect(decision.outcome).toBe('matched');
    // time(40) + internal(16) = 56
    expect(decision.confidence).toBe(56);
  });

  it('excludes candidates beyond the ±24h window regardless of attendees', () => {
    const ff = fireflyMeeting();
    const candidate = outlookCandidate({
      startTime: plusMinutes(FF_START, 30 * 60), // 30h away
    });

    const decision = scoreReconciliation(ff, [candidate]);
    expect(decision.outcome).toBe('no_match');
    expect(decision.scored[0].attachEligible).toBe(false);
    expect(decision.scored[0].reasons.join(' ')).toContain('outside ±');
  });
});

// ── Duplicate Outlook rows collapse to one logical meeting ───────────────────

describe('scoreReconciliation — duplicate Outlook rows', () => {
  it('collapses duplicate rows of the same meeting and matches the canonical one', () => {
    // Graph emits the organizer-copy and the attendee-copy with DIFFERENT
    // outlook_event_ids — same time, same attendees, same title. These must
    // read as one meeting, not as ambiguity.
    const ff = fireflyMeeting();
    const dupA = outlookCandidate({ id: 'ol-a', title: '45 Min Meeting' });
    const dupB = outlookCandidate({ id: 'ol-b', title: '45 Min Meeting' });

    const decision = scoreReconciliation(ff, [dupA, dupB]);
    expect(decision.outcome).toBe('matched');
    expect(decision.logicalGroups).toHaveLength(1);
    expect(decision.logicalGroups[0].memberIds.sort()).toEqual(['ol-a', 'ol-b']);
    // Deterministic canonical pick (equal score+start → smallest id).
    expect(decision.chosenCandidateId).toBe('ol-a');
  });

  it('stays AMBIGUOUS when two DISTINCT meetings both clear threshold within the margin', () => {
    // Two real, different meetings (different titles, >dupWindow apart) that
    // both share the external attendee → do not guess; leave pending.
    const ff = fireflyMeeting({ title: '45 Min Meeting' });
    const meetingA = outlookCandidate({
      id: 'ol-a',
      title: 'Acme Diligence',
      startTime: plusMinutes(FF_START, 5),  // time 40
    });
    const meetingB = outlookCandidate({
      id: 'ol-b',
      title: 'Beta Review',
      startTime: plusMinutes(FF_START, -10), // time 40, 15 min from A → not a dup
    });

    const decision = scoreReconciliation(ff, [meetingA, meetingB]);
    expect(decision.outcome).toBe('ambiguous');
    expect(decision.chosenCandidateId).toBeNull();
    expect(decision.logicalGroups.length).toBeGreaterThanOrEqual(2);
    expect(decision.margin!).toBeLessThan(DEFAULT_WEIGHTS.ambiguityMargin);
  });

  it('picks the clear winner when one distinct meeting beats the next by the margin', () => {
    const ff = fireflyMeeting({ title: '45 Min Meeting' });
    const strong = outlookCandidate({
      id: 'ol-strong',
      title: 'Acme Diligence',
      startTime: plusMinutes(FF_START, 5),    // time 40 → 83
    });
    const weak = outlookCandidate({
      id: 'ol-weak',
      title: 'Beta Review',
      startTime: plusMinutes(FF_START, 75),   // time 22 → 65, margin 18 ≥ 15
    });

    const decision = scoreReconciliation(ff, [strong, weak]);
    expect(decision.outcome).toBe('matched');
    expect(decision.chosenCandidateId).toBe('ol-strong');
    expect(decision.margin!).toBeGreaterThanOrEqual(DEFAULT_WEIGHTS.ambiguityMargin);
  });
});

// ── Never steal, idempotent re-runs ──────────────────────────────────────────

describe('scoreReconciliation — transcript ownership', () => {
  it('does not steal a candidate already holding a DIFFERENT transcript', () => {
    const ff = fireflyMeeting();
    const candidate = outlookCandidate({
      startTime: plusMinutes(FF_START, 3),
      existingTranscriptR2Key: 'r2/transcripts/someone-else.json',
    });

    const decision = scoreReconciliation(ff, [candidate]);
    expect(decision.outcome).toBe('no_match');
    expect(decision.scored[0].attachEligible).toBe(false);
    expect(decision.scored[0].alreadyHasDifferentTranscript).toBe(true);
    expect(decision.scored[0].reasons.join(' ')).toContain('not stealing');
  });

  it('reports already_reconciled (idempotent) when a candidate holds THIS transcript', () => {
    const ff = fireflyMeeting();
    const candidate = outlookCandidate({
      existingTranscriptR2Key: ff.transcriptR2Key, // same key → already done
    });

    const decision = scoreReconciliation(ff, [candidate]);
    expect(decision.outcome).toBe('already_reconciled');
    expect(decision.chosenCandidateId).toBe('ol1');
  });
});

// ── Title signal can tip a borderline far-time single-external match ──────────

describe('scoreReconciliation — title signal', () => {
  it('lets a distinctive matching title rescue a far single-external candidate', () => {
    const ff = fireflyMeeting({ title: 'Acme Diligence' });
    const candidate = outlookCandidate({
      title: 'Acme Diligence',
      startTime: plusMinutes(FF_START, 8 * 60), // 8h, no reschedule → time 0
    });

    const decision = scoreReconciliation(ff, [candidate]);
    // external(35) + internal(8) + titleStrong(20) = 63 ≥ 55
    expect(decision.outcome).toBe('matched');
    expect(decision.confidence).toBe(63);
  });

  it('control: the same far candidate with generic titles does NOT match', () => {
    const ff = fireflyMeeting({ title: '45 Min Meeting' });
    const candidate = outlookCandidate({
      title: '45 Min Meeting',
      startTime: plusMinutes(FF_START, 8 * 60),
    });

    const decision = scoreReconciliation(ff, [candidate]);
    // external(35) + internal(8) = 43 < 55
    expect(decision.outcome).toBe('no_match');
  });

  it('computes the reschedule signal from the created/updated gap', () => {
    const ff = fireflyMeeting();
    const candidate = outlookCandidate({
      startTime: plusMinutes(FF_START, 5),
      createdAt: '2026-05-25T12:00:00.000Z',
      updatedAt: '2026-05-25T15:00:00.000Z', // edited 3h after creation
    });
    const decision = scoreReconciliation(ff, [candidate]);
    expect(decision.scored[0].signals.rescheduleSignal).toBe(true);
  });
});

describe('scoreReconciliation — empty candidate set', () => {
  it('returns no_candidates when nothing is in the window', () => {
    const decision = scoreReconciliation(fireflyMeeting(), []);
    expect(decision.outcome).toBe('no_candidates');
  });
});

// ── Glue: reconcileFireflyToOutlook wiring + dryRun gating ────────────────────

interface MockRow { [k: string]: unknown }

function makeReconcileEnv(dataset: {
  firefly: MockRow;
  attendeesByEvent: Record<string, MockRow[]>;
  outlookCandidates: MockRow[];
}) {
  const batched: Array<{ sql: string; binds: unknown[] }> = [];
  const runs: Array<{ sql: string; binds: unknown[] }> = [];

  function makeStmt(sql: string) {
    const stmt: any = {
      sql,
      binds: [] as unknown[],
      bind(...args: unknown[]) { stmt.binds = args; return stmt; },
      async first() {
        if (sql.includes('FROM events') && sql.includes('WHERE id = ?')) {
          return dataset.firefly;
        }
        return null;
      },
      async all() {
        if (sql.includes('FROM event_attendees')) {
          const eventId = String(stmt.binds[0]);
          return { results: dataset.attendeesByEvent[eventId] || [] };
        }
        if (sql.includes("source = 'outlook'")) {
          return { results: dataset.outlookCandidates };
        }
        return { results: [] };
      },
      async run() { runs.push({ sql, binds: stmt.binds }); return { meta: { changes: 1 } }; },
    };
    return stmt;
  }

  const env: any = {
    D1: {
      prepare: (sql: string) => makeStmt(sql),
      async batch(stmts: any[]) {
        for (const s of stmts) batched.push({ sql: s.sql, binds: s.binds });
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    },
  };
  return { env, batched, runs };
}

describe('reconcileFireflyToOutlook — D1 glue', () => {
  const dataset = {
    firefly: {
      id: 'ff1',
      title: 'Tony Jimenez: 45 Min Meeting',
      start_time: FF_START,
      transcript_r2_key: 'r2/transcripts/ff1.json',
    },
    attendeesByEvent: {
      ff1: [
        { email: 'tony@medinavc.com', user_id: 'u-tony', is_internal: 1 },
        { email: 'ravi.jain@tdk-ventures.com', user_id: null, is_internal: 0 },
      ],
      ol1: [
        { email: 'tony@medinavc.com', user_id: 'u-tony', is_internal: 1 },
        { email: 'ravi.jain@tdk-ventures.com', user_id: null, is_internal: 0 },
      ],
    },
    outlookCandidates: [
      {
        id: 'ol1',
        title: '45 Min Meeting',
        start_time: plusMinutes(FF_START, 5),
        created_at: '2026-05-25T12:00:00.000Z',
        updated_at: '2026-05-25T12:00:00.000Z',
        transcript_r2_key: null,
      },
    ],
  };

  it('applies the transcript attach + status flips on a confident match', async () => {
    const { env, batched } = makeReconcileEnv(dataset);

    const result = await reconcileFireflyToOutlook(
      { id: 'ff1', firefly_event_id: 'FF-EXT', start_time: FF_START, transcript_r2_key: 'r2/transcripts/ff1.json' },
      'org-1',
      env
    );

    expect(result.outcome).toBe('matched');
    expect(result.applied).toBe(true);
    expect(batched).toHaveLength(2);
    // Outlook row gets the transcript pointer.
    const attach = batched.find(b => b.sql.includes("transcript_source = 'firefly'"));
    expect(attach?.binds).toEqual(['r2/transcripts/ff1.json', 'ol1']);
    // Firefly row flipped to reconciled.
    const flip = batched.find(b => !b.sql.includes('transcript_source') && b.sql.includes("reconciliation_status = 'reconciled'"));
    expect(flip?.binds).toEqual(['ff1']);
  });

  it('dryRun scores but never writes', async () => {
    const { env, batched } = makeReconcileEnv(dataset);

    const result = await reconcileFireflyToOutlook(
      { id: 'ff1', firefly_event_id: 'FF-EXT', start_time: FF_START, transcript_r2_key: 'r2/transcripts/ff1.json' },
      'org-1',
      env,
      { dryRun: true }
    );

    expect(result.outcome).toBe('matched');
    expect(result.applied).toBe(false);
    expect(batched).toHaveLength(0);
  });

  it('refuses to attach calendar rows when the Firefly row has no transcript key', async () => {
    const { env, batched } = makeReconcileEnv({
      ...dataset,
      firefly: { ...dataset.firefly, transcript_r2_key: null },
    });

    const result = await reconcileFireflyToOutlook(
      { id: 'ff1', firefly_event_id: 'FF-EXT', start_time: FF_START, transcript_r2_key: null },
      'org-1',
      env
    );

    expect(result.outcome).toBe('no_match');
    expect(result.applied).toBe(false);
    expect(result.explanation).toContain('no transcript_r2_key');
    expect(batched).toHaveLength(0);
  });

  it('marks the Firefly row reconciled when the Outlook side already has this transcript', async () => {
    const updateRuns: Array<{ sql: string; binds: unknown[] }> = [];
    const { env, batched } = makeReconcileEnv({
      ...dataset,
      outlookCandidates: [
        {
          ...dataset.outlookCandidates[0],
          transcript_r2_key: 'r2/transcripts/ff1.json',
        },
      ],
    });
    const originalPrepare = env.D1.prepare;
    env.D1.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      const originalRun = stmt.run;
      stmt.run = async () => {
        updateRuns.push({ sql, binds: stmt.binds });
        return originalRun();
      };
      return stmt;
    };

    const result = await reconcileFireflyToOutlook(
      { id: 'ff1', firefly_event_id: 'FF-EXT', start_time: FF_START, transcript_r2_key: 'r2/transcripts/ff1.json' },
      'org-1',
      env
    );

    expect(result.outcome).toBe('already_reconciled');
    expect(result.applied).toBe(true);
    expect(batched).toHaveLength(0);
    expect(updateRuns.some(r => r.sql.includes("reconciliation_status = 'reconciled'") && r.binds[0] === 'ff1')).toBe(true);
  });

  it('returns no_candidates (no write) when the firefly row is missing', async () => {
    const { env, batched } = makeReconcileEnv({ ...dataset, firefly: null as any });
    const result = await reconcileFireflyToOutlook(
      { id: 'missing', start_time: FF_START, transcript_r2_key: null },
      'org-1',
      env
    );
    expect(result.outcome).toBe('no_candidates');
    expect(result.applied).toBe(false);
    expect(batched).toHaveLength(0);
  });
});
