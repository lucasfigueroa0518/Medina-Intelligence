'use client';

import React from 'react';

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
