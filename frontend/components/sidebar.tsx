'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Users,
  Building2,
  Handshake,
  Mail,
  Shield,
  Upload,
  FileText,
  Settings as SettingsIcon,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { api, clearAuthToken } from '@/lib/api';
import { MedinaLogo } from './medina-logo';
import { MartyEmblem } from './marty-emblem';

interface NavLink {
  label: string;
  icon?: LucideIcon;
  route: string;
  requireAdmin?: boolean;
}

const NAV_LINKS: NavLink[] = [
  { label: 'MARTy', route: '/god-mode' },
  { label: 'Contacts', icon: Users, route: '/contacts' },
  { label: 'Companies', icon: Building2, route: '/companies' },
  { label: 'Deals', icon: Handshake, route: '/deals' },
  { label: 'Campaigns', icon: Mail, route: '/campaigns' },
  { label: 'Admin', icon: Shield, route: '/admin', requireAdmin: true },
  { label: 'Imports', icon: Upload, route: '/imports' },
  { label: 'Documents', icon: FileText, route: '/documents' },
  { label: 'Settings', icon: SettingsIcon, route: '/settings' },
];

interface MeUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  org_id: string;
  avatar_url: string | null;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [martyPending, setMartyPending] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [me, setMe] = React.useState<MeUser | null>(null);
  const [isAdmin, setIsAdmin] = React.useState(false);

  React.useEffect(() => {
    // Check initial state
    try {
      setMartyPending(!!localStorage.getItem('marty_pending'));
    } catch { /* ignore */ }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setMartyPending(!!detail?.pending);
    };
    window.addEventListener('marty-pending-change', handler);
    return () => window.removeEventListener('marty-pending-change', handler);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then(res => {
        if (cancelled) return;
        setMe(res.user);
        setIsAdmin(res.user.role === 'super_admin' || res.user.role === 'owner' || res.user.role === 'admin');
      })
      .catch(() => { /* unauthenticated — leave defaults */ });
    return () => { cancelled = true; };
  }, []);

  const initial = me?.full_name?.trim()?.charAt(0)?.toUpperCase() || me?.email?.charAt(0)?.toUpperCase() || '?';
  const displayName = me?.full_name?.trim() || me?.email || 'Loading…';
  const roleLabel = me?.role === 'super_admin' ? 'Super Admin' : me?.role || '';

  return (
    <aside className="hidden md:flex w-[240px] bg-bg-inset border-r border-border flex-shrink-0 flex-col">
      {/* Logo */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-2.5">
          <MedinaLogo size={28} />
          <div className="font-display text-lg text-text-primary leading-tight">
            Medina <span className="bg-brand-gradient bg-clip-text text-transparent">Intelligence</span>
          </div>
        </div>
      </div>

      {/* Nav links */}
      <nav className="flex-1 p-3 space-y-1">
        {NAV_LINKS.filter(link => !link.requireAdmin || isAdmin).map(link => {
          const active = pathname === link.route || pathname.startsWith(link.route + '/');
          const isMarty = link.route === '/god-mode';
          return (
            <Link
              key={link.route}
              href={link.route}
              className={`flex items-center gap-3 px-3 h-10 rounded-lg transition-colors ${
                active
                  ? 'bg-accent-magenta/10 text-text-primary border-l-2 border-accent-magenta pl-[10px]'
                  : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'
              }`}
            >
              <span className="relative">
                {isMarty ? (
                  <MartyEmblem size={20} animate={martyPending && !active} />
                ) : link.icon ? (
                  <link.icon size={20} className={active ? 'text-accent-magenta' : ''} />
                ) : null}
                {isMarty && martyPending && !active && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#8B5CF6] streaming-dot" />
                )}
              </span>
              <span className="text-sm font-normal">{link.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* User menu */}
      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-3">
          {me?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={me.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-brand-gradient flex items-center justify-center text-white text-sm font-medium">
              {initial}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary truncate">{displayName}</div>
            <div className="text-xs text-text-muted">{roleLabel}</div>
          </div>
          <button
            title="Sign out"
            disabled={loggingOut}
            onClick={async () => {
              setLoggingOut(true);
              try { await api.logout(); } catch { /* ignore */ }
              clearAuthToken();
              router.push('/login');
            }}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-white/[0.06] transition-colors"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
