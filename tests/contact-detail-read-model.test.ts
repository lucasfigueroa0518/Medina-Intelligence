import { describe, expect, it } from 'vitest';
import { __contactDetailReadModelTestHooks } from '../src/lib/contact-detail-read-model';

const { contactTimelineItemId, parseWeeklyInteractions, dedupeTimelineEntries } = __contactDetailReadModelTestHooks;

describe('contact detail read model helpers', () => {
  it('builds deterministic timeline item ids for idempotent upserts', () => {
    expect(contactTimelineItemId('contact-1', 'conversation', 'msg-7')).toBe('contact-1:conversation:msg-7');
  });

  it('parses rollup weekly interactions defensively', () => {
    expect(parseWeeklyInteractions(null)).toEqual([]);
    expect(parseWeeklyInteractions('not-json')).toEqual([]);
    expect(parseWeeklyInteractions(JSON.stringify([
      { week: '2026-20', week_start: '2026-05-11T00:00:00.000Z', cnt: '3' },
      { week: '', week_start: '2026-05-18T00:00:00.000Z', cnt: 1 },
    ]))).toEqual([
      { week: '2026-20', week_start: '2026-05-11T00:00:00.000Z', cnt: 3 },
    ]);
  });

  it('dedupes conversation threads and repeated same-day events before slicing', () => {
    const entries = dedupeTimelineEntries([
      { id: 'old-msg', type: 'conversation', external_thread_id: 'thread-1', timestamp: '2026-05-10T10:00:00Z' },
      { id: 'new-msg', type: 'conversation', external_thread_id: 'thread-1', timestamp: '2026-05-11T10:00:00Z' },
      { id: 'event-a', type: 'event', title: 'Intro Call', timestamp: '2026-05-12T09:00:00Z' },
      { id: 'event-b', type: 'event', title: ' Intro   Call ', timestamp: '2026-05-12T15:00:00Z' },
      { id: 'task-1', type: 'task', timestamp: '2026-05-09T09:00:00Z' },
    ]);

    expect(entries.map(e => e.id)).toEqual(['event-b', 'new-msg', 'task-1']);
    expect(entries[0].occurrence_count).toBe(2);
    expect(entries[1].thread_count).toBe(2);
  });
});
