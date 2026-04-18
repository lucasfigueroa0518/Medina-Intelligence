'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Users,
  Building2,
  Handshake,
  Sparkles,
  Mail,
  Shield,
  Upload,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

interface NavLink {
  label: string;
  icon: LucideIcon;
  route: string;
  requireAdmin?: boolean;
}

const NAV_LINKS: NavLink[] = [
  { label: 'Contacts', icon: Users, route: '/contacts' },
  { label: 'Companies', icon: Building2, route: '/companies' },
  { label: 'Deals', icon: Handshake, route: '/deals' },
  { label: 'God Mode', icon: Sparkles, route: '/god-mode' },
  { label: 'Campaigns', icon: Mail, route: '/campaigns' },
  { label: 'Admin', icon: Shield, route: '/admin', requireAdmin: true },
  { label: 'Imports', icon: Upload, route: '/imports' },
  { label: 'Settings', icon: SettingsIcon, route: '/settings' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-[240px] bg-bg-inset border-r border-border flex-shrink-0 flex flex-col">
      {/* Logo */}
      <div className="p-6 border-b border-border">
        <div className="font-display text-2xl text-text-primary">
          Medina <span className="bg-brand-gradient bg-clip-text text-transparent">Ventures</span>
        </div>
      </div>

      {/* Nav links */}
      <nav className="flex-1 p-3 space-y-1">
        {NAV_LINKS.map(link => {
          const Icon = link.icon;
          const active = pathname === link.route || pathname.startsWith(link.route + '/');
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
              <Icon size={20} className={active ? 'text-accent-magenta' : ''} />
              <span className="text-sm font-normal">{link.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* User menu placeholder */}
      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-brand-gradient flex items-center justify-center text-white text-sm font-medium">
            M
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary truncate">Managing Partner</div>
            <div className="text-xs text-text-muted">owner</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
