export const MEDINA_DECK_ENGINE_VERSION = 'medina_skill_v1' as const;

export type DeckProfile =
  | 'finance-ir'
  | 'product-platform'
  | 'engineering-platform'
  | 'strategy-leadership'
  | 'gtm-growth'
  | 'appendix-heavy';

export type DeckLayoutFamily =
  | 'cover'
  | 'investment_snapshot'
  | 'executive_summary'
  | 'metric_dashboard'
  | 'product_workflow_map'
  | 'market_wedge'
  | 'competitive_matrix'
  | 'risk_register'
  | 'timeline_process'
  | 'action_grid'
  | 'appendix_source_table';

export type DeckProofObjectType =
  | 'metric'
  | 'table'
  | 'matrix'
  | 'workflow'
  | 'timeline'
  | 'risk_register'
  | 'action_grid'
  | 'evidence_cards'
  | 'open_questions';

export interface DeckBrief {
  request: string;
  audience: string;
  objective: string;
  source_notes: string[];
  facts: Array<{
    claim: string;
    value?: string;
    source_ids: string[];
    status: 'source_backed' | 'inferred' | 'needs_source';
  }>;
  constraints: string[];
  output_priority: 'html_pdf_first' | 'pptx_first';
}

export interface DeckProofObject {
  type: DeckProofObjectType;
  title: string;
  values: Array<{ label: string; value: string; context?: string }>;
  rows: string[][];
  source_ids: string[];
  status: 'source_backed' | 'inferred' | 'needs_source';
  note?: string;
}

export interface DeckStudioSlide {
  id: string;
  kicker: string;
  claim_title: string;
  proof_object: DeckProofObject;
  support_note: string;
  source_ids: string[];
  layout_family: DeckLayoutFamily;
}

export interface DeckStudioSpec {
  engine_version: typeof MEDINA_DECK_ENGINE_VERSION;
  title: string;
  profile: DeckProfile;
  design_system: {
    id: 'medina_ic_report';
    typography: string[];
    chart_grammar: string[];
    table_grammar: string[];
    source_footer_rule: string;
    banned_motifs: string[];
  };
  brief: DeckBrief;
  claim_spine: {
    thesis: string;
    one_line_arc: string;
    slide_claims: string[];
    source_gap_notes: string[];
  };
  contact_sheet: {
    slide_count: number;
    layout_families: DeckLayoutFamily[];
    rhythm_notes: string[];
  };
  slides: DeckStudioSlide[];
}

export interface DeckCriticFinding {
  slideId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  issue: string;
  requiredFix: string;
  category: 'story' | 'specificity' | 'rhythm' | 'proof' | 'typography' | 'precision' | 'system_language';
}

export interface DeckCriticReport {
  status: 'pass' | 'needs_revision' | 'failed';
  score_total: number;
  max_score: number;
  scores: Record<'story' | 'specificity' | 'rhythm' | 'whitespace' | 'proof_quality' | 'typography' | 'restraint' | 'precision' | 'coherence', number>;
  top_findings: DeckCriticFinding[];
  strengths: string[];
}

export interface MedinaDeckStudioBuild {
  brief: DeckBrief;
  spec: DeckStudioSpec;
  critic: DeckCriticReport;
  structuredContent: Record<string, any>;
}

const LAYOUT_SEQUENCE: DeckLayoutFamily[] = [
  'cover',
  'investment_snapshot',
  'product_workflow_map',
  'market_wedge',
  'competitive_matrix',
  'risk_register',
  'timeline_process',
  'action_grid',
  'appendix_source_table',
  'metric_dashboard',
];

const TOPIC_ONLY_TITLES = new Set([
  'overview',
  'executive summary',
  'executive takeaway',
  'market',
  'product',
  'solution',
  'competition',
  'competitive landscape',
  'financials',
  'metrics',
  'risk',
  'risks',
  'risk register',
  'timeline',
  'next steps',
  'action plan',
  'appendix',
  'evidence',
  'narrative spine',
  'evidence to build around',
]);

