'use client';

import React, { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileText, Upload, type LucideIcon } from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { ImportsPageContent } from '../imports/page';
import { DocumentsPageContent } from '../documents/page';

type FilesTab = 'imports' | 'documents';

const TABS: { key: FilesTab; label: string; icon: LucideIcon }[] = [
  { key: 'imports', label: 'Imports', icon: Upload },
  { key: 'documents', label: 'Documents', icon: FileText },
];

export default function FilesPage() {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <FilesPageInner />
    </Suspense>
  );
}

function FilesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab: FilesTab = searchParams.get('tab') === 'documents' ? 'documents' : 'imports';

  function setActiveTab(tab: FilesTab) {
    const next = new URLSearchParams(searchParams.toString());
    next.set('tab', tab);
    router.replace(`/files?${next.toString()}`, { scroll: false });
  }

  return (
    <div className="flex-1 flex h-full min-h-0 flex-col overflow-hidden min-w-0">
      <TopBar title="Files" />

      <div className="border-b border-border bg-bg-root/95 backdrop-blur supports-[backdrop-filter]:bg-bg-root/80">
        <div className="px-4 md:px-6 pt-4">
          <div className="inline-flex rounded-xl border border-border bg-bg-inset p-1">
            {TABS.map(tab => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`h-10 px-4 rounded-lg text-sm font-medium transition-colors inline-flex items-center gap-2 ${
                    active
                      ? 'bg-accent-magenta/15 text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon size={16} className={active ? 'text-accent-magenta' : ''} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 h-full overflow-hidden">
        {activeTab === 'imports'
          ? <ImportsPageContent embedded />
          : <DocumentsPageContent embedded />}
      </div>
    </div>
  );
}
