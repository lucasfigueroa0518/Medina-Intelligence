'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2,
  FileText,
  Handshake,
  Mail,
  Menu,
  Settings,
  Shield,
  Users,
  X,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { api, clearAuthToken } from '@/lib/api';
import { MartyEmblem } from './marty-emblem';

type NavItem = {
  label: string;
  route: string;
  href?: string;
  matchRoutes?: string[];
  icon?: LucideIcon;
  marty?: boolean;
  adminOnly?: boolean;
};

const PRIMARY: NavItem[] = [
  { label: 'MARTy', route: '/god-mode', marty: true },
  { label: 'Contacts', route: '/contacts', icon: Users },
  { label: 'Companies', route: '/companies', icon: Building2 },
  { label: 'Deals', route: '/deals', icon: Handshake },
  { label: 'Files', route: '/files', href: '/files?tab=imports', matchRoutes: ['/files', '/imports', '/documents'], icon: FileText },
];

const MORE: NavItem[] = [
  { label: 'Campaigns', route: '/campaigns', icon: Mail },
  { label: 'Settings', route: '/settings', icon: Settings },
  { label: 'Admin', route: '/admin', icon: Shield, adminOnly: true },
];

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [martyPending, setMartyPending] = React.useState(false);
  const [isAdmin, setIsAdmin] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);

  React.useEffect(() => {
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
        if (!cancelled) {
          const role = res.user.role;
          setIsAdmin(role === 'super_admin' || role === 'owner' || role === 'admin');
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => setOpen(false), [pathname]);

  const moreItems = MORE.filter(item => !item.adminOnly || isAdmin);

  return (
    <>
      {open && (
        <div className="md:hidden fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            className="absolute inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] rounded-2xl border border-border bg-bg-surface shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="text-sm font-semibold text-text-primary">More</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 w-9 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-white/[0.05]"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-2">
              {moreItems.map(item => (
                <MobileMenuLink key={item.route} item={item} active={isActive(pathname, item)} />
              ))}
              <button
                type="button"
                disabled={loggingOut}
                onClick={async () => {
                  setLoggingOut(true);
                  try { await api.logout(); } catch { /* ignore */ }
                  clearAuthToken();
                  router.push('/login');
                }}
                className="w-full h-12 flex items-center gap-3 px-3 rounded-xl text-sm text-text-secondary hover:text-text-primary hover:bg-white/[0.05]"
              >
                <LogOut size={18} />
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="md:hidden fixed inset-x-0 bottom-0 z-[80] border-t border-border bg-bg-root/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-6 h-[68px] px-1">
          {PRIMARY.map(item => (
            <MobileTab key={item.route} item={item} active={isActive(pathname, item)} martyPending={martyPending} />
          ))}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={`flex flex-col items-center justify-center gap-1 rounded-xl text-[10px] transition-colors ${
              open ? 'text-text-primary bg-accent-magenta/10' : 'text-text-secondary'
            }`}
          >
            <Menu size={19} />
            More
          </button>
        </div>
      </nav>
    </>
  );
}

function MobileTab({ item, active, martyPending }: { item: NavItem; active: boolean; martyPending: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href ?? item.route}
      className={`flex flex-col items-center justify-center gap-1 rounded-xl text-[10px] transition-colors ${
        active ? 'text-text-primary bg-accent-magenta/10' : 'text-text-secondary'
      }`}
    >
      <span className="relative">
        {item.marty ? <MartyEmblem size={19} animate={martyPending && !active} /> : Icon ? <Icon size={19} /> : null}
        {item.marty && martyPending && !active && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent-purple streaming-dot" />
        )}
      </span>
      <span className="leading-none">{item.label}</span>
    </Link>
  );
}

function MobileMenuLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href ?? item.route}
      className={`h-12 flex items-center gap-3 px-3 rounded-xl text-sm transition-colors ${
        active ? 'text-text-primary bg-accent-magenta/10' : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.05]'
      }`}
    >
      {Icon && <Icon size={18} className={active ? 'text-accent-magenta' : ''} />}
      {item.label}
    </Link>
  );
}

function isActive(pathname: string, item: NavItem) {
  const routes = item.matchRoutes ?? [item.route];
  return routes.some(route => pathname === route || pathname.startsWith(route + '/'));
}
