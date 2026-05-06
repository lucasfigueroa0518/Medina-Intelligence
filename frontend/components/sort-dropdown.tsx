'use client';

import React from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Check } from 'lucide-react';

export interface SortOption {
  key: string;
  label: string;
  // Default arrow direction for this option's display label (e.g. "newest first").
  // The actual order param is controlled by the parent.
  defaultDir: 'asc' | 'desc';
}

interface SortDropdownProps {
  options: SortOption[];
  value: string;
  dir: 'asc' | 'desc';
  onChange: (key: string, dir: 'asc' | 'desc') => void;
}

export function SortDropdown({ options, value, dir, onChange }: SortDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const active = options.find(o => o.key === value) ?? options[0];

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex h-10 max-w-[320px] items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-bg-inset px-3 text-sm text-text-secondary transition-colors hover:border-border-hover hover:text-text-primary"
      >
        <ArrowUpDown size={14} className="shrink-0 text-text-muted" />
        <span className="shrink-0 text-text-muted">Sort:</span>
        <span className="min-w-0 max-w-[13rem] truncate text-text-primary">{active.label}</span>
        {dir === 'asc'
          ? <ArrowUp size={12} className="shrink-0" />
          : <ArrowDown size={12} className="shrink-0" />}
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 w-64 rounded-lg shadow-2xl z-30 py-1"
          style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          {options.map(opt => {
            const selected = opt.key === value;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  // First click on a non-selected option uses its default direction;
                  // clicking the active option flips direction.
                  const nextDir = selected
                    ? (dir === 'asc' ? 'desc' : 'asc')
                    : opt.defaultDir;
                  onChange(opt.key, nextDir);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-bg-surface-hover transition-colors ${
                  selected ? 'text-text-primary' : 'text-text-secondary'
                }`}
              >
                <span className="w-4 inline-flex justify-center">
                  {selected && <Check size={12} className="text-accent-magenta" />}
                </span>
                <span className="flex-1">{opt.label}</span>
                {selected && (
                  dir === 'asc' ? <ArrowUp size={12} className="text-text-muted" /> : <ArrowDown size={12} className="text-text-muted" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