const SYSTEM_LANGUAGE = [
  'claim spine',
  'evidence-first proof',
  'qa-gated export',
  'audience-ready claim spine',
  'proof object',
  'deck studio',
  'layout family',
  'semantic critic',
  'placeholder',
  'lorem ipsum',
];

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function cleanArtifactText(value: any): string {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNonEmpty(...values: any[]): string {
  for (const value of values) {
    const clean = cleanArtifactText(value);
    if (clean) return clean;
  }
  return '';
}

function normalizeTextKey(value: string): string {
  return cleanArtifactText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tableFromAny(value: any): { title?: string; headers: string[]; rows: string[][] } | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const rows = value
      .filter(row => Array.isArray(row))
      .map(row => row.map(cleanArtifactText));
    if (rows.length === 0) return null;
    return { headers: rows[0], rows: rows.slice(1).filter(row => row.some(Boolean)) };
  }
  const headers = asArray(value.headers || value.columns).map(cleanArtifactText).filter(Boolean);
  const rows = asArray(value.rows || value.data || value.items)
    .map((row: any) => Array.isArray(row)
      ? row.map(cleanArtifactText)
      : headers.map(header => cleanArtifactText(row?.[header] ?? row?.[header.toLowerCase()] ?? '')))
    .filter((row: string[]) => row.some(Boolean));
  if (headers.length === 0 && rows.length === 0) return null;
  return { title: cleanArtifactText(value.title), headers, rows };
}

function sourceIdsFrom(content: any, slide?: any): string[] {
  return [
    ...asArray(content?.source_document_ids),
    ...asArray(content?.source_ids),
    ...asArray(slide?.source_ids),
    ...asArray(slide?.source_document_ids),
  ].map(String).filter(Boolean).slice(0, 12);
}

function plainTextFromContent(content: any): string {
  const pieces: string[] = [];
  const visit = (value: any) => {
    if (value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
      pieces.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 80).forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      Object.keys(value).slice(0, 80).forEach(key => visit(value[key]));
    }
  };
  visit(content);
  return cleanArtifactText(pieces.join(' '));
}

function wordsFromText(text: string, maxWords: number): string {
  const words = cleanArtifactText(text).replace(/\.{3,}/g, '').split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ');
}

function companyFromTitle(title: string): string {
  const clean = cleanArtifactText(title);
  const [first] = clean.split(/\s+[—|-]\s+|\s+about\s+/i);
  return (first || clean || 'The opportunity').replace(/\bdeck\b/ig, '').trim() || 'The opportunity';
}

function isPlaceholderTitle(title: string): boolean {
  const key = normalizeTextKey(title);
  return /^slide \d+$/.test(key) || /^page \d+$/.test(key) || key === '';
}

function isTopicOnlyTitle(title: string): boolean {
  const key = normalizeTextKey(title);
  if (TOPIC_ONLY_TITLES.has(key)) return true;
  return key.split(/\s+/).length <= 2 && /^(market|product|risk|team|financials?|competition|summary|overview|appendix)$/.test(key);
}

function hasSystemLanguage(value: string): boolean {
  const key = cleanArtifactText(value).toLowerCase();
  return SYSTEM_LANGUAGE.some(term => key.includes(term));
}

function extractValues(text: string): Array<{ label: string; value: string; context?: string }> {
  const clean = cleanArtifactText(text);
  const matches = clean.match(/\$?\b\d[\d,.]*(?:\s?(?:%|x|k|m|b|K|M|B))?\b(?:\s?(?:ARR|MRR|revenue|clients|customers|countries|round|valuation|pipeline|stage|weeks?))?/g) || [];
  const unique = Array.from(new Set(matches.map(match => match.trim()).filter(match => /\d/.test(match)))).slice(0, 6);
  return unique.map((value, index) => ({
    label: index === 0 ? 'Primary signal' : `Signal ${index + 1}`,
    value,
  }));
}

function inferProfile(title: string, content: any): DeckProfile {
  const text = `${title} ${plainTextFromContent(content)}`.toLowerCase();
  if (/\b(arr|mrr|valuation|revenue|burn|runway|margin|ebitda|investment|investor|ic|deal|round|cap table|pipeline)\b/.test(text)) return 'finance-ir';
  if (/\b(api|developer|architecture|infrastructure|security|data platform|model|agent|workflow)\b/.test(text)) return 'engineering-platform';
  if (/\b(product|platform|feature|customer journey|implementation|module|demo)\b/.test(text)) return 'product-platform';
  if (/\b(gtm|growth|sales|marketing|funnel|campaign|pipeline|segment|cohort)\b/.test(text)) return 'gtm-growth';
  if (/\b(appendix|source table|data room|diligence pack|all documents|backup)\b/.test(text)) return 'appendix-heavy';
  return 'strategy-leadership';
}

