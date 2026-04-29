'use client';

import React from 'react';

export interface QuickFilter<F> {
  key: string;
  label: string;
  // Subset of the filter state to apply when the button is clicked.
  preset: Partial<F>;
  // Optional reset payload — what fields to clear when the preset is
  // toggled off. Defaults to setting each preset field to its empty value
  // inferred from the type at runtime (string → '', array → []).
  reset?: Partial<F>;
}

interface QuickFiltersProps<F> {
  filters: F;
  onApply: (next: F) => void;
  onClearAll: () => void;
  presets: QuickFilter<F>[];
}

// True when every key in `preset` exists in `state` with an equivalent value.
function presetMatches<F>(state: F, preset: Partial<F>): boolean {
  for (const k of Object.keys(preset) as (keyof F)[]) {
    const a = state[k];
    const b = preset[k];
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      const sa = [...a].sort();
      const sb = [...b].sort();
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

function emptyFor<T>(value: T): T {
  if (Array.isArray(value)) return [] as unknown as T;
  if (typeof value === 'boolean') return false as unknown as T;
  return '' as unknown as T;
}

export function QuickFilters<F extends Record<string, any>>({
  filters,
  onApply,
  onClearAll,
  presets,
}: QuickFiltersProps<F>) {
  const allActive = presets.every(p => !presetMatches(filters, p.preset));
  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <button
        type="button"
        onClick={onClearAll}
        className={`h-8 px-3 rounded-full text-xs font-medium transition-colors ${
          allActive
            ? 'bg-accent-magenta/20 text-accent-magenta border border-accent-magenta/40'
            : 'border border-border text-text-secondary hover:text-text-primary hover:border-border-hover'
        }`}
      >
        All
      </button>
      {presets.map(p => {
        const active = presetMatches(filters, p.preset);
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => {
              if (active) {
                // Toggle off: clear the preset's fields back to empty values.
                const reset = p.reset ?? {};
                const fallback: Partial<F> = {};
                for (const k of Object.keys(p.preset) as (keyof F)[]) {
                  if (!(k in reset)) (fallback as any)[k] = emptyFor(filters[k]);
                }
                onApply({ ...filters, ...fallback, ...reset });
              } else {
                onApply({ ...filters, ...p.preset });
              }
            }}
            className={`h-8 px-3 rounded-full text-xs font-medium transition-colors ${
              active
                ? 'bg-accent-magenta/20 text-accent-magenta border border-accent-magenta/40'
                : 'border border-border text-text-secondary hover:text-text-primary hover:border-border-hover'
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
