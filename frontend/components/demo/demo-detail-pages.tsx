'use client';

import React from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Calendar,
  FileText,
  Globe,
  Hash,
  Mail,
  MapPin,
  MessageSquareText,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import {
  DEMO_IDS,
  demoAssociations,
  demoCompany,
  demoCompanyUpdates,
  demoContact,
  demoContactTimeline,
  demoDeal,
  demoDocuments,
  demoObservations,
} from '@/lib/demo-mode';
import { DemoDocumentCard } from './demo-document-card';

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-text-primary">{value}</div>
      {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function ObservationCards() {
  return (
    <div className="space-y-2">
      {demoObservations.map(obs => (
        <div key={obs.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-magenta">{obs.label}</div>
            <div className="text-[11px] text-text-muted">{obs.meta}</div>
          </div>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{obs.text}</p>
        </div>
      ))}
    </div>
  );
}

function DemoTimeline() {
  return (
    <div className="space-y-3">
      {demoContactTimeline.map((item, idx) => (
        <div key={`${item.title}-${idx}`} className="flex gap-3">
          <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent-magenta/25 bg-accent-magenta/10 text-accent-magenta">
            {item.type === 'meeting' ? <Calendar size={15} /> : item.type === 'document' ? <FileText size={15} /> : <Mail size={15} />}
          </div>
          <div className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium text-text-primary">{item.title}</div>
              <div className="shrink-0 text-xs text-text-muted">{item.date}</div>
            </div>
            <p className="mt-1 text-sm leading-6 text-text-secondary">{item.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function AssociationList() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {demoAssociations.map(a => (
        <Link key={a.name} href={a.href} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-accent-magenta/30 hover:bg-accent-magenta/[0.04]">
          <div className="text-sm font-semibold text-text-primary">{a.name}</div>
          <div className="mt-1 text-xs text-text-muted">{a.type}</div>
          <div className="mt-3 text-sm text-text-secondary">{a.strength}</div>
        </Link>
      ))}
    </div>
  );
}

export function DemoContactDetail() {
  const [tab, setTab] = React.useState<'overview' | 'timeline' | 'associations' | 'documents' | 'deals'>('overview');
  const tabs = [
    ['overview', 'Overview'],
    ['timeline', 'Timeline'],
    ['associations', 'Associations'],
    ['documents', 'Documents'],
    ['deals', 'Deals'],
  ] as const;

  return (
    <div className="flex-1 overflow-auto">
      <TopBar
        title={demoContact.full_name}
        breadcrumb={<span className="text-text-muted">Contacts / Demo Mode</span>}
        actions={<span className="rounded-full border border-accent-magenta/25 bg-accent-magenta/10 px-3 py-1.5 text-xs text-accent-magenta">UI-only demo</span>}
      />

      <div className="border-b border-border bg-bg-elevated/30 px-6 py-7 md:px-10">
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-3xl font-semibold text-white shadow-xl">
            D
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-text-primary">{demoContact.full_name}</h1>
              <span className="badge">Individual</span>
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                Active
              </span>
            </div>
            <div className="mt-2 text-text-secondary">
              {demoContact.job_title} at{' '}
              <Link href={`/companies/${DEMO_IDS.company}`} className="text-accent-magenta hover:underline">
                {demoContact.company_name}
              </Link>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-sm text-text-muted">
              <span className="inline-flex items-center gap-1.5"><Mail size={14} /> {demoContact.email}</span>
              <span className="inline-flex items-center gap-1.5"><MapPin size={14} /> {demoContact.location}</span>
              <span className="inline-flex items-center gap-1.5"><Sparkles size={14} /> Demo relationship warmth 86%</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid border-b border-border md:grid-cols-5">
        <StatCard label="Status" value="Active" sub="Based on fictional recency" />
        <StatCard label="Last Contact" value="Today" sub="Demo call logged" />
        <StatCard label="Interactions" value="42" sub="Synthetic touchpoints" />
        <StatCard label="Meetings (30d)" value="5" sub="Demo meetings" />
        <StatCard label="Owner" value="Tony" sub="Demo account owner" />
      </div>

      <div className="flex gap-6 overflow-x-auto border-b border-border px-6 md:px-10">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`shrink-0 border-b-2 px-2 py-4 text-sm transition-colors ${
              tab === key ? 'border-accent-magenta text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-6 p-6 md:p-10">
        {tab === 'overview' && (
          <>
            <Section title="Recent Observations" icon={<Sparkles size={14} />}>
              <ObservationCards />
            </Section>
            <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
              <Section title="Intel Brief" icon={<Target size={14} />}>
                <p className="text-sm leading-7 text-text-secondary">
                  Demo-only brief: Donald Trump is shown as a warm fictional relationship tied to Google and a FIFA-themed opportunity.
                  The profile is intentionally dense for filming, with safe synthetic details about sports media, executive introductions,
                  and event-platform diligence.
                </p>
              </Section>
              <Section title="Topics And Interests" icon={<Hash size={14} />}>
                <div className="flex flex-wrap gap-2">
                  {['Sports media', 'AI workflows', 'Event operations', 'Sponsorship data', 'Strategic introductions'].map(topic => (
                    <span key={topic} className="rounded-full bg-accent-magenta/10 px-3 py-1 text-xs font-medium text-accent-magenta">{topic}</span>
                  ))}
                </div>
              </Section>
            </div>
          </>
        )}
        {tab === 'timeline' && <Section title="Timeline" icon={<Calendar size={14} />}><DemoTimeline /></Section>}
        {tab === 'associations' && <Section title="Associations" icon={<Users size={14} />}><AssociationList /></Section>}
        {tab === 'documents' && (
          <Section title="Documents" icon={<FileText size={14} />}>
            <div className="space-y-3">{demoDocuments.map(doc => <DemoDocumentCard key={doc.id} doc={doc} />)}</div>
          </Section>
        )}
        {tab === 'deals' && (
          <Section title="Related Deals" icon={<Briefcase size={14} />}>
            <Link href={`/deals/${DEMO_IDS.deal}`} className="block rounded-xl border border-accent-magenta/25 bg-accent-magenta/[0.06] p-4 hover:bg-accent-magenta/[0.09]">
              <div className="text-base font-semibold text-text-primary">FIFA</div>
              <p className="mt-2 line-clamp-2 text-sm leading-6 text-text-secondary">
                Fictional sports-media workflow deal with synthetic diligence, sentiment, documents, and stakeholder context.
              </p>
            </Link>
          </Section>
        )}
      </div>
    </div>
  );
}

export function DemoCompanyDetail() {
  return (
    <div className="flex-1 overflow-auto">
      <TopBar
        title={demoCompany.name}
        breadcrumb={<span className="text-text-muted">Companies / Demo Mode</span>}
        actions={<span className="rounded-full border border-accent-magenta/25 bg-accent-magenta/10 px-3 py-1.5 text-xs text-accent-magenta">UI-only demo</span>}
      />
      <div className="space-y-6 p-6 md:p-10">
        <div className="flex flex-col gap-5 rounded-2xl border border-white/10 bg-white/[0.03] p-6 md:flex-row md:items-start">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-white text-3xl font-bold text-slate-950">G</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-text-primary">{demoCompany.name}</h1>
              <span className="badge">Corporation</span>
              <span className="badge">Tracking</span>
            </div>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-text-secondary">{demoCompany.description}</p>
            <div className="mt-4 flex flex-wrap gap-3 text-sm text-text-muted">
              <span className="inline-flex items-center gap-1.5"><Globe size={14} /> {demoCompany.domain}</span>
              <span className="inline-flex items-center gap-1.5"><MapPin size={14} /> {demoCompany.location_mentioned}</span>
              <span className="inline-flex items-center gap-1.5"><Target size={14} /> {demoCompany.sector}</span>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <StatCard label="News Score" value="9.2" sub="Demo relevance" />
          <StatCard label="Contacts" value="14" sub="Synthetic links" />
          <StatCard label="Active Topics" value="6" sub="AI + sports media" />
          <StatCard label="Linked Deals" value="1" sub="FIFA" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <Section title="Company Intel Brief" icon={<Sparkles size={14} />}>
            <p className="text-sm leading-7 text-text-secondary">
              Demo-only Google profile: the fictional story centers on enterprise AI workflows, live-event tooling, and a safe synthetic
              connection to the FIFA deal. This view is fully populated for filming without exposing real portfolio, contact, or deal records.
            </p>
          </Section>
          <Section title="Associated Contacts" icon={<Users size={14} />}>
            <AssociationList />
          </Section>
        </div>

        <Section title="News-Style Updates" icon={<MessageSquareText size={14} />}>
          <div className="space-y-2">
            {demoCompanyUpdates.map(update => (
              <div key={update} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm leading-6 text-text-secondary">
                {update}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Timeline" icon={<Calendar size={14} />}><DemoTimeline /></Section>
        <Section title="Documents" icon={<FileText size={14} />}>
          <div className="space-y-3">{demoDocuments.map(doc => <DemoDocumentCard key={doc.id} doc={doc} />)}</div>
        </Section>
      </div>
    </div>
  );
}

export function DemoDealDetail() {
  return (
    <div className="flex-1 overflow-auto">
      <TopBar
        title="FIFA"
        breadcrumb={<span className="text-text-muted">Deals / Demo Mode</span>}
        actions={<Link href="/deals" className="btn-secondary"><ArrowLeft size={14} /> Back to deals</Link>}
      />
      <div className="space-y-6 p-6 md:p-10">
        <div className="rounded-2xl border border-accent-magenta/25 bg-accent-magenta/[0.05] p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold text-text-primary">FIFA</h1>
                <span className="rounded-full border border-accent-magenta/25 bg-accent-magenta/10 px-3 py-1 text-xs font-semibold text-accent-magenta">New</span>
                <span className="badge">Growth</span>
              </div>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-text-secondary">{demoDeal.notes}</p>
            </div>
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.08] px-5 py-3 text-right">
              <div className="text-xs uppercase tracking-[0.14em] text-emerald-300/80">Pipeline</div>
              <div className="text-2xl font-bold text-emerald-300">$65.0M</div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <StatCard label="Last Activity" value="Today" sub="Demo evidence update" />
          <StatCard label="Deal Age" value="31 days" sub="First synthetic signal" />
          <StatCard label="Evidence" value="8" sub="Across 3 source families" />
          <StatCard label="Firm Sentiment" value="Positive" sub="Demo-only snapshot" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.4fr_0.8fr]">
          <div className="space-y-6">
            <Section title="Intelligence Brief" icon={<Sparkles size={14} />}>
              <p className="text-sm leading-7 text-text-secondary">
                FIFA is presented as a fictional sports-media workflow opportunity. Recent synthetic activity points to a partner workshop,
                a diligence memo, and an internal discussion about event-scale sponsor data products. The demo card is designed to look
                like a real investment workflow while staying completely separate from production data.
              </p>
            </Section>
            <Section title="Firm Sentiment" icon={<MessageSquareText size={14} />}>
              <p className="mb-3 text-sm leading-6 text-text-secondary">
                Recent internal demo notes are constructive: the team likes the market narrative and wants clearer scope around product ownership.
              </p>
              <div className="space-y-2">
                {[
                  'Synthetic Slack note: “The sports data angle is clean; need sharper buyer map.”',
                  'Synthetic email excerpt: “Let’s keep the memo tight and separate rights-holder workflow from sponsor analytics.”',
                  'Synthetic meeting note: “Next step is a mock diligence call with Google demo stakeholders.”',
                ].map(line => (
                  <div key={line} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-text-secondary">{line}</div>
                ))}
              </div>
            </Section>
            <Section title="Evidence" icon={<Target size={14} />}>
              <div className="space-y-2">
                {[
                  'Demo deck references global event workflow pain around sponsor coordination.',
                  'Demo meeting transcript includes explicit diligence language and buyer discovery.',
                  'Demo email thread requests a memo and follow-up call.',
                  'Demo document packet contains a fictional market map and operating plan.',
                ].map(line => (
                  <div key={line} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-text-secondary">{line}</div>
                ))}
              </div>
            </Section>
            <Section title="Notes" icon={<FileText size={14} />}>
              <textarea
                readOnly
                value="Demo mode note: recording-safe content only. Mutations are disabled, so typing here will not write to production."
                className="input min-h-[120px] w-full resize-none"
              />
            </Section>
          </div>
          <div className="space-y-6">
            <Section title="Lead Source" icon={<Users size={14} />}>
              <p className="text-sm leading-6 text-text-secondary">Demo intro from Donald Trump via the Google synthetic relationship profile.</p>
            </Section>
            <Section title="Associated People And Companies" icon={<Building2 size={14} />}>
              <AssociationList />
            </Section>
            <Section title="Active Topics" icon={<Hash size={14} />}>
              <div className="flex flex-wrap gap-2">
                {demoDeal.topics.map(topic => (
                  <span key={topic} className="rounded-full bg-accent-magenta/10 px-3 py-1 text-xs font-medium text-accent-magenta">{topic}</span>
                ))}
              </div>
            </Section>
          </div>
        </div>

        <Section title="Documents" icon={<FileText size={14} />}>
          <div className="space-y-3">{demoDocuments.map(doc => <DemoDocumentCard key={doc.id} doc={doc} />)}</div>
        </Section>
        <Section title="Timeline" icon={<Calendar size={14} />}><DemoTimeline /></Section>
      </div>
    </div>
  );
}