function profileKicker(profile: DeckProfile, layout: DeckLayoutFamily): string {
  const profileLabel: Record<DeckProfile, string> = {
    'finance-ir': 'Investment analysis',
    'product-platform': 'Product proof',
    'engineering-platform': 'Platform diligence',
    'strategy-leadership': 'Strategic readout',
    'gtm-growth': 'Growth thesis',
    'appendix-heavy': 'Source appendix',
  };
  const layoutLabel: Record<DeckLayoutFamily, string> = {
    cover: 'Decision frame',
    investment_snapshot: 'Investment snapshot',
    executive_summary: 'Executive synthesis',
    metric_dashboard: 'Metrics exhibit',
    product_workflow_map: 'Workflow map',
    market_wedge: 'Market wedge',
    competitive_matrix: 'Competitive matrix',
    risk_register: 'Risk register',
    timeline_process: 'Process timeline',
    action_grid: 'Action grid',
    appendix_source_table: 'Source appendix',
  };
  return `${profileLabel[profile]} · ${layoutLabel[layout]}`;
}

function sourceStatus(sourceIds: string[], proofHasValue: boolean): 'source_backed' | 'inferred' | 'needs_source' {
  if (sourceIds.length > 0 && proofHasValue) return 'source_backed';
  if (proofHasValue) return 'inferred';
  return 'needs_source';
}

function extractSlideEvidence(slide: any): string[] {
  return [
    ...asArray(slide?.evidence_blocks),
    ...asArray(slide?.evidence),
    ...asArray(slide?.proof_points),
    ...asArray(slide?.bullets),
  ].map(cleanArtifactText).filter(Boolean);
}

function existingSlidesFromContent(title: string, content: any): any[] {
  const explicit = asArray(content?.slides).filter(slide => slide && typeof slide === 'object');
  if (explicit.length > 0) return explicit.slice(0, 10);
  const slides: any[] = [];
  if (content?.summary) slides.push({ layout: 'executive_summary', title: 'Executive Summary', headline: content.summary });
  for (const section of asArray(content?.sections).slice(0, 8)) {
    slides.push({
      title: section?.heading || 'Section',
      headline: firstNonEmpty(section?.summary, asArray(section?.paragraphs)[0], asArray(section?.bullets)[0]),
      body: section?.summary || asArray(section?.paragraphs)[0],
      bullets: [...asArray(section?.bullets), ...asArray(section?.numbered), ...asArray(section?.checklist)].slice(0, 6),
      table: tableFromAny(section?.table || asArray(section?.tables)[0]),
    });
  }
  if (slides.length === 0) {
    slides.push({ layout: 'executive_summary', title: `${companyFromTitle(title)} matters if the evidence supports the decision`, headline: firstNonEmpty(content?.summary, title) });
  }
  return slides;
}

function buildBrief(title: string, content: any, opts: Record<string, any>): DeckBrief {
  const request = firstNonEmpty(opts.prompt, content?.deck_request, content?.prompt, content?.summary, title);
  const audience = firstNonEmpty(opts.audience, content?.audience, content?.target_audience, 'Medina internal decision makers');
  const objective = firstNonEmpty(opts.objective, content?.objective, /\b(decide|decision|ic|investment)\b/i.test(request) ? 'decide' : 'inform');
  const sourceIds = sourceIdsFrom(content);
  const text = `${title} ${request} ${plainTextFromContent(content)}`;
  const values = extractValues(text);
  const facts: DeckBrief['facts'] = values.map(value => ({
    claim: value.context ? `${value.label}: ${value.value} (${value.context})` : `${value.label}: ${value.value}`,
    value: value.value,
    source_ids: sourceIds,
    status: sourceStatus(sourceIds, true),
  }));
  if (facts.length === 0) {
    facts.push({
      claim: `Need stronger source-backed proof for ${companyFromTitle(title)}`,
      source_ids: sourceIds,
      status: 'needs_source',
    });
  }
  return {
    request,
    audience,
    objective,
    source_notes: sourceIds.length > 0 ? sourceIds.map(id => `Source document ${id}`) : ['No explicit source document IDs were supplied.'],
    facts,
    constraints: [
      'HTML/PDF fidelity is the primary quality target.',
      'PPTX must export when possible, but draft-review HTML/PDF can surface when editable export is blocked.',
      'Unsupported metrics must remain open questions instead of invented facts.',
    ],
    output_priority: 'html_pdf_first',
  };
}

