import type { Metadata } from 'next';
import './globals.css';
import { AuthGuard } from '@/components/auth-guard';
import { AppShell } from '@/components/app-shell';

export const metadata: Metadata = {
  title: 'Medina Intelligence Platform',
  description: 'VC CRM with God Mode AI agent, auto-sync engine, and RAG pipeline',
  icons: {
    icon: '/medina-logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg-root text-text-primary min-h-screen">
        <AuthGuard>
          <AppShell>{children}</AppShell>
        </AuthGuard>
      </body>
    </html>
  );
}
