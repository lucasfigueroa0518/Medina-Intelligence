'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MedinaLogo } from '@/components/medina-logo';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';
const ALLOWED_DOMAIN = 'medinavc.com';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!email.toLowerCase().endsWith('@' + ALLOWED_DOMAIN)) {
      setError(`Signup is restricted to @${ALLOWED_DOMAIN} email addresses.`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, full_name: fullName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as any));
        const code = data.error as string | undefined;
        const friendly: Record<string, string> = {
          DOMAIN_NOT_ALLOWED: `Signup is restricted to @${ALLOWED_DOMAIN} email addresses.`,
          EMAIL_EXISTS: 'An account with that email already exists. Try signing in instead.',
          WEAK_PASSWORD: 'Password must be at least 8 characters.',
          MISSING_FIELDS: 'Please fill in every field.',
          SIGNUP_DISABLED: 'Signup is not configured on the server (missing DEFAULT_SIGNUP_ORG_ID).',
        };
        setError(friendly[code ?? ''] || data.details || code || `Signup failed (${res.status})`);
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (data.verification_pending) {
        router.push(`/auth/check-email?email=${encodeURIComponent(data.email || email)}`);
        return;
      }
      localStorage.setItem('auth_token', data.token);
      router.push('/god-mode');
    } catch {
      setError('Unable to connect to the server');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-10">
          <MedinaLogo size={48} className="mb-4" />
          <h1 className="font-display text-2xl text-text-primary">
            Medina <span className="bg-brand-gradient bg-clip-text text-transparent">Intelligence</span>
          </h1>
          <p className="text-text-muted text-sm mt-1">Create your account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-semantic-error/10 border border-semantic-error/30 rounded-lg px-4 py-3 text-sm text-semantic-error">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="full_name" className="block text-sm text-text-secondary mb-1.5">Full name</label>
            <input id="full_name" type="text" required autoFocus
              value={fullName} onChange={e => setFullName(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
              placeholder="Jane Doe" />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm text-text-secondary mb-1.5">Email</label>
            <input id="email" type="email" required autoComplete="email"
              value={email} onChange={e => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
              placeholder={`you@${ALLOWED_DOMAIN}`} />
            <p className="text-[11px] text-text-muted mt-1">Only @{ALLOWED_DOMAIN} addresses are allowed.</p>
          </div>

          <div>
            <label htmlFor="password" className="block text-sm text-text-secondary mb-1.5">Password</label>
            <input id="password" type="password" required autoComplete="new-password"
              value={password} onChange={e => setPassword(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
              placeholder="At least 8 characters" />
          </div>

          <div>
            <label htmlFor="confirm" className="block text-sm text-text-secondary mb-1.5">Confirm password</label>
            <input id="confirm" type="password" required autoComplete="new-password"
              value={confirm} onChange={e => setConfirm(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
              placeholder="Repeat your password" />
          </div>

          <button type="submit" disabled={loading}
            className="w-full h-10 rounded-lg bg-brand-gradient text-white text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
            {loading ? 'Creating account...' : 'Create account'}
          </button>

          <p className="text-center text-sm text-text-muted">
            Already have an account?{' '}
            <Link href="/login" className="text-accent-purple hover:underline">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
