'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Database, Loader2, ShieldCheck } from 'lucide-react';

import { MedinaLogo } from '@/components/medina-logo';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

type PreviewLoginResponse = {
  token?: string;
  user?: {
    email?: string;
    full_name?: string | null;
  };
  details?: string;
  message?: string;
};

export default function ReadOnlyPreviewPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API_ORIGIN}/api/dev/read-only-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({} as PreviewLoginResponse));

      if (!res.ok || !data.token) {
        setError(data.message || data.details || 'Read-only preview is not available for this environment.');
        setLoading(false);
        return;
      }

      localStorage.setItem('auth_token', data.token);
      sessionStorage.setItem('entrance_played', 'true');
      router.push('/companies');
    } catch {
      setError('Unable to connect to the local API.');
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-bg-root px-4 py-8 text-text-primary">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-sm flex-col justify-center">
        <div className="mb-8 flex flex-col items-center text-center">
          <MedinaLogo size={48} className="mb-4" />
          <div className="mb-3 flex items-center gap-2 rounded-full border border-semantic-success/30 bg-semantic-success/10 px-3 py-1 text-xs font-medium text-semantic-success">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Production data, local read-only API
          </div>
          <h1 className="text-2xl font-semibold tracking-normal">Read-Only Preview</h1>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            Sign into the local UI with a production user email. The local API blocks writes while this mode is enabled.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card-panel space-y-4 p-5">
          {error && (
            <div className="rounded-lg border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-sm text-semantic-error">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="preview-email" className="mb-1.5 block text-sm text-text-secondary">
              Production user email
            </label>
            <input
              id="preview-email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-bg-input px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40"
              placeholder="you@company.com"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Database className="h-4 w-4" aria-hidden="true" />
            )}
            Open Preview
            {!loading && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
          </button>
        </form>
      </div>
    </main>
  );
}
