import { describe, expect, it } from 'vitest';
import { requireAuth, signJwt } from '../src/handlers/auth';

function makeEnv(userRow: any): any {
  return {
    JWT_SECRET: 'test-secret',
    D1: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return userRow;
              },
            };
          },
        };
      },
    },
  };
}

describe('auth middleware', () => {
  it('uses the current D1 role instead of a stale JWT role claim', async () => {
    const env = makeEnv({
      id: 'user-intel',
      org_id: 'org-1',
      email: 'intel@medinavc.com',
      role: 'member',
      email_verified: 1,
      is_active: 1,
    });
    const token = await signJwt({
      sub: 'user-intel',
      org_id: 'org-1',
      role: 'super_admin',
      email: 'intel@medinavc.com',
    }, env);

    const result = await requireAuth(new Request('https://example.com/api/admin', {
      headers: { Authorization: `Bearer ${token}` },
    }), env);

    expect(result).toMatchObject({
      userId: 'user-intel',
      orgId: 'org-1',
      userRole: 'member',
      email: 'intel@medinavc.com',
    });
  });
});
