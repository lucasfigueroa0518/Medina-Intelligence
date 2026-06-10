'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { MedinaLogo } from '@/components/medina-logo';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

type VerifyState = 'loading' | 'success' | 'error';

export default function VerifyPage() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token');
  const [state, setState] = useState<VerifyState>('loading');
  const [message, setMessage] = useState('');
  const [errorCode, setErrorCode] = useState('');

  useEffect(() => {
    if (!token) {
      setState('error');
      setMessage('No verification token provided.');
      return;
    }

    (async () => {
      try {
        const res = await fetch(`${API_ORIGIN}/api/auth/verify?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (data.ok) {
          setState('success');
          setMessage(data.message || 'Email verified successfully.');
          setTimeout(() => router.push('/auth/verified'), 1500);
        } else {
          setState('error');
          setErrorCode(data.error || '');
          setMessage(data.message || 'Verification failed.');
        }
      } catch {
        setState('error');
        setMessage('Unable to connect to the server.');
      }
    })();
  }, [token, router]);

  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <div className="flex flex-col items-center mb-8">
          <MedinaLogo size={48} className="mb-4" />
        </div>

        <div className="card-panel p-6 space-y-4">
          {state === 'loading' && (
            <>
              <div className="w-8 h-8 mx-auto border-2 border-accent-purple border-t-transparent rounded-full animate-spin" />
              <p className="text-text-secondary text-sm">Verifying your email...</p>
            </>
          )}

          {state === 'success' && (
            <>
              <div className="w-16 h-16 mx-auto rounded-full bg-semantic-success/10 flex items-center justify-center">
                <svg className="w-8 h-8 text-semantic-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <p className="text-text-primary font-medium">{message}</p>
              <p className="text-text-muted text-xs">Redirecting to sign in...</p>
            </>
          )}

          {state === 'error' && (
            <>
              <div className="w-16 h-16 mx-auto rounded-full bg-semantic-error/10 flex items-center justify-center">
                <svg className="w-8 h-8 text-semantic-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <p className="text-text-primary font-medium">Verification failed</p>
              <p className="text-text-secondary text-sm">{message}</p>
              {errorCode === 'TOKEN_EXPIRED' && (
                <p className="text-text-muted text-xs">
                  Sign in to request a new verification link.
                </p>
              )}
              {errorCode === 'ALREADY_VERIFIED' && (
                <button
                  onClick={() => router.push('/login')}
                  className="mt-2 px-4 py-2 rounded-lg bg-brand-gradient text-white text-sm font-medium hover:opacity-90"
                >
                  Go to Sign In
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
