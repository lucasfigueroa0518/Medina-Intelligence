'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
  const searchParams = useSearchParams();
  const tabFromUrl: FilesTab = searchParams.get('tab') === 'documents' ? 'documents' : 'imports';
  const [activeTab, setActiveTabState] = React.useState<FilesTab>(tabFromUrl);

  React.useEffect(() => {
    setActiveTabState(tabFromUrl);
  }, [tabFromUrl]);

  function setActiveTab(tab: FilesTab) {
    setActiveTabState(tab);
  }

  return (
    <div className="flex-1 flex h-full min-h-0 flex-col overflow-hidden min-w-0">
      <TopBar title="Files" />

      <div className="relative z-20 border-b border-border bg-bg-root/95 backdrop-blur supports-[backdrop-filter]:bg-bg-root/80">
        <div className="px-4 md:px-6 pt-4">
          <div className="inline-flex rounded-xl border border-border bg-bg-inset p-1">
            {TABS.map(tab => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
                <Link
                  key={tab.key}
                  href={`/files?tab=${tab.key}`}
                  replace
                  scroll={false}
                  onClick={() => setActiveTab(tab.key)}
                  className={`h-10 px-4 rounded-lg text-sm font-medium transition-colors inline-flex items-center gap-2 ${
                    active
                      ? 'bg-accent-magenta/15 text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon size={16} className={active ? 'text-accent-magenta' : ''} />
                  {tab.label}
                </Link>
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
