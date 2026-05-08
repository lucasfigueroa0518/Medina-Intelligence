'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { MobileNav } from '@/components/mobile-nav';
import { SessionExpiredBanner } from '@/components/session-expired-banner';
import { IntegrationWarningBanner } from '@/components/integration-warning-banner';
import { BackgroundTaskProvider, BackgroundTaskIndicator } from '@/components/background-task-indicator';

const NO_SHELL_PATHS = ['/login', '/signup', '/mfa', '/auth'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = NO_SHELL_PATHS.some(p => pathname.startsWith(p));

  if (bare) return <>{children}</>;

  return (
    <BackgroundTaskProvider>
      <SessionExpiredBanner />
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-y-auto pb-[calc(76px+env(safe-area-inset-bottom))] md:pb-0">
          <IntegrationWarningBanner />
          {children}
        </div>
      </div>
      <MobileNav />
      <BackgroundTaskIndicator />
    </BackgroundTaskProvider>
  );
}
