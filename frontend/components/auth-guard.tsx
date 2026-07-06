'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { MedinaLogo } from '@/components/medina-logo';
import { AppShellSkeleton } from '@/components/app-shell-skeleton';
import type { UserProfile } from '@/lib/api';

const TOKEN_KEY = 'auth_token';
const PUBLIC_PATHS = ['/login', '/signup', '/mfa', '/auth'];
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';
const AUTH_CHECK_TIMEOUT_MS = 8000;

type GuardState = 'loading' | 'authenticated' | 'unauthenticated' | 'unverified';

export type AuthSessionUser = UserProfile;

interface AuthSessionContextValue {
  user: AuthSessionUser | null;
  warnings: any[];
  status: GuardState;
  isAdmin: boolean;
  refresh: () => Promise<void>;
}

const AuthSessionContext = React.createContext<AuthSessionContextValue | null>(null);

export function useAuthSession(): AuthSessionContextValue {
  const ctx = React.useContext(AuthSessionContext);
  if (!ctx) throw new Error('useAuthSession must be used within AuthGuard');
  return ctx;
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isPublicPath = PUBLIC_PATHS.some(p => pathname.startsWith(p));
  const [state, setState] = useState<GuardState>('loading');
  const [user, setUser] = useState<AuthSessionUser | null>(null);
  const [warnings, setWarnings] = useState<any[]>([]);
  const [userEmail, setUserEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState('');

  const checkAuth = useCallback(async () => {
    if (isPublicPath) {
      setUser(null);
      setWarnings([]);
      setState('authenticated');
      return;
    }

    const token = localStorage.getItem(TOKEN_KEY);
    if (!token || token === 'undefined' || token === 'null') {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      setWarnings([]);
      setState('unauthenticated');
      return;
    }

    try {
      const res = await fetchWithTimeout(`${API_ORIGIN}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      }, AUTH_CHECK_TIMEOUT_MS);

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        setWarnings([]);
        setState('unauthenticated');
        return;
      }

      const data = await res.json().catch(() => ({} as any));
      const nextWarnings = Array.isArray(data.warnings) ? data.warnings : [];
      setWarnings(nextWarnings);

      if (data.user && !data.user.email_verified) {
        setUser(data.user);
        setUserEmail(data.user.email || '');
        setState('unverified');
        return;
      }

      if (!res.ok) {
        if (data.error === 'EMAIL_NOT_VERIFIED') {
          setUser(data.user ?? null);
          setUserEmail('');
          setState('unverified');
          return;
        }
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        setWarnings([]);
        setState('unauthenticated');
        return;
      }

      setUser(data.user ?? null);
      setState('authenticated');
    } catch {
      setUser(null);
      setWarnings([]);
      setState('authenticated');
    }
  }, [isPublicPath]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const handler = () => router.replace('/login');
    const verifyHandler = () => setState('unverified');
    window.addEventListener('auth:session-expired', handler);
    window.addEventListener('auth:email-not-verified', verifyHandler);
    return () => {
      window.removeEventListener('auth:session-expired', handler);
      window.removeEventListener('auth:email-not-verified', verifyHandler);
    };
  }, [router]);

  useEffect(() => {
    if (state === 'unauthenticated' && !isPublicPath) {
      router.replace('/login');
    }
  }, [isPublicPath, router, state]);

  const sessionValue = React.useMemo<AuthSessionContextValue>(() => {
    const role = user?.role;
    return {
      user,
      warnings,
      status: state,
      isAdmin: role === 'super_admin' || role === 'owner' || role === 'admin',
      refresh: checkAuth,
    };
  }, [checkAuth, state, user, warnings]);

  // While the auth check resolves, paint an instant app-shell skeleton for
  // protected paths instead of a blank/logo-only screen (worse on a Worker cold
  // start). Public paths short-circuit checkAuth to 'authenticated' in the same
  // tick, so they keep the minimal logo screen and never flash the shell.
  // SECURITY: the skeleton renders placeholders only — no children, no
  // protected data — so the gate still fully controls when real content mounts.
  if (state === 'loading') {
    return isPublicPath ? <AuthLoadingScreen /> : <AppShellSkeleton />;
  }

  if (state === 'unauthenticated') {
    if (!isPublicPath) return null;
    return (
      <AuthSessionContext.Provider value={sessionValue}>
        {children}
      </AuthSessionContext.Provider>
    );
  }

  if (state === 'unverified') {
    return (
      <AuthSessionContext.Provider value={sessionValue}>
        <EmailVerificationLockout
          email={userEmail}
          resending={resending}
          resent={resent}
          resendError={resendError}
          onResend={async () => {
            if (!userEmail || resending) return;
            setResending(true);
            setResendError('');
            try {
              const res = await fetch(`${API_ORIGIN}/api/auth/resend-verification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: userEmail }),
              });
              if (res.status === 429) {
                setResendError('Please wait a minute before requesting another email.');
              } else {
                setResent(true);
              }
            } catch {
              setResendError('Unable to connect to the server.');
            } finally {
              setResending(false);
            }
          }}
          onLogout={() => {
            localStorage.removeItem(TOKEN_KEY);
            router.replace('/login');
          }}
        />
      </AuthSessionContext.Provider>
    );
  }

  return (
    <AuthSessionContext.Provider value={sessionValue}>
      {children}
    </AuthSessionContext.Provider>
  );
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function AuthLoadingScreen() {
  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="flex flex-col items-center gap-4">
        <MedinaLogo size={52} />
        <div className="card-panel flex items-center gap-3 px-4 py-3 text-sm text-text-secondary">
          <span className="h-2 w-2 rounded-full bg-accent-magenta animate-pulse" aria-hidden="true" />
          <span>Loading Medina...</span>
        </div>
      </div>
    </div>
  );
}

