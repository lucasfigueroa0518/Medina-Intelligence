import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conversationAclSql, loadConversationVisibilityMap, sanitizeEmailDerivedSnapshot } from '../src/lib/email-derived-visibility';
import { buildClientAssertion, graphMailboxUrl, normalizeCertificateThumbprintForX5t } from '../src/lib/graph-auth';
import { isDelegatedGraphDeltaLink } from '../src/integrations/outlook';
import {
  getAllowedSignupDomains,
  getConfiguredInternalDomains,
  internalEmailAliasKey,
  internalEmailVariants,
  isInternalEmailDomain,
} from '../src/lib/internal-domains';
import type { AuthContext } from '../src/types/interfaces';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function decodeJwtPart(part: string): any {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(atob(b64));
}

function makeD1(rows: any[]): any {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all() {
              if (sql.includes('FROM users WHERE org_id')) return { results: [] };
              return { results: rows };
            },
          };
        },
      };
    },
  };
}

const viewerA: AuthContext = {
  orgId: 'org-1',
  userId: 'user-a',
  userRole: 'member',
  email: 'a@medinavc.com',
};

describe('shared email-derived ACL primitives', () => {
  it('allows a participant conversation and denies another user mailbox conversation', async () => {
    const env = {
      D1: makeD1([
        { id: 'conv-a', source: 'outlook', participant_user_ids: JSON.stringify(['user-a']), is_campaign_email: 0, slack_is_private: null },
        { id: 'conv-b', source: 'outlook', participant_user_ids: JSON.stringify(['user-b']), is_campaign_email: 0, slack_is_private: null },
      ]),
    } as any;

    const visibility = await loadConversationVisibilityMap(env, viewerA, ['conv-a', 'conv-b']);

    expect(visibility.get('conv-a')?.can_read).toBe(true);
    expect(visibility.get('conv-b')?.can_read).toBe(false);
  });

  it('builds an ACL SQL predicate from the same viewer inputs used by read filtering', () => {
    const acl = conversationAclSql('c', viewerA, { 'user-shared': true }, 'sc.is_private');

    expect(acl.sql).toContain('c.source =');
    expect(acl.sql).toContain('c.is_campaign_email');
    expect(acl.sql).toContain('conversation_participants');
    expect(acl.sql).not.toContain('participant_user_ids LIKE');
    expect(acl.binds).toContain('user-a');
    expect(acl.binds).toContain('user-shared');
  });

  it('removes private email-derived audit fields from timeline snapshots', () => {
    expect(sanitizeEmailDerivedSnapshot({
      title: 'Visible',
      notes: 'private note',
      source_metadata: { origin: { evidence: 'private' } },
      custom_fields: { copied: 'private' },
    })).toEqual({ title: 'Visible' });
  });
});

describe('email-derived ACL surface wiring', () => {
  it('keeps fixed read and write surfaces on the shared visibility helpers', () => {
    expect(source('src/handlers/approval.ts')).toContain('loadConversationVisibilityMap');
    expect(source('src/handlers/deals.ts')).toContain('attachLastReadableActivity');
    expect(source('src/handlers/deals.ts')).toContain('canRead && typeof origin.evidence');
    expect(source('src/lib/citations.ts')).toContain('filterCitationSourcesForViewer');
    expect(source('src/handlers/agent.ts')).toContain('included private sources you cannot read');
    expect(source('src/lib/entity-writes.ts')).toContain('private_source_taint');
    expect(source('src/lib/agent-tools.ts')).toContain('canViewerReadConversation');
    expect(source('src/handlers/deal-evidence-manual.ts')).toContain('CONVERSATION_FORBIDDEN');
    expect(source('src/handlers/conversations.ts')).toContain('conversationAclSql');
    expect(source('src/index.ts')).toContain("requireRole(ctx, ['owner', 'admin', 'super_admin'])");
    expect(source('src/lib/retrieval.ts')).toContain('topCandidates: aclFiltered');
    expect(source('src/lib/rag-v2-lexical.ts')).toContain('conversation_participants');
  });
});

describe('Outlook app-only Graph auth', () => {
  it('normalizes a hex certificate thumbprint for JWT x5t', () => {
    expect(normalizeCertificateThumbprintForX5t('00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33'))
      .toBe('ABEiM0RVZneImaq7zN3u_wARIjM');
  });

  it('builds a certificate client assertion without client_secret', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
    let binary = '';
    for (const byte of pkcs8) binary += String.fromCharCode(byte);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
    const assertion = await buildClientAssertion({
      AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
      AZURE_TENANT_ID: '00000000-0000-0000-0000-000000000002',
      AZURE_CLIENT_CERT_PRIVATE_KEY: pem,
      AZURE_CLIENT_CERT_THUMBPRINT: '00112233445566778899aabbccddeeff00112233',
    } as any, 1_700_000_000);
    const [header, payload, signature] = assertion.split('.');
    expect(signature.length).toBeGreaterThan(40);
    expect(decodeJwtPart(header)).toMatchObject({ alg: 'RS256', x5t: 'ABEiM0RVZneImaq7zN3u_wARIjM' });
    expect(decodeJwtPart(payload)).toMatchObject({ iss: '00000000-0000-0000-0000-000000000001' });
  });

  it('builds explicit per-mailbox Graph URLs', () => {
    expect(graphMailboxUrl('person@medinacapital.com', '/messages/abc')).toContain('/users/person%40medinacapital.com/messages/abc');
  });

  it('identifies old delegated /me delta links so app-only sync can restart per mailbox', () => {
    expect(isDelegatedGraphDeltaLink('https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$deltatoken=old')).toBe(true);
    expect(isDelegatedGraphDeltaLink('https://graph.microsoft.com/v1.0/users/person%40medinavc.com/mailFolders/sentitems/messages/delta?$deltatoken=new')).toBe(false);
  });
});

describe('internal domain support', () => {
  it('treats medinacapital.com as a first-class internal domain', () => {
    const domains = getConfiguredInternalDomains({ INTERNAL_DOMAINS: 'medinavc.com,medinacapital.com' } as any);

    expect(isInternalEmailDomain('ra@medinacapital.com', domains)).toBe(true);
    expect(internalEmailVariants('ra@medinacapital.com', domains)).toEqual([
      'ra@medinacapital.com',
      'ra@medinavc.com',
    ]);
    expect(internalEmailAliasKey('ra@medinacapital.com', domains)).toBe('internal:ra');
    expect(internalEmailAliasKey('ra@medinavc.com', domains)).toBe('internal:ra');
  });

  it('uses INTERNAL_DOMAINS as the signup allowlist default', () => {
    const domains = getAllowedSignupDomains({ INTERNAL_DOMAINS: 'medinavc.com,medinacapital.com' } as any);
    expect(domains.has('medinacapital.com')).toBe(true);
    expect(domains.has('medinavc.com')).toBe(true);
  });

  it('routes auth and classification code through the domain helper', () => {
    expect(source('src/handlers/auth-login.ts')).toContain('getAllowedSignupDomains');
    expect(source('src/handlers/auth-login.ts')).toContain('internalEmailVariants');
    expect(source('src/lib/internal-entity.ts')).toContain('getConfiguredInternalDomains');
    expect(source('src/lib/max-set-builder.ts')).toContain('getConfiguredInternalDomains');
  });
});
