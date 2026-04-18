'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { TopBar } from '@/components/top-bar';
import { Timeline, TimelineEntry } from '@/components/timeline';
import { api } from '@/lib/api';

type Tab = 'overview' | 'timeline' | 'associations' | 'documents' | 'deals';

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [contact, setContact] = React.useState<any>(null);
  const [tags, setTags] = React.useState<any[]>([]);
  const [associations, setAssociations] = React.useState<any[]>([]);
  const [timeline, setTimeline] = React.useState<TimelineEntry[]>([]);
  const [fullBio, setFullBio] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<Tab>('overview');
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getContact(id),
      api.getContactTimeline(id).catch(() => ({ entries: [] })),
      api.getContactEnrichment(id).catch(() => null),
    ])
      .then(([c, t, e]) => {
        setContact(c.contact);
        setTags(c.tags);
        setAssociations(c.associations);
        setTimeline(t.entries as TimelineEntry[]);
        setFullBio(e?.full_bio ?? null);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        Loading contact...
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="text-text-secondary">Contact not found</div>
        <Link href="/contacts" className="btn-secondary">
          Back to Contacts
        </Link>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <TopBar
        title={contact.full_name}
        breadcrumb={
          <div className="text-sm text-text-muted">
            <Link href="/contacts" className="hover:text-text-primary">
              Contacts
            </Link>
            {' / '}
            {contact.full_name}
          </div>
        }
        actions={
          <div className="flex gap-3">
            <button className="btn-secondary">Enrich Now</button>
            <button className="btn-secondary">Edit</button>
          </div>
        }
      />

      {/* Entity header */}
      <div className="px-8 py-6 border-b border-border bg-bg-surface">
        <div className="flex items-start gap-6">
          <div className="w-16 h-16 rounded-full bg-brand-gradient flex items-center justify-center text-white text-xl font-medium">
            {contact.full_name.charAt(0)}
          </div>
          <div className="flex-1">
            <div className="font-display text-3xl">{contact.full_name}</div>
            <div className="text-sm text-text-secondary mt-1">
              {contact.job_title || 'No title'}
              {contact.company_name && ` · ${contact.company_name}`}
            </div>
            <div className="flex gap-2 mt-3">
              <span className="badge capitalize">{contact.contact_type}</span>
              {contact.relationship_status && (
                <span className="badge capitalize">
                  {contact.relationship_status}
                </span>
              )}
              {tags.map(t => (
                <span
                  key={t.id}
                  className="badge"
                  style={{ backgroundColor: t.color + '40', color: t.color }}
                >
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* StatRow */}
      <div className="px-8 py-4 border-b border-border flex gap-8">
        <Stat label="Interactions" value={contact.total_interactions || 0} />
        <Stat label="Meetings (30d)" value={contact.meetings_last_30d || 0} />
        <Stat
          label="Last Contact"
          value={contact.last_contact_date ? formatRelative(contact.last_contact_date) : '—'}
        />
        <Stat
          label="Follow-up"
          value={contact.next_followup_date ? formatRelative(contact.next_followup_date) : '—'}
        />
      </div>

      {/* Tabs */}
      <div className="px-8 border-b border-border flex gap-0">
        {(['overview', 'timeline', 'associations', 'documents', 'deals'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-5 py-3 text-sm capitalize transition-colors ${
              activeTab === t
                ? 'text-text-primary border-b-2 border-accent-magenta'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-8">
        {activeTab === 'overview' && (
          <div className="grid grid-cols-5 gap-6">
            <div className="col-span-3 space-y-4">
              <div className="card">
                <div className="text-xs uppercase text-text-muted mb-2">Bio</div>
                {(() => {
                  const bio = fullBio || contact.bio_summary;
                  if (!bio) {
                    return (
                      <div className="text-sm text-text-secondary">
                        No bio yet. Click "Enrich Now" to fetch.
                      </div>
                    );
                  }
                  const paragraphs = bio
                    .split(/\n{2,}/)
                    .map(p => p.trim())
                    .filter(Boolean);
                  return (
                    <div className="text-sm text-text-secondary space-y-3 leading-relaxed">
                      {paragraphs.map((p, i) => (
                        <p key={i} className="whitespace-pre-wrap">{p}</p>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="col-span-2 space-y-4">
              <div className="card">
                <div className="text-xs uppercase text-text-muted mb-3">Contact Details</div>
                <div className="space-y-2 text-sm">
                  {contact.email && (
                    <div>
                      <span className="text-text-muted">Email: </span>
                      <span>{contact.email}</span>
                    </div>
                  )}
                  {contact.phone && (
                    <div>
                      <span className="text-text-muted">Phone: </span>
                      <span>{contact.phone}</span>
                    </div>
                  )}
                  {contact.linkedin_url && (
                    <div>
                      <span className="text-text-muted">LinkedIn: </span>
                      <a
                        href={contact.linkedin_url}
                        target="_blank"
                        className="text-semantic-info hover:underline"
                      >
                        Profile
                      </a>
                    </div>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="text-xs uppercase text-text-muted mb-3">Source</div>
                <div className="text-sm">
                  <div className="capitalize">{contact.source}</div>
                  <div className="text-text-muted mt-1">
                    Confidence: {(contact.source_confidence * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'timeline' && <Timeline entries={timeline} />}

        {activeTab === 'associations' && (
          <div className="space-y-2">
            {associations.length === 0 ? (
              <div className="card text-center text-text-secondary py-12">
                No associations discovered yet
              </div>
            ) : (
              associations.map((a: any) => (
                <div key={a.id} className="card flex items-center justify-between">
                  <div>
                    <div className="font-medium">{a.other_name || a.contact_id_b}</div>
                    <div className="text-xs text-text-muted">{a.relationship}</div>
                  </div>
                  <div className="text-xs text-text-muted">
                    {((a.confidence || 0) * 100).toFixed(0)}%
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'documents' && (
          <div className="card text-center text-text-secondary py-12">No documents linked</div>
        )}

        {activeTab === 'deals' && (
          <div className="card text-center text-text-secondary py-12">No deals linked</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xl font-medium text-text-primary">{value}</div>
      <div className="text-xs uppercase tracking-wider text-text-muted mt-1">{label}</div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  return new Date(iso).toLocaleDateString();
}
