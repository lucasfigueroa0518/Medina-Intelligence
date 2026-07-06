'use client';

import { MedinaLogo } from '@/components/medina-logo';

/**
 * Instant app-shell skeleton painted while the auth check resolves in the
 * background (see AuthGuard). Mirrors the real shell geometry — Sidebar
 * (components/sidebar.tsx) + TopBar (components/top-bar.tsx) + content — so the
 * first paint lands the layout instead of a blank/logo-only screen on a Worker
 * cold start.
 *
 * SECURITY: renders placeholder blocks only. It never renders children or any
 * protected data — the auth gate still fully controls when real content mounts.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden" aria-hidden="true">
      {/* Sidebar rail — mirrors Sidebar (w-[240px] bg-bg-inset, hidden on mobile) */}
      <aside className="hidden md:flex w-[240px] bg-bg-inset border-r border-border flex-shrink-0 flex-col">
        {/* Logo header */}
        <div className="p-6 border-b border-border">
          <div className="flex items-center gap-2.5">
            <MedinaLogo size={28} />
            <div className="font-display text-lg text-text-primary leading-tight">
              Medina <span className="bg-brand-gradient bg-clip-text text-transparent">Intelligence</span>
            </div>
          </div>
        </div>

        {/* Nav link placeholders */}
        <nav className="flex-1 p-3 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 h-10 rounded-lg animate-pulse">
              <div className="h-5 w-5 rounded bg-bg-surface-hover flex-shrink-0" />
              <div className="h-3.5 rounded bg-bg-surface-hover" style={{ width: `${70 - (i % 4) * 10}px` }} />
            </div>
          ))}
        </nav>

        {/* User menu placeholder */}
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-3 animate-pulse">
            <div className="w-8 h-8 rounded-full bg-bg-surface-hover flex-shrink-0" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="h-3.5 w-24 rounded bg-bg-surface-hover" />
              <div className="h-3 w-16 rounded bg-bg-surface-hover" />
            </div>
          </div>
        </div>
      </aside>

      {/* Main column — mirrors AppShell content wrapper */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="min-h-16 px-4 py-3 md:px-8 md:py-0 border-b border-border bg-bg-root flex items-center gap-3 md:gap-6 flex-shrink-0">
          <div className="h-7 w-40 rounded bg-bg-surface-hover animate-pulse" />
          <div className="flex-1 flex items-center justify-end gap-3">
            <div className="h-9 w-full max-w-xs rounded-lg bg-bg-surface-hover animate-pulse" />
          </div>
        </header>

        {/* Content placeholders */}
        <div className="flex-1 overflow-hidden p-4 md:p-8 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-bg-surface animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