function defaultClaimsFor(title: string, profile: DeckProfile, brief: DeckBrief): string[] {
  const company = companyFromTitle(title);
  const request = brief.request;
  const objective = brief.objective;
  const values = brief.facts.map(fact => fact.value).filter(Boolean).slice(0, 3).join(', ');
  const opener = profile === 'finance-ir'
    ? `${company} is investable only if the strongest proof survives revenue, customer, and execution diligence.`
    : profile === 'product-platform' || profile === 'engineering-platform'
      ? `${company} needs to prove the product workflow creates executive-grade operating leverage.`
      : `${company} needs a sharper strategic case before the audience can act with confidence.`;
  return [
    `${company} — ${objective === 'decide' ? 'Decision Deck' : 'Strategic Readout'}`,
    opener,
    values ? `The headline evidence centers on ${values}, but each signal needs decision context.` : `${company} has a plausible story, but the deck must separate proof from assumptions.`,
    `The product and workflow narrative should show how the promise becomes a repeatable buyer motion.`,
    `The market wedge is strongest where urgent pain, budget, and differentiation intersect.`,
    `Competitive pressure matters most where incumbents can imitate the surface but not the workflow depth.`,
    `The current risk register is underwriteable if owners can close the evidence gaps quickly.`,
    `The next diligence pass should produce a pitch deck, founder call, source pack, and decision memo.`,
    wordsFromText(request, 14) || `${company} requires a concise appendix of source-backed claims.`,
  ];
}

function claimTitleFor(slide: any, index: number, fallbackClaims: string[], title: string): string {
  const raw = firstNonEmpty(slide?.claim_title, slide?.takeaway, slide?.headline, slide?.title);
  let candidate = raw.replace(/\.{3,}/g, '').trim();
  if (
    index === 0
    || isPlaceholderTitle(candidate)
    || isTopicOnlyTitle(candidate)
    || hasSystemLanguage(candidate)
    || candidate.split(/\s+/).length < 4
  ) {
    candidate = fallbackClaims[index] || fallbackClaims[fallbackClaims.length - 1] || title;
  }
  return wordsFromText(candidate, index === 0 ? 14 : 18);
}

function supportNoteFor(slide: any, claimTitle: string, brief: DeckBrief): string {
  const note = firstNonEmpty(slide?.support_note, slide?.body, slide?.subtitle, slide?.headline, slide?.takeaway);
  if (note && normalizeTextKey(note) !== normalizeTextKey(claimTitle) && !hasSystemLanguage(note)) {
    return wordsFromText(note, 24);
  }
  const fact = brief.facts.find(item => item.value) || brief.facts[0];
  if (fact?.value) return `Use ${fact.value} as proof, then tie the number to the decision and remaining source gap.`;
  return 'Treat unverified points as open questions until a source-backed proof object is available.';
}

function proofObjectFor(content: any, slide: any, layout: DeckLayoutFamily, brief: DeckBrief): DeckProofObject {
  const sourceIds = sourceIdsFrom(content, slide);
  const table = tableFromAny(slide?.table || asArray(slide?.tables)[0]);
  const evidence = extractSlideEvidence(slide).filter(item => !hasSystemLanguage(item));
  const values = [
    ...asArray(slide?.metrics).map((metric: any) => ({
      label: firstNonEmpty(metric?.label, metric?.name, metric?.context, 'Metric'),
      value: firstNonEmpty(metric?.value, metric?.metric),
      context: cleanArtifactText(metric?.context),
    })).filter(metric => metric.value || metric.label),
    ...extractValues(`${slide?.title || ''} ${slide?.headline || ''} ${slide?.body || ''} ${evidence.join(' ')}`),
  ].slice(0, 5);

  const rows = table?.rows?.length
    ? table.rows.slice(0, 7)
    : evidence.slice(0, 5).map((item, index) => [`${index + 1}`, wordsFromText(item, 15), sourceIds.length ? 'Source-backed' : 'Needs source']);
  const hasValue = values.some(value => value.value) || rows.some(row => row.some(cell => /\d|[$%]/.test(cell)));
  const typeByLayout: Record<DeckLayoutFamily, DeckProofObjectType> = {
    cover: 'evidence_cards',
    investment_snapshot: values.length >= 2 ? 'metric' : 'evidence_cards',
    executive_summary: 'evidence_cards',
    metric_dashboard: 'metric',
    product_workflow_map: 'workflow',
    market_wedge: 'matrix',
    competitive_matrix: 'matrix',
    risk_register: 'risk_register',
    timeline_process: 'timeline',
    action_grid: 'action_grid',
    appendix_source_table: 'table',
  };
  const fallbackValue = brief.facts.find(fact => fact.value);
  return {
    type: table ? 'table' : typeByLayout[layout],
    title: firstNonEmpty(table?.title, slide?.proof_title, slide?.title, layout.replace(/_/g, ' ')),
    values: values.length > 0
      ? values
      : fallbackValue?.value
        ? [{ label: 'Source signal', value: fallbackValue.value }]
        : [],
    rows,
    source_ids: sourceIds,
    status: sourceStatus(sourceIds, hasValue || Boolean(fallbackValue?.value)),
    note: hasValue || fallbackValue?.value ? undefined : 'Needs a source-backed metric, table row, or named evidence point.',
  };
}

