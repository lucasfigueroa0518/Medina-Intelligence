'use client';

import React from 'react';

interface MartyEmblemProps {
  size?: number;
  animate?: boolean;
  className?: string;
}

export function MartyEmblem({ size = 32, animate = false, className = '' }: MartyEmblemProps) {
  const uid = React.useId().replace(/:/g, '');

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={`mg-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A855F7" />
          <stop offset="100%" stopColor="#EC4899" />
        </linearGradient>
      </defs>
      <path
        d="M16 2 L30 16 L16 30 L2 16 Z"
        fill={`url(#mg-${uid})`}
        className={animate ? 'diamond-fill-anim' : ''}
        opacity={animate ? undefined : 0.15}
      />
      <polyline
        points="16,2 30,16 16,30"
        stroke={`url(#mg-${uid})`}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        className={animate ? 'diamond-draw-right' : ''}
      />
      <polyline
        points="16,2 2,16 16,30"
        stroke={`url(#mg-${uid})`}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        className={animate ? 'diamond-draw-left' : ''}
      />
    </svg>
  );
}
