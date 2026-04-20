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

  let logoScale = 0.5;
  let logoTransition = 'none';

  if (phase === 'logo') {
    logoScale = 3;
    logoTransition = 'transform 1000ms cubic-bezier(0.16, 1, 0.3, 1), opacity 800ms cubic-bezier(0.16, 1, 0.3, 1)';
  } else if (phase === 'text') {
    logoScale = 3.5;
    logoTransition = 'transform 1200ms linear';
  } else if (phase === 'fadeout') {
    logoScale = 4;
    logoTransition = 'transform 600ms ease-in-out';
  }

  return (
    <div
      className="entrance-overlay"
      style={{
        opacity: isFading ? 0 : 1,
        transition: isFading ? 'opacity 600ms ease-in-out' : 'none',
      }}
    >
      <div className="entrance-content">
        <div
          className="entrance-logo-wrap"
          style={{
            opacity: showLogo ? 1 : 0,
            transform: `scale(${logoScale})`,
            transition: showLogo ? logoTransition + ', opacity 800ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/medina-logo.png" alt="" className="entrance-logo-img" draggable={false} />
          {showLogo && <div className="entrance-shine" />}
        </div>

        <div
          className="entrance-text"
          style={{
            opacity: showText ? 1 : 0,
            letterSpacing: showText ? '14px' : '8px',
            transform: showText ? 'scale(1.05)' : 'scale(0.95)',
            transition: showText
              ? 'opacity 800ms cubic-bezier(0.16, 1, 0.3, 1), letter-spacing 800ms cubic-bezier(0.16, 1, 0.3, 1), transform 800ms cubic-bezier(0.16, 1, 0.3, 1)'
              : 'none',
          }}
        >
          MEDINA INTELLIGENCE
        </div>
      </div>
    </div>
  );
}