function EmailVerificationLockout({
  email,
  resending,
  resent,
  resendError,
  onResend,
  onLogout,
}: {
  email: string;
  resending: boolean;
  resent: boolean;
  resendError: string;
  onResend: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <div className="flex flex-col items-center mb-8">
          <MedinaLogo size={56} className="mb-5" />
          <h1 className="font-display text-2xl text-text-primary">
            Verify your email
          </h1>
        </div>

        <div className="bg-bg-card border border-border rounded-xl p-8 space-y-5">
          <div className="w-20 h-20 mx-auto rounded-full bg-accent-purple/10 flex items-center justify-center">
            <svg className="w-10 h-10 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>

          <div className="space-y-2">
            <p className="text-text-primary font-medium text-lg">Account locked</p>
            <p className="text-text-secondary text-sm">
              You must verify your email address before accessing Medina Intelligence.
            </p>
            {email && (
              <p className="text-text-secondary text-sm">
                We sent a verification link to{' '}
                <span className="text-text-primary font-medium">{email}</span>.
              </p>
            )}
          </div>

          <div className="bg-bg-elevated/50 rounded-lg p-4 text-left space-y-2">
            <p className="text-text-muted text-xs font-medium uppercase tracking-wide">Next steps</p>
            <ol className="text-text-secondary text-sm space-y-1 list-decimal list-inside">
              <li>Check your inbox (and spam folder)</li>
              <li>Click the verification link in the email</li>
              <li>Come back here and sign in</li>
            </ol>
          </div>

          {resendError && (
            <div className="bg-semantic-error/10 border border-semantic-error/30 rounded-lg px-4 py-2.5 text-sm text-semantic-error">
              {resendError}
            </div>
          )}

          {resent ? (
            <div className="bg-semantic-success/10 border border-semantic-success/30 rounded-lg px-4 py-2.5 text-sm text-semantic-success">
              Verification email sent. Check your inbox.
            </div>
          ) : (
            <button
              onClick={onResend}
              disabled={resending || !email}
              className="w-full py-2.5 rounded-lg bg-brand-gradient text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resending ? 'Sending...' : 'Resend verification email'}
            </button>
          )}

          <button
            onClick={onLogout}
            className="w-full py-2.5 rounded-lg border border-border text-text-secondary text-sm hover:bg-bg-elevated transition-colors"
          >
            Sign out
          </button>

          <p className="text-text-muted text-xs">
            The verification link expires in 24 hours.
          </p>
        </div>
      </div>
    </div>
  );
}
