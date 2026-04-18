import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { SessionExpiredBanner } from '@/components/session-expired-banner';

export const metadata: Metadata = {
  title: 'Medina Ventures — Intelligence Platform',
  description: 'VC CRM with God Mode AI agent, auto-sync engine, and RAG pipeline',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg-root text-text-primary min-h-screen">
        <SessionExpiredBanner />
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
