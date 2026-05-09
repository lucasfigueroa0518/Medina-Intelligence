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

export const demoContacts = [
  demoContact,
  {
    id: 'demo-contact-ava',
    full_name: 'Ava Morales',
    email: 'ava.morales@example.test',
    company_name: 'Google',
    contact_type: 'individual',
    engagement_status: 'warm',
    last_contact_date: new Date(Date.now() - 86400000).toISOString(),
    total_interactions: 18,
    tags: [demoTags[3]],
  },
  {
    id: 'demo-contact-marco',
    full_name: 'Marco Silva',
    email: 'marco.silva@example.test',
    company_name: 'FIFA',
    contact_type: 'individual',
    engagement_status: 'new',
    last_contact_date: new Date(Date.now() - 2 * 86400000).toISOString(),
    total_interactions: 9,
    tags: [demoTags[2]],
  },
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

export const demoCompanies = [
  demoCompany,
  {
    id: 'demo-company-fifa',
    name: 'FIFA',
    domain: 'fifa.example.test',
    website: 'https://example.test/fifa-demo',
    sector: 'Sports media and live events',
    company_type: 'corporation',
    investment_status: 'tracking',
    stage: 'growth',
    hq_location: 'Zurich, Switzerland',
    news_relevance_score: 8.6,
    logo_url: null,
    tags: [demoTags[2]],
  },
  {
    id: 'demo-company-sunrise',
    name: 'Sunrise Analytics',
    domain: 'sunrise.example.test',
    sector: 'Predictive analytics',
    company_type: 'startup',
    investment_status: 'prospect',
    stage: 'series_a',
    hq_location: 'Miami, FL',
    news_relevance_score: 6.8,
    logo_url: null,
    tags: [demoTags[1]],
  },
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
