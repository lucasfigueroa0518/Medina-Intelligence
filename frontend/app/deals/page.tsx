'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { api } from '@/lib/api';
import { Plus } from 'lucide-react';

const STAGES = [
  { key: 'prospect', label: 'Prospect' },
  { key: 'first_contact', label: 'First Contact' },
  { key: 'meeting_scheduled', label: 'Meeting Scheduled' },
  { key: 'due_diligence', label: 'Due Diligence' },
  { key: 'term_sheet', label: 'Term Sheet' },
  { key: 'closing', label: 'Closing' },
  { key: 'closed_won', label: 'Closed Won' },
  { key: 'closed_lost', label: 'Closed Lost' },
];

export default function DealsPage() {
  const [deals, setDeals] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    api
      .listDeals()
      .then(d => setDeals(d.deals))
      .finally(() => setLoading(false));
  }, []);

  const dealsByStage = STAGES.map(stage => ({
    ...stage,
    deals: deals.filter(d => d.stage === stage.key),
  }));

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="Deal Pipeline"
        actions={
          <button className="btn-primary flex items-center gap-2">
            <Plus size={16} /> Add Deal
          </button>
        }
      />
      <div className="flex-1 p-6 overflow-x-auto">
        {loading ? (
          <div className="text-text-secondary">Loading pipeline...</div>
        ) : (
          <div className="flex gap-4 h-full min-w-max">
            {dealsByStage.map((stage, idx) => {
              const isFinal = idx >= 6;
              return (
                <div
                  key={stage.key}
                  className={`w-72 flex-shrink-0 bg-bg-inset rounded-xl p-3 ${
                    isFinal ? 'border-l-4 border-border' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-3 px-2">
                    <span className="text-sm font-medium text-text-primary">
                      {stage.label}
                    </span>
                    <span className="text-xs text-text-muted">{stage.deals.length}</span>
                  </div>
                  <div className="space-y-2">
                    {stage.deals.map(deal => (
                      <div
                        key={deal.id}
                        className="card cursor-pointer hover:border-border-hover transition-all"
                      >
                        <div className="text-sm font-medium">{deal.title}</div>
                        <div className="text-xs text-text-secondary mt-1">
                          {deal.amount ? formatCurrency(deal.amount) : 'No amount'}
                        </div>
                        {deal.probability > 0 && (
                          <div className="flex items-center gap-2 mt-2">
                            <div className="h-[3px] w-[30px] bg-bg-surface-hover rounded">
                              <div
                                className="h-[3px] bg-brand-gradient rounded"
                                style={{ width: `${deal.probability * 100}%` }}
                              />
                            </div>
                            <span className="text-xs text-text-muted">
                              {(deal.probability * 100).toFixed(0)}%
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatCurrency(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}
