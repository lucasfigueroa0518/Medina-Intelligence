'use client';

import React from 'react';
import Link from 'next/link';
import { MedinaLogo } from '@/components/medina-logo';

export default function VerifiedPage() {
  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <div className="flex flex-col items-center mb-8">
          <MedinaLogo size={48} className="mb-4" />
          <h1 className="font-display text-2xl text-text-primary">
            Email <span className="bg-brand-gradient bg-clip-text text-transparent">Verified</span>
          </h1>
        </div>

        <div className="bg-bg-card border border-border rounded-xl p-6 space-y-4">
          <div className="w-16 h-16 mx-auto rounded-full bg-semantic-success/10 flex items-center justify-center">
            <svg className="w-8 h-8 text-semantic-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-text-secondary text-sm">
            Your email has been verified. You can now sign in to your account.
          </p>
          <Link
            href="/login"
            className="inline-block w-full py-2.5 rounded-lg bg-brand-gradient text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
