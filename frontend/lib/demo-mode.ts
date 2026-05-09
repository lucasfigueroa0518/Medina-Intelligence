'use client';

import React from 'react';
import type { DealIntelligence } from './use-deal-intelligence';

export const DEMO_MODE_STORAGE_KEY = 'medina-intelligence-demo-mode';

export const DEMO_IDS = {
  contact: 'demo-contact-donald-trump',
  company: 'demo-company-google',
  deal: 'demo-deal-fifa',
};

export type DemoDocument = {
  id: string;
  title: string;
  file_name: string;
  mime_type: string;
  document_type: string;
  source: string;
  date: string;
  size: string;
  body: string;
};

export function useDemoMode(): boolean {
  const [enabled, setEnabled] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    const toggle = new URLSearchParams(window.location.search).get('demo');
    if (toggle === '1') return true;
    if (toggle === '0') return false;
    return window.localStorage.getItem(DEMO_MODE_STORAGE_KEY) === '1';
  });

  React.useEffect(() => {
    const toggle = new URLSearchParams(window.location.search).get('demo');
    if (toggle === '1') {
      window.localStorage.setItem(DEMO_MODE_STORAGE_KEY, '1');
      setEnabled(true);
      return;
    }
    if (toggle === '0') {
      window.localStorage.removeItem(DEMO_MODE_STORAGE_KEY);
      setEnabled(false);
      return;
    }
    setEnabled(window.localStorage.getItem(DEMO_MODE_STORAGE_KEY) === '1');
  }, []);

  return enabled;
}

export function demoToastMessage(action = 'That action') {
  return `${action} is disabled in UI-only Demo Mode. No production data was changed.`;
}

