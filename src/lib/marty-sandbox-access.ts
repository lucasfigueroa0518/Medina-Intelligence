import type { AuthContext } from '../types/interfaces';

export const MARTY_SANDBOX_VISIBLE_EMAIL = 'intel@medinavc.com';

export function canViewMartySandbox(ctx: Pick<AuthContext, 'email'>): boolean {
  return (ctx.email || '').trim().toLowerCase() === MARTY_SANDBOX_VISIBLE_EMAIL;
}
