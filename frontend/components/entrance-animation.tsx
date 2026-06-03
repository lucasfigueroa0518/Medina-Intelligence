'use client';

import React from 'react';

interface EntranceAnimationProps {
  onComplete: () => void;
}

const IGNITION_MS = 1500;
const SUSTAIN_MS = 1000;
const FADEOUT_MS = 700;
const TOTAL_MS = IGNITION_MS + SUSTAIN_MS + FADEOUT_MS;

export function EntranceAnimation({ onComplete }: EntranceAnimationProps) {
  const [fading, setFading] = React.useState(false);

  React.useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(setTimeout(() => setFading(true), IGNITION_MS + SUSTAIN_MS));
    timers.push(setTimeout(() => onComplete(), TOTAL_MS));

    timers.push(setTimeout(() => onComplete(), TOTAL_MS + 1000));

    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  return (
    <div
      className="entrance-overlay"
      style={{
        opacity: fading ? 0 : 1,
        transition: fading ? `opacity ${FADEOUT_MS}ms ease-in-out` : 'none',
      }}
    >
      <div className="entrance-orb">
        <div className="entrance-glow entrance-glow-halo" />
        <div className="entrance-glow entrance-glow-core" />
        <div className="entrance-glow entrance-glow-mid" />
        <div className="entrance-glow entrance-glow-outer" />
        <div className="entrance-glow entrance-glow-shimmer" />
        <div className="entrance-glow entrance-glow-cool" />

        <div className="entrance-logo-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/favicon.svg"
            alt=""
            className="entrance-logo-img"
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