function layoutFamilyFor(slide: any, index: number, profile: DeckProfile): DeckLayoutFamily {
  if (index === 0) return 'cover';
  const requested = normalizeTextKey(firstNonEmpty(slide?.layout_family, slide?.layout));
  const text = normalizeTextKey(`${slide?.title || ''} ${slide?.headline || ''} ${slide?.body || ''}`);
  if (/risk|open question|concern/.test(`${requested} ${text}`)) return 'risk_register';
  if (/next|action|owner|step|follow/.test(`${requested} ${text}`)) return 'action_grid';
  if (/timeline|process|milestone|sequence/.test(`${requested} ${text}`)) return 'timeline_process';
  if (/compet|matrix|alternative|incumbent/.test(`${requested} ${text}`)) return 'competitive_matrix';
  if (/market|wedge|segment|buyer|category/.test(`${requested} ${text}`)) return 'market_wedge';
  if (/product|workflow|platform|architecture|system/.test(`${requested} ${text}`)) return profile === 'engineering-platform' ? 'product_workflow_map' : 'product_workflow_map';
  if (/metric|financial|arr|mrr|revenue|valuation|snapshot/.test(`${requested} ${text}`)) return 'investment_snapshot';
  return LAYOUT_SEQUENCE[index % LAYOUT_SEQUENCE.length] || 'executive_summary';
}

function enforceLayoutVariety(slides: DeckStudioSlide[]): DeckStudioSlide[] {
  const used = new Set<DeckLayoutFamily>();
  return slides.map((slide, index) => {
    if (index === 0) {
      used.add('cover');
      return { ...slide, layout_family: 'cover' };
    }
    const family = slide.layout_family;
    const previous = slides[index - 1]?.layout_family;
    const repeated = previous === family || (family === 'executive_summary' && used.has(family));
    const replacement = LAYOUT_SEQUENCE.find(candidate => candidate !== 'cover' && !used.has(candidate)) || family;
    const nextFamily = repeated ? replacement : family;
    used.add(nextFamily);
    return { ...slide, layout_family: nextFamily, kicker: profileKicker(inferProfile(slide.claim_title, {}), nextFamily) };
  });
}

function buildStudioSlides(title: string, content: any, profile: DeckProfile, brief: DeckBrief): DeckStudioSlide[] {
  const existing = existingSlidesFromContent(title, content);
  const fallbackClaims = defaultClaimsFor(title, profile, brief);
  const targetCount = Math.max(6, Math.min(10, Math.max(existing.length + 1, 8)));
  const seededSlides = [
    { layout: 'cover', title, headline: firstNonEmpty(content?.summary, brief.request) },
    ...existing,
  ].slice(0, targetCount);
  while (seededSlides.length < targetCount) {
    const index = seededSlides.length;
    seededSlides.push({
      title: fallbackClaims[index],
      headline: fallbackClaims[index],
      layout: LAYOUT_SEQUENCE[index],
    });
  }
  const slides = seededSlides.map((slide, index): DeckStudioSlide => {
    const layout = layoutFamilyFor(slide, index, profile);
    const claimTitle = claimTitleFor(slide, index, fallbackClaims, title);
    const proof = proofObjectFor(content, slide, layout, brief);
    return {
      id: `slide_${index + 1}`,
      kicker: profileKicker(profile, layout),
      claim_title: claimTitle,
      proof_object: proof,
      support_note: supportNoteFor(slide, claimTitle, brief),
      source_ids: proof.source_ids,
      layout_family: layout,
    };
  });
  return enforceLayoutVariety(slides).map(slide => ({ ...slide, kicker: profileKicker(profile, slide.layout_family) }));
}

