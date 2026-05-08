'use client';

import React from 'react';

interface FilterSection {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

interface FilterPanelProps {
  sections: FilterSection[];
  onClearAll?: () => void;
  activeCount?: number;
}

export function FilterPanel({ sections, onClearAll, activeCount = 0 }: FilterPanelProps) {
  return (
    <>
      <details className="md:hidden border-b border-border bg-bg-inset">
        <summary className="list-none p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-text-muted font-medium">
              Filters
            </span>
            {activeCount > 0 && (
              <span className="badge bg-accent-magenta text-white text-xs">{activeCount}</span>
            )}
          </div>
          <span className="text-xs text-text-secondary">Open</span>
        </summary>
        <div className="px-4 pb-4 space-y-5 max-h-[68vh] overflow-y-auto">
          {onClearAll && activeCount > 0 && (
            <button
              onClick={onClearAll}
              className="text-xs text-text-secondary hover:text-text-primary"
            >
              Clear All
            </button>
          )}
          {sections.map((s, i) => (
            <Section key={i} label={s.label} defaultOpen={s.defaultOpen ?? i < 3}>
              {s.children}
            </Section>
          ))}
        </div>
      </details>
      <aside className="hidden md:flex w-[280px] bg-bg-inset border-r border-border overflow-y-auto flex-shrink-0 flex-col">
        <div className="p-4 flex items-center justify-between border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-text-muted font-medium">
              Filters
            </span>
            {activeCount > 0 && (
              <span className="badge bg-accent-magenta text-white text-xs">{activeCount}</span>
            )}
          </div>
          {onClearAll && (
            <button
              onClick={onClearAll}
              className="text-xs text-text-secondary hover:text-text-primary"
            >
              Clear All
            </button>
          )}
        </div>
        <div className="p-4 space-y-6">
          {sections.map((s, i) => (
            <Section key={i} label={s.label} defaultOpen={s.defaultOpen ?? i < 3}>
              {s.children}
            </Section>
          ))}
        </div>
      </aside>
    </>
  );
}

function Section({
  label,
  children,
  defaultOpen,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-xs uppercase tracking-wider text-text-muted font-medium mb-2 hover:text-text-secondary"
      >
        <span>{label}</span>
        <span className="text-xs">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="space-y-2">{children}</div>}
    </div>
  );
}