export function downloadDemoDocument(doc: DemoDocument) {
  const blob = new Blob([doc.body], { type: doc.mime_type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.file_name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const demoTags = [
  { id: 'demo-tag-strategic', name: 'Strategic', color: '#D946A8' },
  { id: 'demo-tag-media', name: 'Media', color: '#A855F7' },
  { id: 'demo-tag-sports', name: 'Sports', color: '#22C55E' },
  { id: 'demo-tag-partnership', name: 'Partnership', color: '#3B82F6' },
];

export const DEMO_CONTACT_TOTAL = 3479;
export const DEMO_COMPANY_TOTAL = 1952;

const DAY_MS = 86400000;

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function demoEmail(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.+|\.+$/g, '');
  return `${slug}@example.test`;
}

export const demoContact = {
  id: DEMO_IDS.contact,
  full_name: 'Donald Trump',
  email: 'donald.trump@example.test',
  phone: '+1 (555) 010-2026',
  job_title: 'Demo Principal',
  contact_type: 'individual',
  engagement_status: 'active',
  last_contact_date: new Date().toISOString(),
  total_interactions: 42,
  company_id: DEMO_IDS.company,
  company_name: 'Google',
  location: 'Palm Beach, FL',
  linkedin_url: 'https://example.test/demo/donald-trump',
  twitter_url: 'https://example.test/demo/donald-trump',
  owner_name: 'Tony Jimenez',
  owner_email: 'tony@example.test',
  relationship_warmth: 86,
  investment_focus: 'Media rights, sports platforms, large-scale event infrastructure',
  check_size_range: '$1M - $5M',
  tags: [demoTags[0], demoTags[1], demoTags[2]],
};

const demoContactRows = [
  ['Ava Morales', 'Google', 'warm', 18, [demoTags[3]], 1],
  ['Marco Silva', 'FIFA', 'new', 9, [demoTags[2]], 2],
  ['Nora Bennett', 'Northstar Ventures', 'active', 64, [demoTags[0], demoTags[3]], 0],
  ['Julian Reyes', 'StadiumOS', 'warm', 31, [demoTags[2]], 1],
  ['Priya Shah', 'Meridian Broadcast AI', 'active', 52, [demoTags[1]], 2],
  ['Ethan Brooks', 'SignalBox Sports', 'new', 11, [demoTags[2], demoTags[3]], 3],
  ['Maya Chen', 'Apex Cloud Media', 'active', 77, [demoTags[0]], 4],
  ['Leo Martinez', 'GlobalFan Cloud', 'warm', 26, [demoTags[2]], 5],
  ['Sofia Reed', 'CrowdLens', 'active', 43, [demoTags[1], demoTags[3]], 6],
  ['Caleb Foster', 'SponsorFlow', 'dormant', 7, [demoTags[3]], 8],
  ['Amara Johnson', 'QuantumVenue', 'new', 15, [demoTags[0], demoTags[2]], 9],
  ['Miles Carter', 'HaloTicket', 'active', 89, [demoTags[2]], 10],
  ['Elena Novak', 'TerraPass Events', 'warm', 34, [demoTags[0]], 11],
  ['Theo Grant', 'FanRail Labs', 'active', 56, [demoTags[1]], 12],
  ['Isla Morgan', 'Matchday Data', 'warm', 22, [demoTags[2], demoTags[1]], 13],
  ['Owen Walker', 'CivicArena', 'new', 6, [demoTags[3]], 15],
  ['Lena Patel', 'BlueCourt Systems', 'active', 71, [demoTags[0], demoTags[3]], 16],
  ['Andre Lewis', 'MediaMint', 'warm', 28, [demoTags[1]], 17],
  ['Clara Evans', 'Orbit Rights', 'active', 39, [demoTags[2]], 18],
  ['Victor Hale', 'SummitView Capital', 'dormant', 5, [demoTags[0]], 19],
  ['Grace Kim', 'LiveOps Grid', 'new', 13, [demoTags[3]], 21],
  ['Henry Walsh', 'Atlas Fan Intelligence', 'warm', 24, [demoTags[2]], 22],
  ['Zara Ahmed', 'VenueGrid', 'active', 47, [demoTags[0], demoTags[2]], 23],
  ['Noah Price', 'Brightline Ventures', 'warm', 19, [demoTags[3]], 24],
] as const;

export const demoContacts = [
  demoContact,
  ...demoContactRows.map(([full_name, company_name, engagement_status, total_interactions, tags, daysAgo], index) => ({
    id: `demo-contact-row-${index + 1}`,
    full_name,
    email: demoEmail(full_name),
    company_name,
    contact_type: 'individual',
    engagement_status,
    last_contact_date: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    total_interactions,
    tags,
  })),
];

export const demoCompany = {
  id: DEMO_IDS.company,
  name: 'Google',
  domain: 'google.example.test',
  website: 'https://example.test/google-demo',
  sector: 'AI infrastructure and consumer platforms',
  company_type: 'corporation',
  investment_status: 'tracking',
  stage: 'public',
  hq_location: 'Mountain View, CA',
  city: 'Mountain View',
  description:
    'Demo-only company profile used for screen recording. The fictional relationship highlights enterprise AI, sports media tooling, and event-scale data products without exposing real firm information.',
  news_relevance_score: 9.2,
  logo_url: null,
  tags: [demoTags[0], demoTags[3]],
};

const demoCompanyRows = [
  ['FIFA', 'Sports media and live events', 'corporation', 'tracking', 'growth', 'Zurich, Switzerland', 8.6, [demoTags[2]]],
  ['Sunrise Analytics', 'Predictive analytics', 'startup', 'prospect', 'series_a', 'Miami, FL', 6.8, [demoTags[1]]],
  ['Northstar Ventures', 'Private markets platform', 'vc_firm', 'tracking', 'fund', 'New York, NY', 7.4, [demoTags[0]]],
  ['StadiumOS', 'Venue operating system', 'startup', 'due_diligence', 'seed', 'Austin, TX', 7.1, [demoTags[2], demoTags[3]]],
  ['Meridian Broadcast AI', 'AI broadcast tooling', 'startup', 'prospect', 'series_b', 'Los Angeles, CA', 6.9, [demoTags[1]]],
  ['SignalBox Sports', 'Fan data infrastructure', 'startup', 'tracking', 'series_a', 'Atlanta, GA', 6.5, [demoTags[2]]],
  ['Apex Cloud Media', 'Cloud media workflows', 'corporation', 'tracking', 'growth', 'Seattle, WA', 7.8, [demoTags[0], demoTags[1]]],
  ['GlobalFan Cloud', 'International fan engagement', 'startup', 'term_sheet', 'series_b', 'London, UK', 7.6, [demoTags[2]]],
  ['CrowdLens', 'Audience intelligence', 'startup', 'prospect', 'seed', 'Chicago, IL', 6.2, [demoTags[1], demoTags[3]]],
  ['SponsorFlow', 'Sponsorship CRM', 'startup', 'tracking', 'series_a', 'Denver, CO', 5.8, [demoTags[3]]],
  ['QuantumVenue', 'Event forecasting tools', 'startup', 'due_diligence', 'series_a', 'Boston, MA', 7.0, [demoTags[0], demoTags[2]]],
  ['HaloTicket', 'Ticketing workflow layer', 'startup', 'prospect', 'seed', 'Nashville, TN', 6.1, [demoTags[2]]],
  ['TerraPass Events', 'Sustainable event logistics', 'startup', 'due_diligence', 'series_a', 'Portland, OR', 6.6, [demoTags[0]]],
  ['FanRail Labs', 'Sports commerce rails', 'startup', 'tracking', 'seed', 'Charlotte, NC', 5.9, [demoTags[1]]],
  ['Matchday Data', 'Live match analytics', 'startup', 'invested', 'series_b', 'Dallas, TX', 8.1, [demoTags[2], demoTags[1]]],
  ['CivicArena', 'Municipal venue software', 'startup', 'prospect', 'seed', 'Tampa, FL', 5.4, [demoTags[3]]],
  ['BlueCourt Systems', 'Court operations software', 'startup', 'tracking', 'series_a', 'Raleigh, NC', 6.4, [demoTags[0], demoTags[3]]],
  ['MediaMint', 'Rights packaging tools', 'startup', 'prospect', 'seed', 'San Francisco, CA', 6.0, [demoTags[1]]],
  ['Orbit Rights', 'Global media-rights data', 'startup', 'tracking', 'series_b', 'Toronto, Canada', 7.2, [demoTags[2]]],
  ['SummitView Capital', 'Demo family office', 'family_office', 'tracking', 'fund', 'Palm Beach, FL', 5.7, [demoTags[0]]],
  ['LiveOps Grid', 'Operations command center', 'startup', 'prospect', 'series_a', 'Phoenix, AZ', 6.3, [demoTags[3]]],
  ['Brightline Ventures', 'Demo VC firm', 'vc_firm', 'tracking', 'fund', 'Miami, FL', 5.9, [demoTags[3]]],
] as const;

export const demoCompanies = [
  demoCompany,
  ...demoCompanyRows.map(([name, sector, company_type, investment_status, stage, hq_location, news_relevance_score, tags], index) => ({
    id: `demo-company-row-${index + 1}`,
    name,
    domain: null,
    website: 'https://example.test/demo-company',
    sector,
    company_type,
    investment_status,
    stage,
    hq_location,
    news_relevance_score,
    logo_url: null,
    tags,
  })),
];

export const demoDocuments: DemoDocument[] = [
  {
    id: 'demo-doc-contact-brief',
    title: 'Donald Trump Demo Relationship Brief',
    file_name: 'donald-trump-demo-relationship-brief.pdf',
    mime_type: 'application/pdf',
    document_type: 'Relationship Brief',
    source: 'Demo Mode',
    date: 'May 9, 2026',
    size: '184 KB',
    body:
      'Demo Relationship Brief\n\nThis synthetic document describes a fictional relationship used only for screen recording. Key themes: sports media distribution, executive introductions, event programming, and strategic communications. No production records were used to create this file.',
  },
  {
    id: 'demo-doc-google-overview',
    title: 'Google Demo Company Overview',
    file_name: 'google-demo-company-overview.docx',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    document_type: 'Company Overview',
    source: 'Demo Mode',
    date: 'May 8, 2026',
    size: '96 KB',
    body:
      'Google Demo Company Overview\n\nFictional overview for filming: platform strengths, partner ecosystem, live-event infrastructure themes, and AI-enabled workflow opportunities. This is UI-only fixture content.',
  },
  {
    id: 'demo-doc-fifa-memo',
    title: 'FIFA Demo Deal Memo',
    file_name: 'fifa-demo-deal-memo.pdf',
    mime_type: 'application/pdf',
    document_type: 'Deal Memo',
    source: 'Demo Mode',
    date: 'May 7, 2026',
    size: '228 KB',
    body:
      'FIFA Demo Deal Memo\n\nFictional investment narrative for a global sports-media workflow platform. Sections: opportunity, thesis, firm sentiment, diligence checklist, customer discovery, and next steps. This content is synthetic and safe for recording.',
  },
];

export const demoContactTimeline = [
  { type: 'meeting', title: 'Demo intro call with Google media team', date: 'Today', detail: 'Discussed a fictional sports analytics partnership and follow-up materials.' },
  { type: 'email', title: 'Follow-up: FIFA demo diligence packet', date: 'Yesterday', detail: 'Shared synthetic materials and scheduled a prep call.' },
  { type: 'task', title: 'Prepare event-programming notes', date: '2d ago', detail: 'Internal demo task for a screen-recording workflow.' },
  { type: 'document', title: 'Relationship brief added', date: '3d ago', detail: 'Demo brief attached to the contact profile.' },
  { type: 'meeting', title: 'Synthetic partner strategy review', date: '5d ago', detail: 'Reviewed fictional contacts, associations, and next steps.' },
  { type: 'email', title: 'Demo warm intro from Google to FIFA', date: '1w ago', detail: 'Introduced fictional stakeholders for the fake deal workflow.' },
];

export const demoObservations = [
  {
    label: 'Relationship signal',
    text: 'Frequent demo touchpoints suggest a warm relationship and clear follow-up path.',
    meta: 'Today · 94%',
  },
  {
    label: 'Interest area',
    text: 'Conversation themes cluster around sports media, AI workflow, sponsorship data, and live-event operations.',
    meta: '1d ago · 91%',
  },
  {
    label: 'Next action',
    text: 'Prepare a concise briefing packet and route the FIFA deal memo for review.',
    meta: '2d ago · 88%',
  },
];

export const demoAssociations = [
  { name: 'Google', type: 'Company', strength: 'Primary relationship', href: `/companies/${DEMO_IDS.company}` },
  { name: 'FIFA', type: 'Deal / Company', strength: 'Active demo opportunity', href: `/deals/${DEMO_IDS.deal}` },
  { name: 'Ava Morales', type: 'Contact', strength: 'Operating partner', href: '#' },
  { name: 'Marco Silva', type: 'Contact', strength: 'Sports media lead', href: '#' },
];

export const demoDeal = {
  id: DEMO_IDS.deal,
  title: 'FIFA',
  company_name: 'FIFA',
  company_id: 'demo-company-fifa',
  amount: 65000000,
  stage: 'new',
  funding_stage: 'growth',
  created_at: new Date(Date.now() - 31 * 86400000).toISOString(),
  updated_at: new Date().toISOString(),
  last_inferred_activity_date: new Date().toISOString(),
  evidence_first_seen_at: new Date(Date.now() - 31 * 86400000).toISOString(),
  evidence_last_seen_at: new Date().toISOString(),
  topics: ['#sports-media', '#global-events', '#ai-workflow', '#sponsorship-data'],
  notes:
    'Fictional deal profile for screen recording. The current thesis is a sports media workflow platform that helps global event teams coordinate sponsors, data rooms, and broadcast partners.',
};

export const demoDeals = [
  demoDeal,
  {
    id: 'demo-deal-atlas',
    title: 'Atlas Fan Intelligence',
    company_name: 'Atlas Fan Intelligence',
    amount: 12000000,
    stage: 'new',
    funding_stage: 'series_a',
    created_at: new Date(Date.now() - 18 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 2 * 86400000).toISOString(),
    notes:
      'Two-line preview only: synthetic company building a fan-data cockpit for venues, rights holders, and sponsor activations across major events.',
  },
  {
    id: 'demo-deal-venuegrid',
    title: 'VenueGrid',
    company_name: 'VenueGrid',
    amount: 8000000,
    stage: 'talking',
    funding_stage: 'seed',
    created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - 3 * 86400000).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 3 * 86400000).toISOString(),
    notes:
      'Demo infrastructure startup coordinating event staffing, credentialing, and vendor communications from one operations surface.',
  },
  {
    id: 'demo-deal-signalbox',
    title: 'SignalBox Sports',
    company_name: 'SignalBox Sports',
    amount: 6000000,
    stage: 'talking',
    funding_stage: 'seed',
    created_at: new Date(Date.now() - 14 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    notes: 'Synthetic sports-data startup building a lightweight command center for fan segmentation and sponsor reporting.',
  },
  {
    id: 'demo-deal-haloticket',
    title: 'HaloTicket',
    company_name: 'HaloTicket',
    amount: 9000000,
    stage: 'talking',
    funding_stage: 'series_a',
    created_at: new Date(Date.now() - 20 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 4 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 4 * DAY_MS).toISOString(),
    notes: 'Demo ticketing workflow company with a simple venue partner pipeline and early sponsor integrations.',
  },
  {
    id: 'demo-deal-terrapass',
    title: 'TerraPass Events',
    company_name: 'TerraPass Events',
    amount: 14000000,
    stage: 'due_diligence',
    funding_stage: 'series_a',
    created_at: new Date(Date.now() - 25 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    notes: 'Fictional event-logistics platform focused on sustainability reporting, vendor routing, and venue compliance.',
  },
  {
    id: 'demo-deal-quantumvenue',
    title: 'QuantumVenue',
    company_name: 'QuantumVenue',
    amount: 11000000,
    stage: 'due_diligence',
    funding_stage: 'series_a',
    created_at: new Date(Date.now() - 28 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 6 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 6 * DAY_MS).toISOString(),
    notes: 'Synthetic forecasting platform helping stadium operators plan staffing, security, and hospitality demand.',
  },
  {
    id: 'demo-deal-northstar-media',
    title: 'Northstar Media OS',
    company_name: 'Northstar Media OS',
    amount: 18000000,
    stage: 'due_diligence',
    funding_stage: 'series_b',
    created_at: new Date(Date.now() - 33 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 7 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 7 * DAY_MS).toISOString(),
    notes: 'Demo workflow layer for packaging media-rights opportunities and tracking stakeholder approvals.',
  },
  {
    id: 'demo-deal-globalfan',
    title: 'GlobalFan Cloud',
    company_name: 'GlobalFan Cloud',
    amount: 22000000,
    stage: 'term_sheet',
    funding_stage: 'series_b',
    created_at: new Date(Date.now() - 38 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    notes: 'Fictional fan-engagement company with term-sheet level sponsor interest and a large event rollout plan.',
  },
  {
    id: 'demo-deal-sponsorflow',
    title: 'SponsorFlow',
    company_name: 'SponsorFlow',
    amount: 7500000,
    stage: 'term_sheet',
    funding_stage: 'seed',
    created_at: new Date(Date.now() - 29 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    notes: 'Demo sponsorship CRM that turns partner conversations into clean pipeline notes, decks, and renewal tasks.',
  },
  {
    id: 'demo-deal-stadiumos',
    title: 'StadiumOS',
    company_name: 'StadiumOS',
    amount: 16000000,
    stage: 'closed',
    funding_stage: 'series_a',
    created_at: new Date(Date.now() - 52 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    notes: 'Synthetic closed demo investment for filming the final stage of the pipeline.',
  },
  {
    id: 'demo-deal-matchday-data',
    title: 'Matchday Data',
    company_name: 'Matchday Data',
    amount: 13000000,
    stage: 'closed',
    funding_stage: 'series_b',
    created_at: new Date(Date.now() - 61 * DAY_MS).toISOString(),
    updated_at: new Date(Date.now() - 9 * DAY_MS).toISOString(),
    last_inferred_activity_date: new Date(Date.now() - 9 * DAY_MS).toISOString(),
    notes: 'Demo analytics company already closed, used only to make the board feel populated during recording.',
  },
];

export const demoDetectedDeals = [
  {
    company_id: 'demo-detected-hedgehog',
    company_name: 'Hedgehog',
    evidence_count: 3,
    source_family_count: 2,
    source_families: ['email', 'meeting'],
    avg_confidence: 0.72,
    latest_evidence: {
      evidence_note: 'Synthetic lower-threshold signal: multiple mentions but not yet enough for automatic promotion.',
      source_excerpt: 'Demo evidence only.',
    },
  },
  {
    company_id: 'demo-detected-tier4',
    company_name: 'Tier 4',
    evidence_count: 2,
    source_family_count: 2,
    source_families: ['slack', 'document'],
    avg_confidence: 0.69,
    latest_evidence: {
      evidence_note: 'Demo candidate has enough signal for manual review, not enough for auto-New.',
      source_excerpt: 'Demo evidence only.',
    },
  },
  {
    company_id: 'demo-detected-toluai',
    company_name: 'TOLUAI',
    evidence_count: 3,
    source_family_count: 2,
    source_families: ['email', 'document'],
    avg_confidence: 0.74,
    latest_evidence: {
      evidence_note: 'Demo candidate appears in a deck and a follow-up note; user can pull it forward manually.',
      source_excerpt: 'Demo evidence only.',
    },
  },
];

export const demoCompanyUpdates = [
  'Fictional partner team reviewed an AI event operations workflow with demo stakeholders.',
  'Synthetic news signal: demo company announced a media tooling pilot for large event teams.',
  'Demo-only internal note flagged potential overlap with the FIFA opportunity and sponsor-data workflows.',
];

export const demoActionDocuments = demoDocuments.map((doc, index) => ({
  id: doc.id,
  title: doc.title,
  file_name: doc.file_name,
  mime_type: doc.mime_type,
  document_type: doc.document_type,
  source: doc.source,
  created_at: isoDaysAgo(index + 1),
  updated_at: isoDaysAgo(index),
  file_size: doc.size,
  size_bytes: 128000 + index * 64000,
  r2_key: `demo/${doc.file_name}`,
  extracted_text_preview: doc.body.slice(0, 240),
  processing_status: 'completed',
  version_number: 1,
  visibility: 'org_wide',
}));

function makeObservation(
  id: string,
  type: string,
  daysAgo: number,
  value: string,
  people: string[],
  evidence: string,
  confidence: number,
  speaker = 'MARTy demo',
) {
  return {
    id,
    observation_type: type,
    observation_value: JSON.stringify({
      speaker,
      signal_type: type,
      people_involved: people,
      value,
      evidence,
      confidence,
    }),
    channels: ['demo'],
    confidence,
    evidence,
    source_communication_id: null,
    first_observed_at: isoDaysAgo(daysAgo + 2),
    last_observed_at: isoDaysAgo(daysAgo),
  };
}

export const demoRecentObservationsForContact = [
  makeObservation(
    'demo-obs-contact-1',
    'relationship_signal',
    0,
    'Warm fictional relationship with a clear follow-up path.',
    ['Donald Trump', 'Tony Jimenez'],
    'Synthetic demo touchpoints show repeated briefings and document sharing.',
    0.94,
  ),
  makeObservation(
    'demo-obs-contact-2',
    'interest_area',
    1,
    'Interest clusters around sports media, AI workflow, sponsorship data, and live-event operations.',
    ['Donald Trump', 'Ava Morales'],
    'Demo-only conversations repeatedly mention large-event operations and sponsor reporting.',
    0.91,
  ),
  makeObservation(
    'demo-obs-contact-3',
    'next_action',
    2,
    'Prepare a concise briefing packet and route the FIFA deal memo for review.',
    ['Donald Trump', 'Marco Silva'],
    'Fictional follow-up note asks for a short packet before the next demo call.',
    0.88,
  ),
];

export const demoRecentObservationsForCompany = [
  makeObservation(
    'demo-obs-company-1',
    'market_signal',
    0,
    'Fictional partner team reviewed an AI event operations workflow with demo stakeholders.',
    ['Google', 'FIFA'],
    'Demo update references enterprise AI workflows and event-scale data products.',
    0.93,
  ),
  makeObservation(
    'demo-obs-company-2',
    'relationship_signal',
    2,
    'Google is shown as a synthetic strategic relationship linked to FIFA demo activity.',
    ['Google', 'Donald Trump'],
    'The demo fixture connects company, contact, and deal records for filming continuity.',
    0.9,
  ),
];

export const demoContactTimelineEntries = [
  {
    id: 'demo-timeline-1',
    type: 'event',
    subtype: 'meeting',
    title: 'Demo intro call with Google media team',
    timestamp: isoDaysAgo(0),
    body_preview: 'Discussed a fictional sports analytics partnership and follow-up materials.',
    occurrence_count: 1,
  },
  {
    id: 'demo-timeline-2',
    type: 'conversation',
    subtype: 'outlook',
    title: 'Follow-up: FIFA demo diligence packet',
    timestamp: isoDaysAgo(1),
    body_preview: 'Shared synthetic materials and scheduled a prep call.',
    canReadContent: true,
    external_thread_id: 'demo-thread-fifa-1',
    attachment_count: 1,
  },
  {
    id: 'demo-timeline-3',
    type: 'task',
    subtype: 'follow_up',
    title: 'Prepare event-programming notes',
    timestamp: isoDaysAgo(2),
    body_preview: 'Internal demo task for a screen-recording workflow.',
    occurrence_count: 1,
  },
  {
    id: 'demo-timeline-4',
    type: 'document',
    subtype: 'attachment',
    title: 'Relationship brief added',
    timestamp: isoDaysAgo(3),
    body_preview: 'Demo brief attached to the contact profile.',
    occurrence_count: 1,
  },
  {
    id: 'demo-timeline-5',
    type: 'event',
    subtype: 'meeting',
    title: 'Synthetic partner strategy review',
    timestamp: isoDaysAgo(5),
    body_preview: 'Reviewed fictional contacts, associations, and next steps.',
    occurrence_count: 1,
  },
  {
    id: 'demo-timeline-6',
    type: 'conversation',
    subtype: 'slack',
    title: 'Demo warm intro from Google to FIFA',
    timestamp: isoDaysAgo(7),
    body_preview: 'Introduced fictional stakeholders for the fake deal workflow.',
    canReadContent: true,
    external_thread_id: 'demo-thread-google-fifa',
    attachment_count: 0,
  },
];

const demoContactBio =
  'Demo-only intelligence brief: Donald Trump is shown as a warm fictional relationship tied to Google and a FIFA-themed opportunity. The profile is intentionally dense for filming, with safe synthetic details about sports media, sponsorship data, and event operations.\n\nRecent activity suggests a clear next step: prepare a briefing packet, confirm stakeholders, and review the demo FIFA memo before the next fictional meeting.';

export const demoContactDetailFixture = {
  contact: {
    ...demoContact,
    bio_summary: demoContactBio,
    topics_of_interest: JSON.stringify([
      'Sports media',
      'AI workflows',
      'Event operations',
      'Sponsorship data',
      'Strategic introductions',
    ]),
    source_confidence: 0.96,
    email_frequency_score: 2.4,
    meetings_last_30d: 5,
    created_at: isoDaysAgo(45),
    updated_at: isoDaysAgo(0),
    last_contact_date: isoDaysAgo(0),
  },
  tags: demoContact.tags,
  associations: demoAssociations,
  entity_associations: demoAssociations.map((a, index) => ({
    id: `demo-assoc-${index}`,
    entity_type: a.type.toLowerCase().includes('company')
      ? 'company'
      : a.type.toLowerCase().includes('deal')
        ? 'deal'
        : 'contact',
    entity_id: a.href.split('/').pop() || `demo-assoc-${index}`,
    display_name: a.name,
    name: a.name,
    relationship_type: a.strength,
    strength_score: 0.92 - index * 0.06,
  })),
  signals: [
    {
      id: 'demo-signal-1',
      field_name: 'relationship_warmth',
      proposed_value: 'Warm relationship with clear next step',
      confidence: 0.94,
      created_at: isoDaysAgo(0),
    },
  ],
  weekly_interactions: [
    { week: isoDaysAgo(0), count: 8 },
    { week: isoDaysAgo(7), count: 5 },
    { week: isoDaysAgo(14), count: 7 },
    { week: isoDaysAgo(21), count: 3 },
  ],
  first_interaction_date: isoDaysAgo(90),
  timeline: demoContactTimelineEntries,
  full_bio: demoContactBio,
  enrichment_meta: { enrichment_last_run: isoDaysAgo(1), source: 'demo_mode', confidence: 0.96, contributions: 7 },
  pending_updates: [],
  documents: demoActionDocuments,
};

const demoCompanyBio =
  'Demo-only Google company profile: the fictional story centers on enterprise AI workflows, live-event tooling, and a safe synthetic connection to the FIFA deal. This page is populated through the normal company UI so the recording reflects the real product surface without exposing production data.';

export const demoCompanyDetailFixture = {
  data: {
    company: {
      ...demoCompany,
      description: demoCompany.description,
      bio_summary: demoCompanyBio,
      created_at: isoDaysAgo(120),
      updated_at: isoDaysAgo(0),
      location: demoCompany.hq_location,
    },
    contacts: demoContacts.slice(0, 10).map((c, index) => ({
      ...c,
      company_id: DEMO_IDS.company,
      job_title: index === 0 ? 'Demo Principal' : 'Demo stakeholder',
    })),
    deals: demoDeals.slice(0, 5).map(d => ({ ...d, company_id: (d as any).company_id || DEMO_IDS.company })),
    news_articles: demoCompanyUpdates.map((title, index) => ({
      id: `demo-news-${index}`,
      title,
      summary: title,
      source_name: 'Demo Mode',
      published_at: isoDaysAgo(index + 1),
      relevance_tag: index === 0 ? 'direct_mention' : 'industry_trend',
    })),
  },
  tags: demoCompany.tags,
  full_bio: demoCompanyBio,
  enrichment_meta: { enrichment_last_run: isoDaysAgo(1), source: 'demo_mode', confidence: 0.94, contributions: 6 },
  associations: demoAssociations.map((a, index) => ({
    id: `demo-company-assoc-${index}`,
    entity_type: a.type.toLowerCase().includes('deal') ? 'deal' : a.type.toLowerCase().includes('contact') ? 'contact' : 'company',
    entity_id: a.href.split('/').pop() || `demo-company-assoc-${index}`,
    display_name: a.name,
    name: a.name,
    relationship_type: a.strength,
    strength_score: 0.9 - index * 0.05,
  })),
  documents: demoActionDocuments,
};

export const demoDealIntelligenceFixture: DealIntelligence & {
  firm_sentiment_summary: string;
  momentum_history: number[];
  risk_level: string;
  risk_summary: string;
  risk_count: number;
} = {
  deal_id: DEMO_IDS.deal,
  user_id: 'demo-user',
  brief_summary:
    'FIFA is a fictional demo opportunity centered on sports media workflows, sponsorship data, and global event operations. Recent synthetic activity shows constructive internal interest, a clean follow-up path, and documents ready for review.',
  sentiment: 'positive',
  sentiment_score: 0.68,
  conversation_count: 3,
  firm_sentiment_summary:
    'Internal demo sentiment is constructive: the team is aligned on the thesis and wants a concise diligence packet before next steps.',
  topics: ['sports media', 'global events', 'sponsorship data', 'AI workflow'],
  momentum: 'accelerating',
  momentum_score: 0.78,
  momentum_history: [0.52, 0.6, 0.66, 0.72, 0.78],
  risk_signals: [
    {
      type: 'integration_complexity',
      severity: 'warning',
      detail: 'Demo diligence should pressure-test event data integrations before next steps.',
    },
    {
      type: 'data_quality',
      severity: 'info',
      detail: 'Synthetic sponsor reporting assumptions need confirmation in a follow-up packet.',
    },
  ],
  risk_level: 'medium',
  risk_summary: 'Synthetic risk flags focus on integration complexity and sponsor-data quality.',
  risk_count: 2,
  computed_at: new Date().toISOString(),
  is_stale: false,
};

export const demoDealDetailFixture = {
  bundle: {
    deal: {
      ...demoDeal,
      title: 'FIFA',
      company_name: 'FIFA',
      stage: 'new',
      lead_source: 'Demo relationship map',
      evidence_count: 5,
      source_family_count: 3,
    },
    company: {
      id: 'demo-company-fifa',
      name: 'FIFA',
      company_type: 'corporation',
      sector: 'Sports media and live events',
      website: 'https://example.test/fifa-demo',
      hq_location: 'Zurich',
    },
    contacts: {
      theirs: [
        {
          id: 'demo-contact-fifa-marco',
          full_name: 'Marco Silva',
          email: 'marco.silva@example.test',
          job_title: 'Sports media lead',
        },
      ],
      ours: [
        {
          id: DEMO_IDS.contact,
          full_name: 'Donald Trump',
          email: 'donald.trump@example.test',
          job_title: 'Demo Principal',
        },
      ],
      other: [
        {
          id: 'demo-contact-google-ava',
          full_name: 'Ava Morales',
          email: 'ava.morales@example.test',
          job_title: 'Operating partner',
        },
      ],
    },
    notes: [
      {
        id: 'demo-note-1',
        content: 'Demo note: prepare the FIFA memo, confirm stakeholder map, and line up the next fictional diligence call.',
        created_at: isoDaysAgo(1),
        author_name: 'Tony Jimenez',
      },
    ],
  },
  documents: demoActionDocuments,
  threads: [
    {
      external_thread_id: 'demo-fifa-thread-1',
      subject: 'FIFA demo diligence packet',
      message_count: 3,
      last_sent_at: isoDaysAgo(0),
      messages: [
        {
          id: 'demo-msg-1',
          sender_name: 'Ava Morales',
          sender_email: 'ava.morales@example.test',
          sent_at: isoDaysAgo(0),
          body_preview: 'Synthetic update: the FIFA demo packet is ready for review and the sponsorship data workflow is mapped.',
          can_read_body: true,
        },
        {
          id: 'demo-msg-2',
          sender_name: 'Marco Silva',
          sender_email: 'marco.silva@example.test',
          sent_at: isoDaysAgo(1),
          body_preview: 'Fictional follow-up confirming the demo stakeholder list and next call timing.',
          can_read_body: true,
        },
      ],
    },
    {
      external_thread_id: 'demo-fifa-thread-2',
      subject: 'Google x FIFA demo workflow',
      message_count: 2,
      last_sent_at: isoDaysAgo(2),
      messages: [
        {
          id: 'demo-msg-3',
          sender_name: 'Donald Trump',
          sender_email: 'donald.trump@example.test',
          sent_at: isoDaysAgo(2),
          body_preview: 'Demo-only note on how the Google company relationship connects to the FIFA opportunity.',
          can_read_body: true,
        },
      ],
    },
  ],
  intelligence: demoDealIntelligenceFixture,
};

export const demoMartySessions = [
  {
    id: 'demo-session-weekly-accomplishments',
    title: 'Weekly Accomplishments Brief',
    created_at: isoDaysAgo(0),
    updated_at: isoDaysAgo(0),
    demoMessages: [
      {
        id: 'demo-msg-user-1',
        role: 'user',
        content: 'Make me a doc listing the things that were accomplished this week.',
        timestamp: isoDaysAgo(0),
      },
      {
        id: 'demo-msg-assistant-1',
        role: 'assistant',
        content: 'Done — I created a clean weekly accomplishments brief using demo-safe data.',
        timestamp: isoDaysAgo(0),
        documentCards: [
          {
            document_id: 'demo-doc-contact-brief',
            title: 'Weekly Accomplishments — Demo Brief',
            file_name: 'weekly-accomplishments-demo.docx',
            mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            document_type: 'document',
            mode: 'dominant',
            reason: 'Demo document for screen recording',
            confidence: 1,
            source: 'Demo Mode',
            actions: { preview: true, download: true, send_to_marty: false },
            generated: true,
          },
        ],
      },
    ],
  },
  { id: 'demo-session-tony-email-management', title: "Tony's Email Management Plan", created_at: isoDaysAgo(0), updated_at: isoDaysAgo(0), demoMessages: [] },
  { id: 'demo-session-tony-email-comms', title: "Tony's Email Communication Summary", created_at: isoDaysAgo(0), updated_at: isoDaysAgo(0), demoMessages: [] },
  { id: 'demo-session-direct-note', title: 'I appreciate you being direct', created_at: isoDaysAgo(0), updated_at: isoDaysAgo(0), demoMessages: [] },
  { id: 'demo-session-recent-activities', title: "Tony's Recent Activities and Follow-ups", created_at: isoDaysAgo(0), updated_at: isoDaysAgo(0), demoMessages: [] },
  { id: 'demo-session-private', title: "I don't have access to your private data", created_at: isoDaysAgo(4), updated_at: isoDaysAgo(4), demoMessages: [] },
  { id: 'demo-session-jericho', title: 'Jericho Security Deal Detail Review', created_at: isoDaysAgo(9), updated_at: isoDaysAgo(9), demoMessages: [] },
  { id: 'demo-session-tyler', title: 'Tyler Johnson Complete Catch-up', created_at: isoDaysAgo(9), updated_at: isoDaysAgo(9), demoMessages: [] },
];
