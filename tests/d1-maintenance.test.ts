import { describe, expect, it } from 'vitest';
import { __eventAttendeesTestHooks } from '../src/lib/event-attendees';
import { __newsQualityTestHooks } from '../src/lib/news-quality';
import { __d1MaintenanceTestHooks } from '../src/lib/d1-maintenance';

const {
  chooseCanonicalAttendee,
  mergeAttendeeRows,
  normalizeAttendeeEmail,
} = __eventAttendeesTestHooks;

const {
  assessNewsQuality,
  isFutureNewsDate,
  normalizeNewsSourceUrl,
} = __newsQualityTestHooks;

describe('event attendee dedupe helpers', () => {
  it('normalizes attendee email for uniqueness', () => {
    expect(normalizeAttendeeEmail('  Person@Example.COM ')).toBe('person@example.com');
  });

  it('chooses a canonical attendee that preserves user/contact-bearing rows', () => {
    const rows = [
      { id: 'late', event_id: 'e1', contact_id: null, user_id: null, email: 'a@x.com', display_name: null, role: 'attendee', is_internal: 0, created_at: '2026-01-02T00:00:00.000Z' },
      { id: 'user', event_id: 'e1', contact_id: null, user_id: 'u1', email: 'A@X.COM', display_name: 'Ada', role: 'optional', is_internal: 1, created_at: '2026-01-03T00:00:00.000Z' },
      { id: 'organizer', event_id: 'e1', contact_id: 'c1', user_id: null, email: 'a@x.com', display_name: null, role: 'organizer', is_internal: 0, created_at: '2026-01-01T00:00:00.000Z' },
    ];
    const canonical = chooseCanonicalAttendee(rows);
    expect(canonical?.id).toBe('user');
    const merged = mergeAttendeeRows(rows, canonical!);
    expect(merged.contact_id).toBe('c1');
    expect(merged.user_id).toBe('u1');
    expect(merged.role).toBe('organizer');
    expect(merged.is_internal).toBe(1);
    expect(merged.email).toBe('a@x.com');
  });
});

describe('news quality helpers', () => {
  it('normalizes source URLs by removing tracking parameters and fragments', () => {
    expect(normalizeNewsSourceUrl('HTTPS://www.Example.com/path/?utm_source=x&b=2&a=1#frag'))
      .toBe('https://example.com/path?a=1&b=2');
  });

  it('quarantines missing URLs and future dates', () => {
    expect(assessNewsQuality({ sourceUrl: '', publishedAt: '2026-01-01T00:00:00.000Z' }))
      .toMatchObject({ status: 'quarantined', reason: 'missing_source_url' });
    expect(isFutureNewsDate('2026-02-05T00:00:00.000Z', new Date('2026-02-01T00:00:00.000Z'))).toBe(true);
    expect(assessNewsQuality({
      sourceUrl: 'https://example.com/a',
      publishedAt: '2026-02-05T00:00:00.000Z',
      now: new Date('2026-02-01T00:00:00.000Z'),
    })).toMatchObject({ status: 'quarantined', reason: 'future_published_at' });
  });
});

describe('maintenance retention defaults', () => {
  it('uses the approved 30/90 day retention windows', () => {
    expect(__d1MaintenanceTestHooks.SUCCESS_RETENTION_DAYS).toBe(30);
    expect(__d1MaintenanceTestHooks.FAILURE_RETENTION_DAYS).toBe(90);
  });

  it('does not treat transient work_queue failed rows as retention-terminal', () => {
    const names = __d1MaintenanceTestHooks.retentionConfigs().map(c => c.name);
    expect(names).toContain('work_queue_completed');
    expect(names).toContain('work_queue_dead_letter');
    expect(names).not.toContain('work_queue_failed');
  });
});
