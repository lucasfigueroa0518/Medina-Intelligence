import { describe, expect, it } from 'vitest';
import {
  emailDomain,
  evaluateContactCompanyAffiliation,
  normalizeDomain,
} from '../src/lib/contact-company-affiliation';

describe('contact-company affiliation guard', () => {
  it('verifies employment only when the email domain matches the company domain', () => {
    const evidence = evaluateContactCompanyAffiliation(
      { email: 'rk@boynecapital.com' },
      { name: 'Boyne Capital', domain: 'boynecapital.com' }
    );
    expect(evidence.verified).toBe(true);
    expect(evidence.reason).toBe('domain_match');
  });

  it('rejects nearby investor contacts whose corporate domain is different', () => {
    const evidence = evaluateContactCompanyAffiliation(
      { email: 'bling@blingcap.com' },
      { name: 'Boyne Capital', domain: 'boynecapital.com' }
    );
    expect(evidence.verified).toBe(false);
    expect(evidence.reason).toBe('domain_mismatch');
  });

  it('rejects personal emails as company-employment evidence', () => {
    const evidence = evaluateContactCompanyAffiliation(
      { email: 'person@gmail.com' },
      { name: 'Boyne Capital', domain: 'boynecapital.com' }
    );
    expect(evidence.verified).toBe(false);
    expect(evidence.reason).toBe('personal_email_domain');
  });

  it('normalizes websites and email subdomains to registrable domains', () => {
    expect(normalizeDomain('https://www.boynecapital.com/team')).toBe('boynecapital.com');
    expect(emailDomain('roman@mail.boynecapital.com')).toBe('boynecapital.com');
  });
});
