'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { MedinaLogo } from '@/components/medina-logo';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

type PageState = 'form' | 'loading' | 'success' | 'error';

interface PasswordChecks {
  length: boolean;
  uppercase: boolean;
  lowercase: boolean;
  number: boolean;
}

function checkPassword(pw: string): PasswordChecks {
  return {
    length: pw.length >= 8,
    uppercase: /[A-Z]/.test(pw),
    lowercase: /[a-z]/.test(pw),
    number: /[0-9]/.test(pw),
  };
}

function CheckItem({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 text-xs ${met ? 'text-semantic-success' : 'text-text-muted'}`}>
      {met ? (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      )}
      {label}
    </li>
  );
}

export default function ResetPasswordPage() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [state, setState] = useState<PageState>('form');
  const [errorMsg, setErrorMsg] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [countdown, setCountdown] = useState(5);

  const checks = useMemo(() => checkPassword(password), [password]);
  const allMet = checks.length && checks.uppercase && checks.lowercase && checks.number;
  const passwordsMatch = password === confirm;
  const canSubmit = allMet && passwordsMatch && confirm.length > 0;

  useEffect(() => {
    if (state !== 'success') return;
    if (countdown <= 0) {
      router.push('/login');
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [state, countdown, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setState('loading');

    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({} as any));

      if (data.ok) {
        setState('success');
        return;
      }

      setErrorCode(data.error || '');
      setErrorMsg(data.message || 'Something went wrong. Please try again.');
      setState('error');
    } catch {
      setErrorMsg('Unable to reach the server. Please try again.');
      setState('error');
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center">
          <MedinaLogo size={48} className="mb-6 mx-auto" />
          <div className="card-panel p-6 space-y-4">
            <p className="text-text-primary font-medium">Invalid reset link</p>
            <p className="text-text-secondary text-sm">No reset token was provided.</p>
            <Link
              href="/auth/forgot-password"
              className="inline-block w-full py-2.5 rounded-lg bg-brand-gradient text-white text-sm font-medium hover:opacity-90"
            >
              Request a new link
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center">
          <MedinaLogo size={48} className="mb-6 mx-auto" />
          <div className="card-panel p-6 space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-semantic-success/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-semantic-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-text-primary font-medium text-lg">Password updated</p>
            <p className="text-text-secondary text-sm">Your password has been reset. You can now sign in with your new password.</p>
            <Link
              href="/login"
              className="inline-block w-full py-2.5 rounded-lg bg-brand-gradient text-white text-sm font-medium hover:opacity-90"
            >
              Sign In
            </Link>
            <p className="text-text-muted text-xs">Redirecting to sign in in {countdown}...</p>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    const showRequestNew = ['INVALID_TOKEN', 'TOKEN_USED', 'TOKEN_EXPIRED'].includes(errorCode);
    return (
      <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center">
          <MedinaLogo size={48} className="mb-6 mx-auto" />
          <div className="card-panel p-6 space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-semantic-error/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-semantic-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-text-primary font-medium">{errorMsg}</p>
            {showRequestNew ? (
              <Link
                href="/auth/forgot-password"
                className="inline-block w-full py-2.5 rounded-lg bg-brand-gradient text-white text-sm font-medium hover:opacity-90"
              >
                Request a new link
              </Link>
            ) : (
              <button
                onClick={() => setState('form')}
                className="w-full py-2.5 rounded-lg bg-brand-gradient text-white text-sm font-medium hover:opacity-90"
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-10">
          <MedinaLogo size={48} className="mb-4" />
          <h1 className="font-display text-2xl text-text-primary">
            Medina <span className="bg-brand-gradient bg-clip-text text-transparent">Intelligence</span>
          </h1>
          <p className="text-text-muted text-sm mt-1">Set new password</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="block text-sm text-text-secondary mb-1.5">New password</label>
            <div className="relative">
              <input
                id="password"
                type={showPw ? 'text' : 'password'}
                required
                autoFocus
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full h-10 px-3 pr-10 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
                placeholder="Enter new password"
              />
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                tabIndex={-1}
              >
                {showPw ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="confirm" className="block text-sm text-text-secondary mb-1.5">Confirm password</label>
            <div className="relative">
              <input
                id="confirm"
                type={showConfirm ? 'text' : 'password'}
                required
                autoComplete="new-password"
                value={confirm}
                onChange={e => { setConfirm(e.target.value); setConfirmTouched(true); }}
                className={`w-full h-10 px-3 pr-10 rounded-lg bg-bg-input border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 transition-colors ${
                  confirmTouched && !passwordsMatch && confirm.length > 0
                    ? 'border-semantic-error focus:border-semantic-error focus:ring-semantic-error/40'
                    : 'border-border focus:border-accent-purple focus:ring-accent-purple/40'
                }`}
                placeholder="Repeat new password"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                tabIndex={-1}
              >
                {showConfirm ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
            </div>
            {confirmTouched && !passwordsMatch && confirm.length > 0 && (
              <p className="text-xs text-semantic-error mt-1">Passwords don&apos;t match</p>
            )}
          </div>

          <ul className="space-y-1 pt-1">
            <CheckItem met={checks.length} label="At least 8 characters" />
            <CheckItem met={checks.uppercase} label="One uppercase letter" />
            <CheckItem met={checks.lowercase} label="One lowercase letter" />
            <CheckItem met={checks.number} label="One number" />
          </ul>

          <button
            type="submit"
            disabled={!canSubmit || state === 'loading'}
            className="w-full h-10 rounded-lg bg-brand-gradient text-white text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {state === 'loading' ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
