'use client';

import React from 'react';

interface EntranceAnimationProps {
  onComplete: () => void;
}

export function EntranceAnimation({ onComplete }: EntranceAnimationProps) {
  const [phase, setPhase] = React.useState<'dark' | 'logo' | 'text' | 'fadeout' | 'done'>('dark');

  React.useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(setTimeout(() => setPhase('logo'), 200));
    timers.push(setTimeout(() => setPhase('text'), 1200));
    timers.push(setTimeout(() => setPhase('fadeout'), 2400));
    timers.push(setTimeout(() => {
      setPhase('done');
      onComplete();
    }, 3000));

    // Failsafe
    timers.push(setTimeout(() => {
      onComplete();
    }, 4000));

    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  if (phase === 'done') return null;

  const showLogo = phase !== 'dark';
  const showText = phase === 'text' || phase === 'fadeout';
  const isFading = phase === 'fadeout';

  return (
    <div
      className="entrance-overlay"
      style={{
        opacity: isFading ? 0 : 1,
        transform: isFading ? 'scale(1.05)' : 'scale(1)',
        transition: isFading ? 'opacity 600ms ease-in-out, transform 600ms ease-in-out' : 'none',
      }}
    >
      <div className="entrance-content">
        {/* Logo container */}
        <div
          className="entrance-logo-wrap"
          style={{
            opacity: showLogo ? 1 : 0,
            transform: showLogo
              ? (phase === 'text' || phase === 'fadeout' ? 'scale(1.15)' : 'scale(1)')
              : 'scale(0.3)',
            transition: showLogo
              ? (phase === 'text' || phase === 'fadeout'
                ? 'transform 1400ms linear, opacity 600ms cubic-bezier(0.16, 1, 0.3, 1)'
                : 'transform 600ms cubic-bezier(0.16, 1, 0.3, 1), opacity 600ms cubic-bezier(0.16, 1, 0.3, 1)')
              : 'none',
          }}
        >
          <svg width="120" height="132" viewBox="0 0 40 44" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="entrance-grad" x1="0" y1="22" x2="40" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#EC4899" />
                <stop offset="100%" stopColor="#8B5CF6" />
              </linearGradient>
            </defs>
            <path d="M3 2 L27 22 L3 42 Z" stroke="url(#entrance-grad)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" fill="none" />
            <path d="M37 2 L13 22 L37 42 Z" stroke="url(#entrance-grad)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" fill="none" />
          </svg>

          {/* Shine wipe overlay */}
          {showLogo && <div className="entrance-shine" />}
        </div>

        {/* Text */}
        <div
          className="entrance-text"
          style={{
            opacity: showText ? 1 : 0,
            transform: showText ? 'translateY(0)' : 'translateY(10px)',
            transition: showText ? 'opacity 400ms ease-out, transform 400ms ease-out' : 'none',
          }}
        >
          MEDINA INTELLIGENCE
        </div>
      </div>
    </div>
  );
}
