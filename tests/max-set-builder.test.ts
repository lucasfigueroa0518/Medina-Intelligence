import { describe, expect, it } from 'vitest';
import { __maxSetTestHooks } from '../src/lib/max-set-builder';

describe('MAX set builder contracts', () => {
  it('parses email recipients from strings and JSON-shaped Outlook fields', () => {
    const parsed = __maxSetTestHooks.collectEmailEntries(
      JSON.stringify([
        { emailAddress: { name: 'Jane Investor', address: 'Jane@Example.com' } },
        { name: 'Bob Builder', email: 'bob@build.co' },
      ])
    );

    expect(parsed).toEqual([
      { email: 'jane@example.com', display_name: 'Jane Investor' },
      { email: 'bob@build.co', display_name: 'Bob Builder' },
    ]);

    expect(__maxSetTestHooks.collectEmailEntries('Alice Example <alice@example.com>; raw@example.org'))
      .toEqual([
        { email: 'alice@example.com', display_name: 'Alice Example' },
        { email: 'raw@example.org', display_name: undefined },
      ]);
  });

  it('uses safe invite-roster defaults that do not let generic events or contacts generate candidates', () => {
    expect(__maxSetTestHooks.defaultSourceFamilies('invite_roster')).toEqual([
      'communications',
      'campaigns',
      'documents',
    ]);

    const policy = __maxSetTestHooks.sourcePolicyForTask('invite_roster');
    expect(policy.authoritative).toEqual(['communications', 'campaigns', 'documents']);
    expect(policy.disallowed_candidate_sources).toEqual(['events', 'contacts']);
  });

  it('treats invite named people as inviter constraints instead of broad include terms', () => {
    const input = {
      query: 'Pull all names and emails myself or Raul invited to the Intelligent Infrastructure webinar on May 7, 2026',
      task_type: 'invite_roster' as const,
      entity_kind: 'person' as const,
      named_people: ['tony@medinavc.com', 'Raul Henriquez', 'raul@medinavc.com'],
      artifact_kind: 'xlsx' as const,
    };
    const profile = __maxSetTestHooks.buildProfile(input);
    const plan = __maxSetTestHooks.planMaxSetJob(input, profile);

    expect(profile.includeTerms.join(' ')).not.toMatch(/\braul\b|\bhenriquez\b/);
    expect(plan.target_scope.named_people.filter((person: any) => person.role === 'inviter').length).toBe(3);
    expect(plan.membership_predicate).toMatch(/recipient/i);
    expect(plan.target_scope.date_range?.start).toContain('2026-03');
  });

  it('suppresses artifacts when invite authoritative sources fail or produce no valid candidates', () => {
    const input = {
      query: 'List everyone Raul invited to the Intelligent Infrastructure webinar on May 7, 2026',
      task_type: 'invite_roster' as const,
      entity_kind: 'person' as const,
      named_people: ['Raul Henriquez', 'raul@medinavc.com'],
      artifact_kind: 'xlsx' as const,
    };
    const profile = __maxSetTestHooks.buildProfile(input);
    const plan = __maxSetTestHooks.planMaxSetJob(input, profile);
    const quality = __maxSetTestHooks.evaluateMaxSetQuality(
      plan,
      [
        { source_family: 'communications', role: 'authoritative', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: ['D1_ERROR: too many SQL variables'] },
        { source_family: 'documents', role: 'authoritative', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: ['D1_ERROR: too many SQL variables'] },
        { source_family: 'events', role: 'disallowed', rows_scanned: 485, rows_returned: 485, candidates_added: 616, cap_hit: false, errors: ['events is disallowed'] },
      ] as any,
      { confirmed: [], probable: [], needs_review: [] },
      []
    );

    expect(quality.status).toBe('unsafe_incomplete');
    expect(quality.artifact_allowed).toBe(false);
    expect(quality.reasons.join(' ')).toMatch(/Authoritative source errors|No authoritative source/);
  });

  it('chunks large D1 ID lists below the safe bind-size threshold', () => {
    const chunks = __maxSetTestHooks.chunkArray(Array.from({ length: 123 }, (_, i) => `id-${i}`));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk: string[]) => chunk.length <= 50)).toBe(true);
  });
});
