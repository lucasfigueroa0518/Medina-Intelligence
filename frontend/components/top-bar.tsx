import React from 'react';

interface TopBarProps {
  title: string;
  breadcrumb?: React.ReactNode;
  search?: React.ReactNode;
  actions?: React.ReactNode;
}

export function TopBar({ title, breadcrumb, search, actions }: TopBarProps) {
  return (
    <header className="h-16 px-8 border-b border-border bg-bg-root flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-4">
        <h1 className="font-display text-2xl text-text-primary">{title}</h1>
        {breadcrumb}
      </div>
      <div className="flex items-center gap-3">
        {search}
        {actions}
      </div>
    </header>
  );
}
