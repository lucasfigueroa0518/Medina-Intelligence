import { describe, expect, it } from 'vitest';
import { __maxSetTestHooks, detectMaxSetIntent } from '../src/lib/max-set-builder';

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

    expect(__maxSetTestHooks.collectEmailEntries('hunter.ager@gs.com; beatriz.ramos@bofa.com'))
      .toEqual([
        { email: 'hunter.ager@gs.com', display_name: undefined },
        { email: 'beatriz.ramos@bofa.com', display_name: undefined },
      ]);
    expect(__maxSetTestHooks.humanNameFromEmail('hunter.ager@gs.com')).toBe('Hunter Ager');
    expect(__maxSetTestHooks.humanNameFromEmail('jl@jlahoud.com')).toBeNull();
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
      named_people: ['tony@medinacapital.com', 'Raul Henriquez', 'raul@medinacapital.com'],
      artifact_kind: 'xlsx' as const,
    };
    const profile = __maxSetTestHooks.buildProfile(input);
    const plan = __maxSetTestHooks.planMaxSetJob(input, profile);

    expect(profile.includeTerms.join(' ')).not.toMatch(/\braul\b|\bhenriquez\b/);
    expect(plan.target_scope.named_people.filter((person: any) => person.role === 'inviter').length).toBe(3);
    expect(plan.membership_predicate).toMatch(/recipient/i);
    expect(plan.target_scope.date_range?.start).toContain('2026-03');
    expect(__maxSetTestHooks.inviteSubjectMatches(
      'Virtual Town Hall: Intelligent Infrastructure: AI, Quantum & the new Compute Stack - May 7th at 10 AM',
      profile
    )).toBe(true);
    expect(__maxSetTestHooks.inviteSubjectMatches(
      'Re: MEDINA VENTURES FUND, LP - Commitment Summary for approval - 03-05-26',
      profile
    )).toBe(false);
    expect(__maxSetTestHooks.inviteSubjectMatches(
      'Medina Virtual Town Hall follow-up // Intelligent Infrastructure',
      profile
    )).toBe(false);
    expect(__maxSetTestHooks.inviteSubjectMatches(
      'Intelligent Infrastructure Town Hall - Attendee Report | May 7, 2026',
      profile
    )).toBe(false);
    expect(__maxSetTestHooks.inviteSubjectMatches(
      'Undeliverable: Virtual Town Hall: Intelligent Infrastructure: AI, Quantum & the new Compute Stack - May 7th at 10 AM',
      profile
    )).toBe(false);
    expect(__maxSetTestHooks.inviteDocumentMatches({
      title: 'Intelligent Infrastructure Webinar - Mail Merge (May 7, 2026)',
      file_name: 'Intelligent Infrastructure Webinar - Mail Merge (May 7, 2026).xlsx',
      document_type: 'spreadsheet',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extracted_text_preview: 'Sheet: Results\\nfirst_name,email\\nAnna,anna@example.com',
    }, profile)).toBe(true);
    expect(__maxSetTestHooks.inviteDocumentMatches({
      title: 'Medina Ventures Intelligent Infrastructure Town Hall Deck',
      file_name: 'Medina Ventures Intelligent Infrastructure Town Hall Deck.pdf',
      document_type: 'reference',
      mime_type: 'application/pdf',
      extracted_text_preview: '',
    }, profile)).toBe(false);
  });

  it('suppresses artifacts when invite authoritative sources fail or produce no valid candidates', () => {
    const input = {
      query: 'List everyone Raul invited to the Intelligent Infrastructure webinar on May 7, 2026',
      task_type: 'invite_roster' as const,
      entity_kind: 'person' as const,
      named_people: ['Raul Henriquez', 'raul@medinacapital.com'],
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

  it('keeps ranked candidate slates out of exhaustive MAX set detection', () => {
    const slate = detectMaxSetIntent(
      'I want to put together a roundtable of people in quantum. Who are our heaviest hitters? I want 8-10 people but find more than that.'
    );
    expect(slate.shouldBuild).toBe(false);
    expect(slate.reason).toMatch(/candidate_slate/i);

    const exhaustive = detectMaxSetIntent(
      'List every startup we have ever talked to that is involved in Quantum'
    );
    expect(exhaustive.shouldBuild).toBe(true);
    expect(exhaustive.input?.task_type).toBe('entity_theme_set');
  });
});
