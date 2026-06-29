import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  __contactListReadModelTestHooks,
  bootstrapContactList,
  listContactsFromReadModel,
} from '../src/lib/contact-list-read-model';
import type { AuthContext } from '../src/types/interfaces';

const {
  encodeContactListCursor,
  decodeContactListCursor,
  parseRequest,
  lastContactPredicate,
  interactionsPredicate,
  tagFilterPredicate,
  cursorPredicate,
} = __contactListReadModelTestHooks;

describe('contact list read model helpers', () => {
  it('round-trips opaque cursors and rejects malformed input', () => {
    const cursor = {
      mode: 'seek' as const,
      offset: 250,
      sort: 'last_contact',
      order: 'desc' as const,
      value: '2026-06-24T12:00:00.000Z',
      id: 'contact-1',
    };

    const encoded = encodeContactListCursor(cursor);
    expect(encoded).not.toContain('{');
    expect(encoded).not.toContain('+');
    expect(decodeContactListCursor(encoded)).toEqual(cursor);
    expect(decodeContactListCursor('not-json')).toBeNull();
    expect(decodeContactListCursor(encodeContactListCursor({ ...cursor, offset: -1 }))).toBeNull();
  });

  it('parses modern list filters, legacy sort aliases, and bounded limits', () => {
    const url = new URL('https://api.test/api/contacts?type=individual,family&status=active,warm&last_contact=1_3_months,3_plus_months&tags=tag-a,tag-b&company_id=company-1&sort_by=full_name&sort_dir=asc&limit=9999&offset=25');
    const req = parseRequest(url, 100);

    expect(req.typeList).toEqual(['individual', 'family']);
    expect(req.statusList).toEqual(['active', 'warm']);
    expect(req.lastContactBuckets).toEqual(['1_3_months', '3_plus_months']);
    expect(req.tagsParam).toEqual(['tag-a', 'tag-b']);
    expect(req.filter.company_id).toBe('company-1');
    expect(req.sortKey).toBe('name');
    expect(req.sortDir).toBe('ASC');
    expect(req.limit).toBe(500);
    expect(req.offset).toBe(25);
  });

  it('uses offset cursors for FTS search pages', () => {
    const cursor = encodeContactListCursor({
      mode: 'offset',
      offset: 500,
      sort: 'last_contact',
      order: 'desc',
    });
    const req = parseRequest(new URL(`https://api.test/api/contacts?search=alvaro&cursor=${cursor}`), 250);

    expect(req.useOffsetCursor).toBe(true);
    expect(req.offset).toBe(500);
  });

  it('builds set-based tag predicates without row fanout', () => {
    const idBinds: unknown[] = [];
    const idSql = tagFilterPredicate(['0123456789abcdef'], 'or', idBinds);
    expect(idSql).toContain('contact_tags ct');
    expect(idSql).not.toContain('JOIN tags');
    expect(idBinds).toEqual(['0123456789abcdef']);

    const nameBinds: unknown[] = [];
    const nameSql = tagFilterPredicate(['LP', 'Founder'], 'and', nameBinds);
    expect(nameSql).toContain('JOIN tags t ON t.id = ct.tag_id');
    expect(nameSql).toContain('HAVING COUNT(DISTINCT t.name) = 2');
    expect(nameBinds).toEqual(['LP', 'Founder']);
  });

  it('builds seek cursor predicates for stable keyset pagination', () => {
    const req = parseRequest(new URL('https://api.test/api/contacts?sort=interactions&order=desc'), 100);
    const binds: unknown[] = [];
    const predicate = cursorPredicate(
      { mode: 'seek', offset: 100, sort: 'interactions', order: 'desc', value: 42, id: 'contact-9' },
      req,
      'COALESCE(cle.total_interactions, 0)',
      binds
    );

    expect(predicate).toContain('COALESCE(cle.total_interactions, 0) < ?');
    expect(predicate).toContain('cle.contact_id > ?');
    expect(binds).toEqual([42, 42, 'contact-9']);

    const mismatched = cursorPredicate(
      { mode: 'seek', offset: 100, sort: 'name', order: 'asc', value: 'Ada', id: 'contact-9' },
      req,
      'COALESCE(cle.total_interactions, 0)',
      []
    );
    expect(mismatched).toBeNull();
  });

  it('keeps list activity filters as SQL predicates', () => {
    expect(lastContactPredicate('never', 'cle.last_contact_date')).toBe('cle.last_contact_date IS NULL');
    expect(lastContactPredicate('3_plus_months', 'cle.last_contact_date')).toContain("datetime('now','-90 days')");
    expect(interactionsPredicate('200_plus', 'cle.total_interactions')).toBe('cle.total_interactions > 200');
    expect(interactionsPredicate('bogus', 'cle.total_interactions')).toBeNull();
  });

  it('does not call the per-contact activity rollup loader from the list endpoint', () => {
    const source = readFileSync(new URL('../src/handlers/contacts.ts', import.meta.url), 'utf8');
    const listStart = source.indexOf('async function listContacts');
    const nextHandler = source.indexOf('export async function getContact', listStart);
    const listHandlerSource = source.slice(listStart, nextHandler);

    expect(listHandlerSource).toContain('listContactsFromReadModel');
    expect(listHandlerSource).not.toContain('loadContactActivityRollupForViewer');
  });

  it('returns first page rows plus facets from bootstrap in one response', async () => {
    const fake = createFakeEnv();
    const ctx = fakeAuthContext('owner');
    const result = await bootstrapContactList(
      new Request('https://api.test/api/contacts/bootstrap?limit=250'),
      ctx,
      fake.env
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({
      id: 'contact-1',
      full_name: 'Ada Lovelace',
      last_contact_date: '2026-06-01T12:00:00.000Z',
      total_interactions: 7,
      tags: [{ id: 'tag-1', name: 'LP', color: '#D946A8' }],
    });
    expect(result.total).toBe(1);
    expect(result.next_cursor).toBeNull();
    expect(result.facets).toEqual({
      tags: [{ id: 'tag-1', name: 'LP', color: '#D946A8', contact_count: 1, company_count: 0 }],
      companies: [{ id: 'company-1', name: 'Analytical Engines', count: 1 }],
      filter_counts: {
        contact_type: { individual: 1 },
        engagement_status: { active: 1 },
        tags: { 'tag-1': 1 },
        overdue_followups: 0,
      },
    });

    const selectCall = fake.calls.find(call => call.kind === 'all' && call.sql.includes('SELECT c.*'));
    expect(selectCall?.sql).toContain('FROM contact_list_entries cle');
    expect(selectCall?.sql).toContain('cle.tags_json AS __tags_json');
  });

  it('uses set-based conversation and event ACL overlays for member activity data', async () => {
    const fake = createFakeEnv();
    const result = await listContactsFromReadModel(
      new Request('https://api.test/api/contacts?sort=last_contact&order=desc&limit=10'),
      fakeAuthContext('member'),
      fake.env
    );

    expect('error' in result).toBe(false);
    const selectCall = fake.calls.find(call => call.kind === 'all' && call.sql.includes('SELECT c.*'));
    expect(selectCall?.sql).toContain('FROM conversation_contacts cc');
    expect(selectCall?.sql).toContain('FROM event_attendees ea');
    expect(selectCall?.sql).toContain('COUNT(DISTINCT e.id) AS viewer_event_interactions');
    expect(selectCall?.sql).not.toContain('contact_timeline_items');
    expect(selectCall?.binds).toContain('user-1');
    expect(selectCall?.binds).toContain('shared-user');
  });
});

interface CapturedCall {
  kind: 'all' | 'first' | 'run';
  sql: string;
  binds: unknown[];
}

function fakeAuthContext(role: AuthContext['userRole']): AuthContext {
  return {
    orgId: 'org-1',
    userId: 'user-1',
    userRole: role,
    email: 'user@example.com',
  };
}

function createFakeEnv() {
  const calls: CapturedCall[] = [];
  const env = {
    D1: {
      prepare(sql: string) {
        return {
          _binds: [] as unknown[],
          bind(...binds: unknown[]) {
            this._binds = binds;
            return this;
          },
          async all() {
            calls.push({ kind: 'all', sql, binds: this._binds });
            if (sql.includes('SELECT id FROM users WHERE org_id = ? AND share_emails_org_wide = 1')) {
              return { results: [{ id: 'shared-user' }] };
            }
            if (sql.includes('SELECT c.*')) {
              return {
                results: [{
                  id: 'contact-1',
                  contact_id: 'contact-1',
                  org_id: 'org-1',
                  full_name: 'Ada Lovelace',
                  email: 'ada@example.com',
                  company_name: 'Analytical Engines',
                  contact_type: 'individual',
                  engagement_status: 'active',
                  active_deal_count: 1,
                  in_active_deals: 1,
                  __last_contact_date: '2026-06-01T12:00:00.000Z',
                  __total_interactions: 7,
                  __tags_json: JSON.stringify([{ id: 'tag-1', name: 'LP', color: '#D946A8' }]),
                  __cursor_sort_value: '2026-06-01T12:00:00.000Z',
                }],
              };
            }
            if (sql.includes('GROUP BY contact_type')) {
              return { results: [{ contact_type: 'individual', cnt: 1 }] };
            }
            if (sql.includes('GROUP BY engagement_status')) {
              return { results: [{ engagement_status: 'active', cnt: 1 }] };
            }
            if (sql.includes('FROM tags t')) {
              return { results: [{ id: 'tag-1', name: 'LP', color: '#D946A8', contact_count: 1, company_count: 0 }] };
            }
            if (sql.includes('GROUP BY ct.tag_id')) {
              return { results: [{ tag_id: 'tag-1', cnt: 1 }] };
            }
            if (sql.includes('company_id as id')) {
              return { results: [{ id: 'company-1', name: 'Analytical Engines', count: 1 }] };
            }
            return { results: [] };
          },
          async first() {
            calls.push({ kind: 'first', sql, binds: this._binds });
            if (sql.includes('COUNT(*) as n')) return { n: 1 };
            if (sql.includes('COUNT(*) as cnt')) return { cnt: 0 };
            return null;
          },
          async run() {
            calls.push({ kind: 'run', sql, binds: this._binds });
            return { meta: { changes: 0 } };
          },
        };
      },
    },
  } as any;
  return { env, calls };
}
