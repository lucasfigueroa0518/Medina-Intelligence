import type { AuthContext } from '../types/interfaces';
import { emailLocalPart, getConfiguredInternalDomains, isInternalEmailDomain } from './internal-domains';

export const MARTY_SANDBOX_VISIBLE_LOCAL_PART = 'intel';

export function canViewMartySandbox(ctx: Pick<AuthContext, 'email'>): boolean {
  const email = (ctx.email || '').trim().toLowerCase();
  return emailLocalPart(email) === MARTY_SANDBOX_VISIBLE_LOCAL_PART &&
    isInternalEmailDomain(email, getConfiguredInternalDomains());
}
