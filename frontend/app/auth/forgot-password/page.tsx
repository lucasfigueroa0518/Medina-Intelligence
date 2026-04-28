'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { MedinaLogo } from '@/components/medina-logo';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_RESENDS = 3;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [sendCount, setSendCount] = useState(0);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown(c => c - 1), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const submit = useCallback(async () => {
    if (!email || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setError('Something went wrong. Please try again.');
        setLoading(false);
        return;
      }
      setSent(true);
      setSendCount(c => c + 1);
      setCooldown(60);
    } catch {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [email, loading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit();
  }

  async function handleResend() {
    if (cooldown > 0 || sendCount >= MAX_RESENDS) return;
    await submit();
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center">
          <div className="flex flex-col items-center mb-8">
            <MedinaLogo size={48} className="mb-4" />
            <h1 className="font-display text-2xl text-text-primary">Check your email</h1>
          </div>

          <div className="bg-bg-card border border-border rounded-xl p-6 space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-accent-purple/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
            </div>

            <p className="text-text-secondary text-sm">
              If an account exists for <span className="text-text-primary font-medium">{email}</span>, we&apos;ve sent a password reset link.
            </p>
            <p className="text-text-muted text-xs">The link expires in 1 hour.</p>

            {sendCount >= MAX_RESENDS ? (
              <p className="text-text-muted text-xs">Still not receiving it? Contact your administrator.</p>
            ) : cooldown > 0 ? (
              <p className="text-text-muted text-xs">Send again in {cooldown}s</p>
            ) : (
              <button
                onClick={handleResend}
                disabled={loading}
                className="text-accent-purple text-sm hover:underline disabled:opacity-50"
              >
                {loading ? 'Sending...' : "Didn't receive it? Send again"}
              </button>
            )}
          </div>

          <p className="text-text-muted text-sm mt-6">
            <Link href="/login" className="text-accent-purple hover:underline">Back to sign in</Link>
          </p>
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
          <p className="text-text-muted text-sm mt-1">Reset your password</p>
          <p className="text-text-muted text-xs mt-1">Enter your email and we&apos;ll send you a reset link.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-semantic-error/10 border border-semantic-error/30 rounded-lg px-4 py-3 text-sm text-semantic-error">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm text-text-secondary mb-1.5">Email</label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
              placeholder="you@company.com"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 rounded-lg bg-brand-gradient text-white text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Sending...' : 'Send Reset Link'}
          </button>

          <p className="text-center text-sm text-text-muted">
            Remember your password?{' '}
            <Link href="/login" className="text-accent-purple hover:underline">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
