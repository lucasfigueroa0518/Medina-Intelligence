'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Briefcase,
  Building2,
  Calendar,
  FileText,
  Linkedin,
  Mail,
  MapPin,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import {
  DEMO_IDS,
  demoActionDocuments,
  demoContactDetailFixture,
  demoRecentObservationsForContact,
} from '@/lib/demo-mode';

type Tab = 'overview' | 'timeline' | 'associations' | 'documents' | 'deals';

function formatDate(value?: string) {
  if (!value) return 'Today';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Today';
  const diff = Date.now() - date.getTime();
  const days = Math.max(0, Math.round(diff / 86_400_000));
  if (days === 0) return 'Today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function shortType(value?: string) {
  return (value || 'signal').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function DemoDonaldTrumpContactPage() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const fixture = demoContactDetailFixture;
  const contact = fixture.contact;
  const observations = demoRecentObservationsForContact;
  const topics = useMemo(() => {
    try {
      const parsed = JSON.parse(contact.topics_of_interest || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [contact.topics_of_interest]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'associations', label: 'Associations' },
    { id: 'documents', label: 'Documents' },
    { id: 'deals', label: 'Deals' },
  ];

  return (
    <div className="min-h-screen bg-[#08080a] text-white">
      <div className="border-b border-white/10 px-6 py-5 md:px-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Donald Trump</h1>
            <span className="hidden text-lg text-white/35 md:inline">Contacts / Demo Mode</span>
          </div>
          <span className="rounded-full border border-pink-500/40 bg-pink-500/10 px-4 py-2 text-sm text-pink-300">
            UI-only demo
          </span>
        </div>
      </div>

      <section className="border-b border-white/10 px-6 py-8 md:px-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-center">
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-violet-600 text-4xl font-semibold shadow-[0_0_35px_rgba(217,70,239,0.28)]">
            D
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">{contact.full_name}</h2>
              <span className="rounded-full bg-white/10 px-3 py-1 text-sm font-medium">Individual</span>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-300">
                Active
              </span>
              <Linkedin className="h-5 w-5 text-blue-400" />
            </div>
            <p className="mt-3 text-xl text-white/65">
              {contact.job_title} at{' '}
              <Link href={`/companies/${DEMO_IDS.company}?demo=1`} className="text-pink-400 hover:text-pink-300">
                Google
              </Link>
            </p>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/45">
              <span className="inline-flex items-center gap-2">
                <Mail className="h-4 w-4" />
                {contact.email}
              </span>
              <span className="inline-flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                {contact.location}
              </span>
              <span className="inline-flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                Demo relationship warmth {contact.relationship_warmth}%
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="grid border-b border-white/10 md:grid-cols-5">
        {[
          ['Status', 'Active', 'Based on fictional recency'],
          ['Last Contact', 'Today', 'Demo call logged'],
          ['Interactions', String(contact.total_interactions), 'Synthetic touchpoints'],
          ['Meetings (30d)', String(contact.meetings_last_30d || 5), 'Demo meetings'],
          ['Owner', 'Tony Jimenez', 'Demo account owner'],
        ].map(([label, value, helper]) => (
          <div key={label} className="border-b border-white/10 px-6 py-5 md:border-b-0 md:border-r md:px-10">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/35">{label}</div>
            <div className="mt-3 text-2xl font-semibold">{value}</div>
            <div className="mt-2 text-sm text-white/35">{helper}</div>
          </div>
        ))}
      </section>

      <div className="border-b border-white/10 px-6 md:px-10">
        <div className="flex gap-8 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap border-b-2 px-2 py-5 text-base ${
                activeTab === tab.id
                  ? 'border-pink-400 text-white'
                  : 'border-transparent text-white/45 hover:text-white/70'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <main className="px-6 py-8 md:px-10">
        {activeTab === 'overview' && (
          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
              <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/40">
                <Sparkles className="h-4 w-4" />
                Recent Observations
              </div>
              <div className="space-y-3">
                {observations.map((obs: any) => (
                  <div key={obs.id} className="rounded-xl border border-white/10 bg-[#111116] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="text-xs font-bold uppercase tracking-[0.18em] text-pink-300">
                        {shortType(obs.signal_type)}
                      </div>
                      <div className="text-xs text-white/35">
                        {formatDate(obs.created_at)} · {Math.round((obs.confidence || 0.9) * 100)}%
                      </div>
                    </div>
                    <p className="mt-3 text-base leading-7 text-white/75">{obs.value}</p>
                    {obs.evidence ? <p className="mt-2 text-sm leading-6 text-white/40">{obs.evidence}</p> : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
              <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/40">
                <Target className="h-4 w-4" />
                Topics And Interests
              </div>
              <div className="flex flex-wrap gap-2">
                {topics.map((topic: string) => (
                  <span key={topic} className="rounded-full bg-pink-500/15 px-3 py-1.5 text-sm text-pink-300">
                    {topic}
                  </span>
                ))}
              </div>
              <div className="mt-6 border-t border-white/10 pt-5">
                <div className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-white/40">Contact Details</div>
                <div className="space-y-3 text-sm text-white/60">
                  <div className="flex items-center gap-3"><Mail className="h-4 w-4" /> {contact.email}</div>
                  <div className="flex items-center gap-3"><MapPin className="h-4 w-4" /> {contact.location}</div>
                  <div className="flex items-center gap-3"><Briefcase className="h-4 w-4" /> {contact.investment_focus}</div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-6 xl:col-span-2">
              <div className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-white/40">Intel Brief</div>
              <p className="whitespace-pre-line text-lg leading-8 text-white/70">{fixture.full_bio}</p>
            </section>
          </div>
        )}

        {activeTab === 'timeline' && (
          <section className="space-y-4">
            {fixture.timeline.map((item: any) => (
              <div key={item.id} className="flex gap-4">
                <div className="mt-4 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-300">
                  <Calendar className="h-4 w-4" />
                </div>
                <div className="flex-1 rounded-xl border border-white/10 bg-white/[0.025] p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold">{item.title}</h3>
                    <span className="text-sm text-white/35">{formatDate(item.timestamp)}</span>
                  </div>
                  <p className="mt-2 text-white/55">{item.body_preview}</p>
                </div>
              </div>
            ))}
          </section>
        )}

        {activeTab === 'associations' && (
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {fixture.entity_associations.map((association: any) => (
              <Link
                key={association.id}
                href={association.other_type === 'company' ? `/companies/${association.other_id}?demo=1` : association.other_type === 'deal' ? `/deals/${association.other_id}?demo=1` : '#'}
                className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 hover:border-pink-500/40"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                    {association.other_type === 'company' ? <Building2 className="h-5 w-5" /> : association.other_type === 'deal' ? <Briefcase className="h-5 w-5" /> : <Users className="h-5 w-5" />}
                  </div>
                  <div>
                    <div className="font-semibold">{association.entity_name}</div>
                    <div className="text-sm capitalize text-white/40">{association.other_type}</div>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-white/55">{association.reason}</p>
                <div className="mt-4 h-1.5 rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-pink-400" style={{ width: `${association.strength || 70}%` }} />
                </div>
              </Link>
            ))}
          </section>
        )}

        {activeTab === 'documents' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.025]">
            {demoActionDocuments.slice(0, 6).map((doc: any) => (
              <div key={doc.id} className="flex flex-wrap items-center gap-4 border-b border-white/10 px-5 py-4 last:border-b-0">
                <FileText className="h-5 w-5 text-pink-300" />
                <div className="min-w-[220px] flex-1">
                  <div className="font-semibold">{doc.title || doc.file_name}</div>
                  <div className="text-sm text-white/35">Demo document · preview safe</div>
                </div>
                <button className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/60">Preview</button>
                <button className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/60">Download</button>
              </div>
            ))}
          </section>
        )}

        {activeTab === 'deals' && (
          <section className="grid gap-4 md:grid-cols-2">
            <Link href={`/deals/${DEMO_IDS.deal}?demo=1`} className="rounded-2xl border border-pink-500/30 bg-pink-500/5 p-5 hover:border-pink-400">
              <div className="text-xl font-semibold">FIFA</div>
              <p className="mt-3 text-white/55">
                Fictional deal profile connected to Google and the Donald Trump demo contact for screen recording.
              </p>
            </Link>
          </section>
        )}
      </main>
    </div>
  );
}
