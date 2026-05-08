import React from 'react';

interface TopBarProps {
  title: string;
  breadcrumb?: React.ReactNode;
  search?: React.ReactNode;
  actions?: React.ReactNode;
}

export function TopBar({ title, breadcrumb, search, actions }: TopBarProps) {
  return (
    <header className="min-h-16 px-4 py-3 md:px-8 md:py-0 border-b border-border bg-bg-root flex flex-col md:flex-row md:items-center gap-3 md:gap-6 flex-shrink-0">
      <div className="flex items-center gap-3 md:gap-4 shrink-0 min-w-0">
        <h1 className="font-display text-xl md:text-2xl text-text-primary truncate">{title}</h1>
        {breadcrumb}
      </div>
      <div className="flex flex-col sm:flex-row md:items-center gap-2 md:gap-3 flex-1 md:justify-end min-w-0">
        {search}
        {actions}
      </div>
    </header>
  );
}