function buildSpec(title: string, content: any, opts: Record<string, any>): DeckStudioSpec {
  const brief = buildBrief(title, content, opts);
  const profile = inferProfile(title, content);
  const slides = buildStudioSlides(title, content, profile, brief);
  const thesis = slides[1]?.claim_title || slides[0]?.claim_title || title;
  const sourceGapNotes = slides
    .filter(slide => slide.proof_object.status === 'needs_source')
    .map(slide => `${slide.id}: ${slide.proof_object.note || 'Needs source-backed proof.'}`)
    .slice(0, 8);
  return {
    engine_version: MEDINA_DECK_ENGINE_VERSION,
    title,
    profile,
    design_system: {
      id: 'medina_ic_report',
      typography: ['DM Sans display', 'Inter body', 'tabular finance numerals'],
      chart_grammar: ['metrics need labels and source status', 'matrices compare relationship not decoration', 'timelines show owner and decision point'],
      table_grammar: ['headers are uppercase', 'dense rows are table-first', 'no empty narrative column beside table-only slides'],
      source_footer_rule: 'Quiet source note on each slide when source IDs exist; gaps must be named as open questions.',
      banned_motifs: ['generic SaaS card grid', 'placeholder proof labels', 'system-language cards', 'literal ellipses in titles'],
    },
    brief,
    claim_spine: {
      thesis,
      one_line_arc: `${slides[1]?.claim_title || thesis} → ${slides[slides.length - 2]?.claim_title || 'diligence focus'} → ${slides[slides.length - 1]?.claim_title || 'next decision'}`,
      slide_claims: slides.map(slide => slide.claim_title),
      source_gap_notes: sourceGapNotes,
    },
    contact_sheet: {
      slide_count: slides.length,
      layout_families: slides.map(slide => slide.layout_family),
      rhythm_notes: [
        'At least five macro-layout families are used before appendix fallback.',
        'Table-only material is rendered as a full-width proof surface.',
        'Draft-review surfacing remains available if PPTX fidelity fails.',
      ],
    },
    slides,
  };
}

function criticStatus(findings: DeckCriticFinding[]): DeckCriticReport['status'] {
  if (findings.some(finding => finding.severity === 'critical')) return 'failed';
  if (findings.some(finding => finding.severity === 'high')) return 'needs_revision';
  return 'pass';
}

function scoreFromFindings(findings: DeckCriticFinding[], category: DeckCriticFinding['category']): number {
  const categoryFindings = findings.filter(finding => finding.category === category);
  const penalty = categoryFindings.reduce((sum, finding) => sum + (
    finding.severity === 'critical' ? 3 : finding.severity === 'high' ? 2 : finding.severity === 'medium' ? 1 : 0.5
  ), 0);
  return Math.max(0, Math.round((5 - penalty) * 10) / 10);
}

