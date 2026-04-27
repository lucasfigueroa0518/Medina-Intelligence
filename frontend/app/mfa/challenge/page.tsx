'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MedinaLogo } from '@/components/medina-logo';
import { setAuthToken } from '@/lib/api';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function MfaChallengePage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const mfaToken = typeof window !== 'undefined' ? sessionStorage.getItem('mfa_pending_token') : null;
    if (!mfaToken) {
      router.replace('/login');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mfaToken}` },
        body: JSON.stringify(recoveryMode ? { recovery_code: code.trim() } : { code: code.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 423) setError('Too many attempts. Try again in 15 minutes.');
        else if (res.status === 401) {
          if (data.error === 'MFA_TOKEN_INVALID') {
            sessionStorage.removeItem('mfa_pending_token');
            router.replace('/login');
            return;
          }
          setError(recoveryMode ? 'Invalid recovery code' : 'Invalid code');
        } else setError(data.message || 'Verification failed');
        setLoading(false);
        return;
      }
      const data = await res.json();
      sessionStorage.removeItem('mfa_pending_token');
      setAuthToken(data.token);
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
          <h1 className="font-display text-2xl text-text-primary">Two-factor authentication</h1>
          <p className="text-text-muted text-sm mt-1">
            {recoveryMode ? 'Enter a recovery code' : 'Enter the 6-digit code from your authenticator app'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-semantic-error/10 border border-semantic-error/30 rounded-lg px-4 py-3 text-sm text-semantic-error">
              {error}
            </div>
          )}

          <input
            type="text"
            inputMode={recoveryMode ? 'text' : 'numeric'}
            autoFocus
            autoComplete="one-time-code"
            value={code}
            onChange={e => setCode(e.target.value)}
            className="w-full h-12 px-3 rounded-lg bg-bg-input border border-border text-text-primary text-center font-mono tracking-widest text-lg placeholder:text-text-muted focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/40 transition-colors"
            placeholder={recoveryMode ? 'xxxxx-xxxxx' : '000000'}
            maxLength={recoveryMode ? 11 : 6}
          />

          <button type="submit" disabled={loading || code.length === 0}
            className="w-full h-10 rounded-lg bg-brand-gradient text-white text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
            {loading ? 'Verifying...' : 'Verify'}
          </button>

          <button type="button" onClick={() => { setRecoveryMode(m => !m); setCode(''); setError(''); }}
            className="w-full text-center text-sm text-accent-purple hover:underline">
            {recoveryMode ? 'Use authenticator code instead' : 'Use a recovery code'}
          </button>
        </form>
      </div>
    </div>
  );
}
