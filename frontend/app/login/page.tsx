'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MedinaLogo } from '@/components/medina-logo';
import { EntranceAnimation } from '@/components/entrance-animation';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showEntrance, setShowEntrance] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        if (data.error === 'EMAIL_NOT_VERIFIED') {
          setUnverifiedEmail(data.email || email);
          setError('Please verify your email address before signing in.');
          setLoading(false);
          return;
        }
        setError(data.message || 'Invalid email or password');
        setLoading(false);
        return;
      }

      if (data.mfa_required === 'verify' && data.mfa_token) {
        sessionStorage.setItem('mfa_pending_token', data.mfa_token);
        router.push('/mfa/challenge');
        return;
      }

      localStorage.setItem('auth_token', data.token);

      const alreadyPlayed = sessionStorage.getItem('entrance_played');
      if (alreadyPlayed) {
        router.push('/god-mode');
      } else {
        sessionStorage.setItem('entrance_played', 'true');
        setShowEntrance(true);
      }
    } catch (err: any) {
      clearTimeout(timeout);
      setError(err?.name === 'AbortError' ? 'Request timed out. Is the server running?' : 'Unable to connect to the server');
      setLoading(false);
    }
  }

  async function handleResendVerification() {
    if (!unverifiedEmail || resending) return;
    setResending(true);
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: unverifiedEmail }),
      });
      if (res.status === 429) {
        setError('Please wait a minute before requesting another email.');
      } else {
        setResent(true);
        setError('');
      }
    } catch {
      setError('Unable to connect to the server.');
    } finally {
      setResending(false);
    }
  }

  if (showEntrance) {
    return <EntranceAnimation onComplete={() => router.push('/god-mode')} />;
  }

  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-10">
          <MedinaLogo size={48} className="mb-4" />
          <h1 className="font-display text-2xl text-text-primary">
            Medina <span className="bg-brand-gradient bg-clip-text text-transparent">Intelligence</span>
          </h1>
          <p className="text-text-muted text-sm mt-1">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-semantic-error/10 border border-semantic-error/30 rounded-lg px-4 py-3 text-sm text-semantic-error">
              {error}
            </div>
          )}

          {unverifiedEmail && !resent && (
            <button
              type="button"
              onClick={handleResendVerification}
              disabled={resending}
              className="w-full text-center text-sm text-accent-purple hover:underline disabled:opacity-50"
            >
              {resending ? 'Sending...' : 'Resend verification email'}
            </button>
          )}
          {resent && (
            <div className="bg-semantic-success/10 border border-semantic-success/30 rounded-lg px-4 py-3 text-sm text-semantic-success">
              Verification email sent. Check your inbox.
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm text-text-secondary mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
              placeholder="you@company.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm text-text-secondary mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 rounded-lg bg-brand-gradient text-white text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          <p className="text-center text-sm text-text-muted">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="text-accent-purple hover:underline">Sign up</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
