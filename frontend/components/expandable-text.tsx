'use client';

import React from 'react';

const CLAMP_CLASS: Record<number, string> = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
};

export function ExpandableText({
  text,
  collapsedLines = 2,
  minToggleChars = 120,
  className = '',
  buttonClassName = '',
  empty = null,
}: {
  text: string | null | undefined;
  collapsedLines?: 1 | 2 | 3 | 4 | 5;
  minToggleChars?: number;
  className?: string;
  buttonClassName?: string;
  empty?: React.ReactNode;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const value = String(text || '').trim();

  if (!value) return empty ? <>{empty}</> : null;

  const canToggle = value.length >= minToggleChars || value.includes('\n');
  const clampClass = CLAMP_CLASS[collapsedLines] || CLAMP_CLASS[2];

  return (
    <div>
      <div className={`${className} ${expanded || !canToggle ? 'whitespace-pre-wrap break-words' : `${clampClass} break-words`}`}>
        {value}
      </div>
      {canToggle && (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            setExpanded(open => !open);
          }}
          className={`mt-1 text-[11px] font-medium text-accent-magenta transition-colors hover:text-accent-purple ${buttonClassName}`}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
