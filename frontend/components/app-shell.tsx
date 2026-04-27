'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { SessionExpiredBanner } from '@/components/session-expired-banner';

const NO_SHELL_PATHS = ['/login', '/signup', '/mfa'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = NO_SHELL_PATHS.some(p => pathname.startsWith(p));

  if (bare) return <>{children}</>;

  return (
    <>
      <SessionExpiredBanner />
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-y-auto">
          {children}
        </div>
      </div>
    </>
  );
}
