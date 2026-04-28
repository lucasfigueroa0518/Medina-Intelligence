'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { MedinaLogo } from '@/components/medina-logo';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function CheckEmailPage() {
  const params = useSearchParams();
  const email = params.get('email') || '';
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState('');

  async function handleResend() {
    if (!email || resending) return;
    setResending(true);
    setError('');
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.status === 429) {
        setError('Please wait a minute before requesting another email.');
      } else {
        setResent(true);
      }
    } catch {
      setError('Unable to connect to the server.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <div className="flex flex-col items-center mb-8">
          <MedinaLogo size={48} className="mb-4" />
          <h1 className="font-display text-2xl text-text-primary">Check your inbox</h1>
        </div>

        <div className="bg-bg-card border border-border rounded-xl p-6 space-y-4">
          <div className="w-16 h-16 mx-auto rounded-full bg-accent-purple/10 flex items-center justify-center">
            <svg className="w-8 h-8 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
          </div>

          <p className="text-text-secondary text-sm">
            We sent a verification link to{' '}
            {email ? <span className="text-text-primary font-medium">{email}</span> : 'your email address'}.
          </p>
          <p className="text-text-muted text-xs">
            Click the link in the email to verify your account. The link expires in 24 hours.
          </p>

          {error && (
            <div className="bg-semantic-error/10 border border-semantic-error/30 rounded-lg px-3 py-2 text-xs text-semantic-error">
              {error}
            </div>
          )}

          {resent ? (
            <p className="text-semantic-success text-xs">Verification email resent.</p>
          ) : (
            <button
              onClick={handleResend}
              disabled={resending || !email}
              className="text-accent-purple text-sm hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resending ? 'Sending...' : "Didn't receive it? Resend"}
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