export function evaluateDeckStudioSpec(title: string, spec: DeckStudioSpec): DeckCriticReport {
  const findings: DeckCriticFinding[] = [];
  const layoutCounts = new Map<DeckLayoutFamily, number>();
  let valueBackedSlides = 0;
  spec.slides.forEach((slide, index) => {
    layoutCounts.set(slide.layout_family, (layoutCounts.get(slide.layout_family) || 0) + 1);
    const claim = cleanArtifactText(slide.claim_title);
    const proof = slide.proof_object;
    const hasValue = proof.values.some(value => /\d|[$%]/.test(value.value)) || proof.rows.some(row => row.some(cell => /\d|[$%]/.test(cell)));
    if (hasValue || proof.source_ids.length > 0) valueBackedSlides++;
    if (isPlaceholderTitle(claim)) {
      findings.push({
        slideId: slide.id,
        severity: 'critical',
        issue: 'Slide has a placeholder title instead of a decision claim.',
        requiredFix: 'Replace Slide N titles with claim headlines that state what the audience should believe.',
        category: 'typography',
      });
    }
    if (index > 0 && isTopicOnlyTitle(claim)) {
      findings.push({
        slideId: slide.id,
        severity: 'high',
        issue: 'Slide title is topic-only and could fit any noun-swapped deck.',
        requiredFix: 'Rewrite the title as a specific conclusion with a company, buyer, metric, or decision consequence.',
        category: 'specificity',
      });
    }
    if (/\.\.\.|…/.test(claim)) {
      findings.push({
        slideId: slide.id,
        severity: 'high',
        issue: 'Slide claim uses ellipsis truncation.',
        requiredFix: 'Compress the headline into a complete claim without ellipses.',
        category: 'precision',
      });
    }
    if (hasSystemLanguage(`${claim} ${slide.kicker} ${proof.title} ${slide.support_note}`)) {
      findings.push({
        slideId: slide.id,
        severity: 'high',
        issue: 'Deck exposes internal generation language.',
        requiredFix: 'Replace system labels with audience-facing investment, product, proof, or action language.',
        category: 'system_language',
      });
    }
    if (!hasValue && proof.rows.length === 0 && proof.values.length === 0) {
      findings.push({
        slideId: slide.id,
        severity: 'high',
        issue: 'Proof object is empty.',
        requiredFix: 'Add source-backed values, relationships, table rows, or make the gap an explicit open question.',
        category: 'proof',
      });
    }
    if (proof.status === 'needs_source' && !/question|gap|needs/i.test(`${proof.title} ${slide.support_note} ${proof.note || ''}`)) {
      findings.push({
        slideId: slide.id,
        severity: 'medium',
        issue: 'Unsupported claim is not marked as a source gap.',
        requiredFix: 'Label unsupported proof as an open question instead of presenting it as fact.',
        category: 'precision',
      });
    }
  });

  const distinctLayouts = layoutCounts.size;
  if (spec.slides.length >= 8 && distinctLayouts < 5) {
    findings.push({
      slideId: 'deck',
      severity: 'high',
      issue: 'Contact sheet lacks enough macro-layout variety.',
      requiredFix: 'Use at least five layout families across an 8-10 slide deck.',
      category: 'rhythm',
    });
  }
  for (const [layout, count] of layoutCounts.entries()) {
    if (layout !== 'cover' && count > 3) {
      findings.push({
        slideId: 'deck',
        severity: 'medium',
        issue: `Layout family ${layout} repeats ${count} times.`,
        requiredFix: 'Swap repeated card-grid/table rhythms for workflow, market, risk, timeline, or action layouts.',
        category: 'rhythm',
      });
    }
  }
  if (valueBackedSlides < Math.min(4, spec.slides.length - 1)) {
    findings.push({
      slideId: 'deck',
      severity: 'high',
      issue: 'Deck does not contain enough value-backed proof objects.',
      requiredFix: 'Every substantive section needs a metric, table row, named evidence point, or explicit source gap.',
      category: 'proof',
    });
  }

  const scores = {
    story: scoreFromFindings(findings, 'story'),
    specificity: scoreFromFindings(findings, 'specificity'),
    rhythm: scoreFromFindings(findings, 'rhythm'),
    whitespace: Math.max(3.5, 5 - Math.max(0, spec.slides.length - 10) * 0.4),
    proof_quality: scoreFromFindings(findings, 'proof'),
    typography: scoreFromFindings(findings, 'typography'),
    restraint: scoreFromFindings(findings, 'system_language'),
    precision: scoreFromFindings(findings, 'precision'),
    coherence: spec.claim_spine.slide_claims.length >= 6 ? 4.5 : 3,
  };
  const scoreTotal = Object.values(scores).reduce((sum, score) => sum + score, 0);
  return {
    status: criticStatus(findings),
    score_total: Math.round(scoreTotal),
    max_score: 45,
    scores,
    top_findings: findings
      .sort((a, b) => {
        const rank = { critical: 4, high: 3, medium: 2, low: 1 };
        return rank[b.severity] - rank[a.severity];
      })
      .slice(0, 8),
    strengths: [
      `${distinctLayouts} layout families in contact sheet`,
      `${valueBackedSlides} slides include values, rows, source IDs, or explicit gaps`,
    ],
  };
}

function oldLayoutFor(layout: DeckLayoutFamily): string {
  const map: Record<DeckLayoutFamily, string> = {
    cover: 'cover',
    investment_snapshot: 'executive_summary',
    executive_summary: 'executive_summary',
    metric_dashboard: 'executive_summary',
    product_workflow_map: 'evidence',
    market_wedge: 'matrix',
    competitive_matrix: 'matrix',
    risk_register: 'risk',
    timeline_process: 'timeline',
    action_grid: 'next_steps',
    appendix_source_table: 'matrix',
  };
  return map[layout];
}

