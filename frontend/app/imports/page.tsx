'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { Upload } from 'lucide-react';

export default function ImportsPage() {
  const [file, setFile] = React.useState<File | null>(null);

  return (
    <div className="flex-1 flex flex-col">
      <TopBar title="Bulk Import" />
      <div className="p-8 max-w-3xl">
        <div className="mb-6">
          <div className="flex items-center gap-4">
            {['Upload', 'Map Columns', 'Preview', 'Processing'].map((label, i) => (
              <React.Fragment key={label}>
                <div className="flex items-center gap-2">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                      i === 0 ? 'bg-brand-gradient text-white' : 'bg-bg-surface-hover text-text-muted'
                    }`}
                  >
                    {i + 1}
                  </div>
                  <span className={`text-sm ${i === 0 ? 'text-text-primary' : 'text-text-muted'}`}>
                    {label}
                  </span>
                </div>
                {i < 3 && <div className="flex-1 h-[1px] bg-border" />}
              </React.Fragment>
            ))}
          </div>
        </div>

        <label className="card border-dashed border-2 border-border flex flex-col items-center justify-center py-12 cursor-pointer hover:border-border-hover transition-colors">
          <Upload size={48} className="text-text-muted mb-4" />
          <div className="text-sm font-medium mb-1">
            {file ? file.name : 'Drop your file here or click to browse'}
          </div>
          <div className="text-xs text-text-muted">CSV, Excel (.xlsx), or ZIP</div>
          <input
            type="file"
            className="hidden"
            accept=".csv,.xlsx,.zip"
            onChange={e => setFile(e.target.files?.[0] || null)}
          />
        </label>

        <div className="flex justify-end mt-6">
          <button className="btn-primary" disabled={!file}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