function structuredSlideFromStudio(slide: DeckStudioSlide, index: number): Record<string, any> {
  const proof = slide.proof_object;
  const metrics = proof.values.map(value => ({ label: value.label, value: value.value, context: value.context || '' }));
  const evidenceBlocks = proof.rows.length > 0
    ? proof.rows.slice(0, 5).map(row => row.filter(Boolean).join(' · '))
    : [
      proof.note,
      proof.status === 'needs_source' ? 'Open source gap: verify before circulation' : '',
    ].filter(Boolean);
  const table = proof.rows.length > 0
    ? {
      title: proof.title,
      headers: proof.rows[0]?.length >= 3 ? ['Signal', 'Evidence', 'Status'] : ['Signal', 'Evidence'],
      rows: proof.rows,
    }
    : null;
  return {
    id: slide.id,
    layout: oldLayoutFor(slide.layout_family),
    layout_family: slide.layout_family,
    kicker: slide.kicker,
    title: slide.claim_title,
    headline: slide.support_note,
    body: index === 0 ? '' : slide.support_note,
    metrics,
    evidence_blocks: evidenceBlocks,
    table,
    source_ids: slide.source_ids,
    source_note: slide.source_ids.length ? `Sources: ${slide.source_ids.join(', ')}` : proof.status === 'needs_source' ? 'Source gap: verify before circulation' : '',
    speaker_notes: [
      slide.claim_title,
      slide.support_note,
      proof.note,
    ].filter(Boolean).join('\n'),
  };
}

export function deckCriticFindingsAsQa(critic: DeckCriticReport): Array<{ slideId: string; severity: 'critical' | 'high' | 'medium' | 'low'; issue: string; requiredFix: string }> {
  return critic.top_findings.map(finding => ({
    slideId: finding.slideId,
    severity: finding.severity,
    issue: `Deck critic: ${finding.issue}`,
    requiredFix: finding.requiredFix,
  }));
}

export function deckStudioSpecToStructuredContent(
  title: string,
  baseContent: any,
  spec: DeckStudioSpec,
  critic: DeckCriticReport
): Record<string, any> {
  return {
    ...(baseContent && typeof baseContent === 'object' ? baseContent : {}),
    title,
    subtitle: firstNonEmpty(baseContent?.subtitle, 'Prepared by MARTy'),
    summary: spec.claim_spine.thesis,
    audience: spec.brief.audience,
    objective: spec.brief.objective,
    style_pack: firstNonEmpty(baseContent?.style_pack, baseContent?.stylePack, 'medina_default'),
    storyline: spec.claim_spine.slide_claims,
    slides: spec.slides.map(structuredSlideFromStudio),
    engine_version: MEDINA_DECK_ENGINE_VERSION,
    deck_brief: spec.brief,
    deck_profile: spec.profile,
    deck_studio_spec: spec,
    critic_summary: critic,
    contact_sheet_summary: spec.contact_sheet,
  };
}

export function buildMedinaDeckStudio(
  title: string,
  content: any,
  opts: Record<string, any> = {}
): MedinaDeckStudioBuild {
  const spec = buildSpec(title, content || {}, opts);
  let critic = evaluateDeckStudioSpec(title, spec);
  let safeSpec = spec;
  if (critic.status !== 'pass') {
    safeSpec = {
      ...spec,
      slides: spec.slides.map((slide, index) => {
        const fallbackClaims = defaultClaimsFor(title, spec.profile, spec.brief);
        const claimTitle = claimTitleFor({ title: slide.claim_title, headline: slide.support_note }, index, fallbackClaims, title);
        const proof = slide.proof_object.rows.length === 0 && slide.proof_object.values.length === 0
          ? {
            ...slide.proof_object,
            type: 'open_questions' as const,
            title: 'Source gap to verify',
            rows: [['Gap', 'Need source-backed evidence', 'Open']],
            note: 'Open question: source-backed proof is required before polished circulation.',
          }
          : slide.proof_object;
        return {
          ...slide,
          claim_title: claimTitle,
          support_note: supportNoteFor({ headline: slide.support_note }, claimTitle, spec.brief),
          proof_object: proof,
        };
      }),
    };
    critic = evaluateDeckStudioSpec(title, safeSpec);
  }
  return {
    brief: safeSpec.brief,
    spec: safeSpec,
    critic,
    structuredContent: deckStudioSpecToStructuredContent(title, content || {}, safeSpec, critic),
  };
}
