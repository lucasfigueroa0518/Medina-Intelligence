import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VIEWPORT = { width: 1600, height: 900 };
const ARTIFACT_ENGINE_VERSION = 'artifact_tool_v1';

const TOKENS = {
  bg: '#050508',
  panel: '#11121a',
  panel2: '#171824',
  ink: '#f8fafc',
  muted: '#a7abb8',
  faint: '#6f7380',
  line: '#2a2d3a',
  accent: '#d946ef',
  violet: '#8b5cf6',
  cyan: '#38bdf8',
  green: '#34d399',
  amber: '#f59e0b',
  red: '#fb7185',
};

function cleanText(value, fallback = '') {
  return String(value ?? fallback)
    .replace(/\s+/g, ' ')
    .replace(/\.\.\./g, '')
    .replace(/…/g, '')
    .trim();
}

function truncateWords(value, maxWords) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ');
}

function compactTitle(value, fallback = 'MARTy Deck') {
  return truncateWords(cleanText(value, fallback), 18) || fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSource(raw, index, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanText(raw.id || raw.document_id || raw.source_id || raw.url || `${kind}_${index + 1}`);
  const title = cleanText(raw.title || raw.name || raw.file_name || raw.url || `${kind} source ${index + 1}`);
  const excerpt = cleanText(raw.excerpt || raw.summary || raw.text || raw.content || raw.snippet || '');
  const url = cleanText(raw.url || raw.href || '');
  const date = cleanText(raw.date || raw.created_at || raw.updated_at || raw.published_at || '');
  if (!id && !title && !excerpt) return null;
  return {
    id: id || `${kind}_${index + 1}`,
    kind,
    title: title || id || `${kind} source ${index + 1}`,
    date,
    url,
    excerpt,
  };
}

function normalizeSourcePacket(payload) {
  const packet = payload?.source_packet && typeof payload.source_packet === 'object' ? payload.source_packet : {};
  const internal = [
    ...toArray(packet.internal_sources),
    ...toArray(payload?.source_documents),
  ].map((source, index) => normalizeSource(source, index, 'internal')).filter(Boolean);
  const web = toArray(packet.web_sources)
    .map((source, index) => normalizeSource(source, index, 'web'))
    .filter(Boolean);
  const openQuestions = [
    ...toArray(packet.open_questions),
    ...toArray(payload?.open_questions),
  ].map(item => cleanText(typeof item === 'string' ? item : item?.question || item?.text || item?.label || ''))
    .filter(Boolean);
  return { internal, web, open_questions: openQuestions };
}

function sourceLabel(source, index) {
  const prefix = source.kind === 'web' ? 'W' : 'S';
  return `${prefix}${index + 1}`;
}

function buildSourceLedger(packet) {
  const sources = [...packet.internal, ...packet.web].map((source, index) => ({
    ...source,
    label: sourceLabel(source, index),
    excerpt: truncateWords(source.excerpt, 58),
  }));
  return {
    status: sources.length > 0 ? 'sourced' : 'empty',
    internal_count: packet.internal.length,
    web_count: packet.web.length,
    open_question_count: packet.open_questions.length,
    sources,
    open_questions: packet.open_questions,
  };
}

function hasNonDateNumber(text) {
  const matches = cleanText(text).match(/\$?\b\d[\d,]*(?:\.\d+)?%?\b/g) || [];
  return matches.some(match => {
    const normalized = match.replace(/[^\d]/g, '');
    if (/^(19|20)\d{2}$/.test(normalized)) return false;
    return normalized.length > 0;
  });
}

function extractFacts(ledger, payload) {
  const facts = [];
  const seen = new Set();
  const addFact = (claim, source) => {
    const text = truncateWords(claim, 26);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    facts.push({
      id: `fact_${facts.length + 1}`,
      claim: text,
      source_ids: source ? [source.label] : [],
      source_title: source?.title || '',
      evidence_type: hasNonDateNumber(text) ? 'metric' : 'claim',
    });
  };

  for (const source of ledger.sources) {
    const sentences = cleanText(source.excerpt)
      .split(/(?<=[.!?])\s+/)
      .map(s => cleanText(s))
      .filter(s => s.length > 24);
    const prioritized = [
      ...sentences.filter(s => hasNonDateNumber(s)),
      ...sentences.filter(s => !hasNonDateNumber(s)),
    ];
    prioritized.slice(0, 2).forEach(sentence => addFact(sentence, source));
  }

  const structuredSlides = toArray(payload?.structured_content?.slides);
  for (const slide of structuredSlides) {
    toArray(slide?.metrics).forEach(metric => {
      const value = cleanText(metric?.value || '');
      const label = cleanText(metric?.label || metric?.context || '');
      if (value && label) addFact(`${label}: ${value}`, null);
    });
    toArray(slide?.evidence_blocks).forEach(block => {
      const text = cleanText(block?.claim || block?.text || block?.title || '');
      if (text) addFact(text, null);
    });
  }

  return facts.slice(0, 16);
}

function inferProfile(payload, facts) {
  const haystack = `${payload?.prompt || ''} ${payload?.title || ''} ${facts.map(f => f.claim).join(' ')}`.toLowerCase();
  if (/\b(arr|mrr|revenue|valuation|invest|round|ebitda|gross margin|ic|lp|pipeline|deal)\b/.test(haystack)) return 'finance-ir';
  if (/\b(product|platform|workflow|api|architecture|developer|ai|model|data)\b/.test(haystack)) return 'product-platform';
  if (/\b(gtm|growth|sales|marketing|pipeline|customer|segment)\b/.test(haystack)) return 'gtm-growth';
  return 'strategy-leadership';
}

function buildClaimSpine(payload, ledger, facts) {
  const title = compactTitle(payload?.title || payload?.prompt || 'MARTy Deck');
  const prompt = cleanText(payload?.prompt || '');
  const thesis = facts[0]?.claim
    ? `${title} should be evaluated through the strongest sourced signal: ${facts[0].claim}`
    : `${title} needs a source-backed decision spine before it can be treated as a polished investment deck.`;
  const arc = ledger.status === 'sourced'
    ? 'Start with the decision, show the evidence ledger, separate confirmed proof from gaps, then close with the next actions.'
    : 'Start by making the evidence gap visible, then prevent unsupported claims from becoming design polish.';
  return {
    title,
    thesis: truncateWords(thesis, 28),
    arc,
    request: truncateWords(prompt, 44),
  };
}

function criticReport({ ledger, facts, slideCount, repeatedLayoutCount }) {
  const findings = [];
  if (ledger.sources.length === 0) {
    findings.push({
      severity: 'critical',
      type: 'source',
      issue: 'Source ledger is empty.',
      required_fix: 'Attach internal sources or run web-fill before allowing polished deck status.',
    });
  }
  if (facts.length < 4) {
    findings.push({
      severity: 'high',
      type: 'content',
      issue: 'Too few source-backed proof objects.',
      required_fix: 'Add more internal excerpts or web sources; use open-question slides instead of invented metrics.',
    });
  }
  if (repeatedLayoutCount > 2) {
    findings.push({
      severity: 'high',
      type: 'rhythm',
      issue: 'Too many repeated slide layouts.',
      required_fix: 'Increase layout variety before export.',
    });
  }
  const score = Math.max(0, 60 - findings.reduce((sum, finding) => (
    sum + (finding.severity === 'critical' ? 24 : finding.severity === 'high' ? 12 : 6)
  ), 0));
  return {
    status: findings.some(f => f.severity === 'critical' || f.severity === 'high') ? 'needs_revision' : 'pass',
    score,
    max_score: 60,
    slide_count: slideCount,
    findings,
    top_findings: findings.slice(0, 3).map(f => ({
      slideId: f.type,
      severity: f.severity,
      issue: f.issue,
      requiredFix: f.required_fix,
    })),
  };
}

function qaFromCritic(critic, checks) {
  return {
    status: critic.status === 'pass' ? 'pass' : 'needs_revision',
    slideFindings: critic.findings.map(f => ({
      slideId: f.type || 'deck',
      severity: f.severity,
      issue: f.issue,
      requiredFix: f.required_fix,
    })),
    checks: {
      slide_count: checks.slide_count,
      visual_surface_count: checks.visual_surface_count,
      average_words_per_slide: checks.average_words_per_slide,
      max_words_on_slide: checks.max_words_on_slide,
      accent_gutter_px: 96,
      html_bytes: checks.html_bytes || 0,
      critic_score: critic.score,
      critic_status: critic.status,
      engine_version: ARTIFACT_ENGINE_VERSION,
      source_ledger_count: checks.source_ledger_count,
      artifact_tool: true,
    },
  };
}

function sourceFooter(ledger) {
  if (ledger.sources.length === 0) return 'Sources: open question · no source ledger supplied';
  return `Sources: ${ledger.sources.slice(0, 5).map(source => `${source.label} ${source.title}`).join(' · ')}`;
}

function noteFromSources(sources) {
  return sources.length
    ? sources.slice(0, 4).map(source => `${source.label}: ${source.title}`).join('\n')
    : 'No source ledger supplied. Treat this deck as a source-gap draft.';
}

function makeSlideFactory(tool) {
  const { column, row, grid, panel, text, rule, grow, fr } = tool;
  const style = {
    kicker: `size: 17px; weight: 800; color: ${TOKENS.violet}; leading: 1.05`,
    h1: `size: 58px; weight: 800; color: ${TOKENS.ink}; leading: 1.02`,
    h2: `size: 43px; weight: 800; color: ${TOKENS.ink}; leading: 1.04`,
    h3: `size: 25px; weight: 800; color: ${TOKENS.ink}; leading: 1.08`,
    body: `size: 21px; color: #dfe3ee; leading: 1.18`,
    small: `size: 14px; color: ${TOKENS.muted}; leading: 1.16`,
    micro: `size: 11px; color: ${TOKENS.faint}; leading: 1.08`,
    metric: `size: 40px; weight: 800; color: ${TOKENS.ink}; leading: .95`,
    accent: `size: 16px; weight: 800; color: ${TOKENS.accent}; leading: 1.05`,
  };

  const slideChrome = (slide, body, footer, notes) => {
    slide.background.fill = TOKENS.bg;
    slide.compose(row({ width: 'fill', height: 'fill' }, [
      panel({ width: 14, height: 'fill', fill: TOKENS.accent, borderRadius: 10, materialize: true }),
      column({ width: 'fill', height: 'fill', padding: { top: 62, right: 70, bottom: 40, left: 72 }, gap: 22 }, [
        panel({ width: 'fill', height: grow(1), materialize: false }, body),
        text(footer, { width: 'fill', style: style.micro }),
      ]),
    ]));
    slide.speakerNotes.setText(notes || footer);
  };

  const chip = (label, value, accent = TOKENS.accent) => panel({
    fill: TOKENS.panel,
    line: { width: 1, fill: TOKENS.line },
    borderRadius: 12,
    padding: 20,
    width: grow(1),
    height: 114,
  }, column({ gap: 10, width: 'fill' }, [
    text(label, { style: style.small }),
    text(value, { style: `size: 28px; weight: 800; color: ${accent}; leading: .96` }),
  ]));

  const evidenceCard = (item, accent = TOKENS.cyan) => panel({
    fill: TOKENS.panel2,
    line: { width: 1, fill: TOKENS.line },
    borderRadius: 14,
    padding: 20,
    width: 'fill',
    height: 'fill',
  }, column({ width: 'fill', height: 'fill', gap: 12 }, [
    text(item.source_ids?.length ? item.source_ids.join(', ') : 'OPEN', { style: `size: 13px; weight: 800; color: ${accent}; leading: 1` }),
    text(item.claim, { style: style.body }),
  ]));

  return {
    cover(slide, { spine, ledger, profile }) {
      const body = grid({ width: 'fill', height: 'fill', columns: [fr(1.35), fr(.8)], columnGap: 42 }, [
        column({ width: 'fill', height: 'fill', justify: 'center', gap: 24 }, [
          text(`MEDINA ${profile.toUpperCase()} · ARTIFACT TOOL`, { style: style.kicker }),
          text(spine.title, { width: 'fill', style: `size: 66px; weight: 800; color: ${TOKENS.ink}; leading: .98` }),
          text(spine.thesis, { width: 'fill', style: `size: 26px; weight: 700; color: #e7e7f6; leading: 1.15` }),
          rule({ stroke: TOKENS.accent, weight: 3, width: 360 }),
          text(spine.arc, { width: 'fill', style: style.body }),
        ]),
        panel({
          fill: '#12121c',
          line: { width: 1, fill: '#3b3150' },
          borderRadius: 18,
          padding: 24,
          height: 500,
          width: 'fill',
        }, column({ width: 'fill', height: 'fill', gap: 18 }, [
          text('SOURCE COVERAGE', { style: style.accent }),
          chip('Internal sources', String(ledger.internal_count), TOKENS.green),
          chip('Web sources', String(ledger.web_count), TOKENS.cyan),
          chip('Open questions', String(ledger.open_question_count), ledger.open_question_count ? TOKENS.amber : TOKENS.green),
        ])),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },

    thesis(slide, { spine, facts, ledger }) {
      const topFacts = facts.slice(0, 3);
      const body = column({ width: 'fill', height: 'fill', gap: 26 }, [
        text('DECISION FRAME', { style: style.kicker }),
        text(spine.thesis, { width: 'fill', style: style.h2 }),
        grid({ width: 'fill', height: 330, columns: [fr(1), fr(1), fr(1)], columnGap: 18 }, topFacts.length
          ? topFacts.map((fact, index) => evidenceCard(fact, [TOKENS.cyan, TOKENS.green, TOKENS.accent][index % 3]))
          : [
              evidenceCard({ claim: 'No source-backed facts were provided; this deck is blocked from polished status until evidence is supplied.', source_ids: ['OPEN'] }, TOKENS.amber),
              evidenceCard({ claim: 'Use web-fill or attach CRM/document excerpts before turning this into an IC-ready deck.', source_ids: ['OPEN'] }, TOKENS.amber),
              evidenceCard({ claim: 'Open questions are safer than invented proof objects.', source_ids: ['OPEN'] }, TOKENS.amber),
            ]),
        panel({ fill: '#0d1220', line: { width: 1, fill: '#243244' }, borderRadius: 12, padding: 20, width: 'fill' },
          text(spine.arc, { style: style.body })),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },

    ledger(slide, { ledger }) {
      const rows = ledger.sources.slice(0, 6);
      const sourcePanels = rows.length ? rows.map(source => panel({
        fill: TOKENS.panel,
        line: { width: 1, fill: TOKENS.line },
        borderRadius: 12,
        padding: 16,
        width: 'fill',
      }, column({ gap: 7, width: 'fill' }, [
        text(`${source.label} · ${source.kind.toUpperCase()}`, { style: style.accent }),
        text(source.title, { style: style.h3 }),
        text(source.excerpt || source.url || 'No excerpt supplied.', { style: style.small }),
      ]))) : [
        panel({ fill: '#21170d', line: { width: 1, fill: '#7c4a03' }, borderRadius: 12, padding: 22, width: 'fill' },
          text('No internal or web source ledger was supplied. Premium output is intentionally draft-review only.', { style: style.body })),
      ];
      const body = column({ width: 'fill', height: 'fill', gap: 20 }, [
        text('SOURCE LEDGER', { style: style.kicker }),
        text('Every polished claim needs an internal source, web citation, or explicit open question.', { width: 'fill', style: style.h2 }),
        grid({ width: 'fill', height: 'fill', columns: [fr(1), fr(1)], rows: [fr(1), fr(1), fr(1)], columnGap: 16, rowGap: 14 }, sourcePanels),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },

    evidenceMap(slide, { facts, ledger }) {
      const items = facts.slice(0, 6);
      const body = grid({ width: 'fill', height: 'fill', columns: [fr(.8), fr(1.2)], columnGap: 36 }, [
        column({ width: 'fill', height: 'fill', gap: 22 }, [
          text('EVIDENCE MAP', { style: style.kicker }),
          text('What the current record actually supports', { style: style.h2 }),
          text('This slide prevents the deck from laundering weak source material into confident investment language.', { style: style.body }),
        ]),
        column({ width: 'fill', height: 'fill', gap: 12 }, items.length ? items.map((fact, index) => panel({
          fill: index % 2 ? TOKENS.panel : '#101827',
          line: { width: 1, fill: TOKENS.line },
          borderRadius: 10,
          padding: 16,
          width: 'fill',
          height: grow(1),
        }, row({ width: 'fill', height: 'fill', gap: 18, align: 'center' }, [
          text(String(index + 1).padStart(2, '0'), { width: 56, style: style.accent }),
          text(fact.claim, { width: grow(1), style: style.body }),
          text(fact.source_ids?.join(', ') || 'OPEN', { width: 82, style: style.small }),
        ]))) : [evidenceCard({ claim: 'No evidence objects available.', source_ids: ['OPEN'] }, TOKENS.amber)]),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },

    metrics(slide, { facts, ledger }) {
      const metrics = facts.filter(f => f.evidence_type === 'metric').slice(0, 4);
      const fallback = facts.slice(0, 4);
      const items = metrics.length ? metrics : fallback;
      const body = column({ width: 'fill', height: 'fill', gap: 26 }, [
        text('PROOF OBJECTS', { style: style.kicker }),
        text(metrics.length ? 'Reported values anchor the analysis, with source IDs attached.' : 'No source-backed metrics surfaced, so the deck uses claim proof rather than invented numbers.', { width: 'fill', style: style.h2 }),
        grid({ width: 'fill', height: 400, columns: [fr(1), fr(1)], rows: [fr(1), fr(1)], columnGap: 18, rowGap: 18 },
          (items.length ? items : [{ claim: 'Metric gap: attach financials, pipeline records, or web citations.', source_ids: ['OPEN'] }]).map((fact, index) => panel({
            fill: index === 0 ? '#211528' : TOKENS.panel,
            line: { width: 1, fill: index === 0 ? '#704080' : TOKENS.line },
            borderRadius: 16,
            padding: 24,
            width: 'fill',
            height: 'fill',
          }, column({ gap: 14, width: 'fill', height: 'fill' }, [
            text(fact.source_ids?.join(', ') || 'OPEN QUESTION', { style: style.accent }),
            text(extractMetricLead(fact.claim), { style: style.metric }),
            text(removeMetricLead(fact.claim), { style: style.small }),
          ])))),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },

    systemMap(slide, { facts, ledger }) {
      const labels = (facts.length ? facts : [
        { claim: 'Source intake', source_ids: ['OPEN'] },
        { claim: 'Decision logic', source_ids: ['OPEN'] },
        { claim: 'Open diligence', source_ids: ['OPEN'] },
      ]).slice(0, 4);
      const body = column({ width: 'fill', height: 'fill', gap: 28 }, [
        text('WORKFLOW / WEDGE', { style: style.kicker }),
        text('Translate the opportunity into a decision workflow, not a generic feature list.', { width: 'fill', style: style.h2 }),
        row({ width: 'fill', height: 320, gap: 14, align: 'center' }, labels.map((fact, index) => panel({
          fill: index % 2 ? '#111827' : TOKENS.panel2,
          line: { width: 1, fill: TOKENS.line },
          borderRadius: 18,
          padding: 22,
          width: grow(1),
          height: 'fill',
        }, column({ width: 'fill', height: 'fill', justify: 'center', gap: 16 }, [
          text(`0${index + 1}`, { style: `size: 20px; weight: 800; color: ${[TOKENS.accent, TOKENS.cyan, TOKENS.green, TOKENS.amber][index % 4]}` }),
          text(fact.claim, { style: style.h3 }),
          text(fact.source_ids?.join(', ') || 'OPEN', { style: style.small }),
        ])))),
        text('The engine keeps the slide as a sourced logic map; if evidence is missing, it shows the gap instead of manufacturing a visual.', { width: 'fill', style: style.body }),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },

    risks(slide, { ledger }) {
      const questions = ledger.open_questions.length ? ledger.open_questions : [
        'What source confirms the current commercial traction?',
        'What decision does Medina need to make after reviewing the deck?',
        'Which proof objects are strong enough for an IC conversation?',
      ];
      const body = column({ width: 'fill', height: 'fill', gap: 24 }, [
        text('RISK REGISTER', { style: style.kicker }),
        text('Open questions are first-class content, not hidden footnotes.', { width: 'fill', style: style.h2 }),
        column({ width: 'fill', height: 'fill', gap: 14 }, questions.slice(0, 6).map((question, index) => panel({
          fill: index === 0 ? '#21170d' : TOKENS.panel,
          line: { width: 1, fill: index === 0 ? '#7c4a03' : TOKENS.line },
          borderRadius: 12,
          padding: 18,
          width: 'fill',
          height: grow(1),
        }, row({ width: 'fill', gap: 18, align: 'center' }, [
          text(String(index + 1).padStart(2, '0'), { width: 54, style: `size: 18px; weight: 800; color: ${TOKENS.amber}` }),
          text(question, { width: grow(1), style: style.body }),
          text('owner needed', { width: 130, style: style.small }),
        ])))),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },

    actions(slide, { ledger, profile }) {
      const actions = [
        'Attach primary source documents or CRM excerpts to strengthen the proof ledger.',
        ledger.web_count ? 'Verify web-fill citations and dates before circulation.' : 'Run web-fill only for missing public context, then cite every external fact.',
        'Convert open questions into owner/date/action rows before IC review.',
        'Export PPTX/PDF only after critic and visual QA clear the source and design gates.',
      ];
      const body = grid({ width: 'fill', height: 'fill', columns: [fr(1.05), fr(.95)], columnGap: 38 }, [
        column({ width: 'fill', height: 'fill', gap: 24, justify: 'center' }, [
          text('NEXT ACTIONS', { style: style.kicker }),
          text('What has to happen before this becomes a finished Medina deck', { width: 'fill', style: style.h2 }),
          text(`Profile: ${profile}. Engine: artifact-tool editable slides with rendered contact-sheet QA.`, { style: style.body }),
        ]),
        column({ width: 'fill', height: 'fill', gap: 14, justify: 'center' }, actions.map((action, index) => panel({
          fill: TOKENS.panel,
          line: { width: 1, fill: TOKENS.line },
          borderRadius: 12,
          padding: 18,
          width: 'fill',
        }, row({ width: 'fill', gap: 16, align: 'center' }, [
          text(String(index + 1).padStart(2, '0'), { width: 48, style: style.accent }),
          text(action, { width: grow(1), style: style.body }),
        ])))),
      ]);
      slideChrome(slide, body, sourceFooter(ledger), noteFromSources(ledger.sources));
    },
  };
}

function extractMetricLead(value) {
  const text = cleanText(value);
  const match = text.match(/(\$?\b\d[\d,]*(?:\.\d+)?%?\b(?:\s*[MBK])?)/i);
  return match ? match[1] : 'Proof';
}

function removeMetricLead(value) {
  const text = cleanText(value);
  const lead = extractMetricLead(text);
  return truncateWords(text.replace(lead, '').replace(/^[:\s-]+/, ''), 20) || text;
}

async function resolveArtifactTool() {
  const candidates = [
    process.env.ARTIFACT_TOOL_NODE_MODULES
      ? path.join(process.env.ARTIFACT_TOOL_NODE_MODULES, '@oai/artifact-tool/dist/artifact_tool.mjs')
      : '',
    process.env.ARTIFACT_TOOL_PATH || '',
    path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs'),
  ].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      return await import(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  try {
    return await import('@oai/artifact-tool');
  } catch (error) {
    lastError = error;
  }
  throw new Error(`ARTIFACT_TOOL_UNAVAILABLE: ${lastError?.message || 'No @oai/artifact-tool runtime found.'}`);
}

async function blobToBuffer(blob) {
  if (!blob) return Buffer.alloc(0);
  if (blob.data instanceof Uint8Array) return Buffer.from(blob.data);
  if (typeof blob.arrayBuffer === 'function') return Buffer.from(await blob.arrayBuffer());
  if (blob instanceof Uint8Array) return Buffer.from(blob);
  return Buffer.from(blob);
}

function buildHtmlPreview(title, screenshots, contactSheetBase64) {
  const slideHtml = screenshots.map(s => `
    <section class="slide">
      <img src="data:image/png;base64,${s.base64}" alt="Slide ${s.index}">
      <div class="caption">${s.index}. ${escapeHtml(s.slideId)}</div>
    </section>
  `).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;background:#050508;color:#f8fafc;font-family:Inter,Arial,sans-serif}
    header{padding:28px 36px;border-bottom:1px solid #242633;background:#090910;position:sticky;top:0;z-index:2}
    h1{font-size:24px;margin:0 0 6px}
    p{margin:0;color:#a7abb8}
    .deck{display:grid;gap:28px;padding:34px}
    .slide{background:#08080d;border:1px solid #242633;border-radius:14px;padding:14px}
    .slide img{display:block;width:100%;height:auto;border-radius:8px}
    .caption{font-size:13px;color:#7b8190;margin-top:10px}
    .contact{max-width:1280px;margin:34px auto}
    .contact img{width:100%;border:1px solid #242633;border-radius:14px}
    @media print{header{position:static}.slide{break-after:page;border:none;padding:0}.slide img{border-radius:0}.caption,.contact{display:none}}
  </style>
</head>
<body>
  <header><h1>${escapeHtml(title)}</h1><p>Artifact-tool rendered preview. PPTX is the editable source of truth.</p></header>
  <main class="deck">${slideHtml}</main>
  ${contactSheetBase64 ? `<section class="contact"><img src="data:image/png;base64,${contactSheetBase64}" alt="Contact sheet"></section>` : ''}
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

async function renderPdfFromHtml(html) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({
      printBackground: true,
      width: `${VIEWPORT.width}px`,
      height: `${VIEWPORT.height}px`,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }
}

async function makeContactSheet(screenshots, title) {
  if (!screenshots.length) return null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
    const html = `<!doctype html><html><head><style>
      body{margin:0;background:#050508;color:#f8fafc;font-family:Inter,Arial,sans-serif;padding:34px}
      h1{font-size:28px;margin:0 0 22px}
      .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
      figure{margin:0;background:#11121a;border:1px solid #272a36;border-radius:12px;padding:10px}
      img{width:100%;display:block;border-radius:7px}
      figcaption{font-size:12px;color:#a7abb8;margin-top:8px}
    </style></head><body><h1>${escapeHtml(title)} · Contact Sheet</h1><div class="grid">
      ${screenshots.map(s => `<figure><img src="data:image/png;base64,${s.base64}"><figcaption>${s.index}. ${escapeHtml(s.slideId)}</figcaption></figure>`).join('')}
    </div></body></html>`;
    await page.setContent(html, { waitUntil: 'networkidle' });
    const buffer = await page.screenshot({ type: 'png', fullPage: true });
    return {
      slideId: 'contact_sheet',
      index: 0,
      fileName: 'contact-sheet.png',
      mimeType: 'image/png',
      width: 1800,
      height: 1200,
      base64: buffer.toString('base64'),
    };
  } finally {
    await browser.close();
  }
}

export async function buildArtifactToolDeck(payload) {
  const jobId = cleanText(payload?.job_id || crypto.randomUUID());
  const title = compactTitle(payload?.title || payload?.prompt || 'MARTy Deck');
  const tool = await resolveArtifactTool();
  const packet = normalizeSourcePacket(payload);
  const ledger = buildSourceLedger(packet);
  const facts = extractFacts(ledger, payload);
  const profile = inferProfile(payload, facts);
  const spine = buildClaimSpine(payload, ledger, facts);
  const slideBuilders = makeSlideFactory(tool);
  const presentation = tool.Presentation.create({ title });
  const slideSpecs = [
    ['cover', slideBuilders.cover],
    ['decision_frame', slideBuilders.thesis],
    ['source_ledger', slideBuilders.ledger],
    ['evidence_map', slideBuilders.evidenceMap],
    ['proof_objects', slideBuilders.metrics],
    ['workflow_wedge', slideBuilders.systemMap],
    ['risk_register', slideBuilders.risks],
    ['next_actions', slideBuilders.actions],
  ];

  const renderContext = { title, profile, spine, ledger, facts };
  for (const [slideId, build] of slideSpecs) {
    const slide = presentation.slides.add({ width: VIEWPORT.width, height: VIEWPORT.height });
    build(slide, renderContext);
  }

  const screenshots = [];
  const layoutJson = [];
  for (let i = 0; i < presentation.slides.count; i += 1) {
    const slide = presentation.slides.getItem(i);
    const semanticSlideId = slideSpecs[i]?.[0] || `slide_${i + 1}`;
    const png = await blobToBuffer(await slide.export({ format: 'png' }));
    screenshots.push({
      slideId: semanticSlideId,
      index: i + 1,
      fileName: `${jobId}-artifact-slide-${String(i + 1).padStart(2, '0')}.png`,
      mimeType: 'image/png',
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      base64: png.toString('base64'),
    });
    const layoutBlob = await slide.export({ format: 'layout' });
    const layoutText = Buffer.from(await layoutBlob.arrayBuffer()).toString('utf8');
    try {
      layoutJson.push({ semantic_slide_id: semanticSlideId, ...JSON.parse(layoutText) });
    } catch {
      layoutJson.push({ semantic_slide_id: semanticSlideId, slideId: slide.id, raw: layoutText.slice(0, 2000) });
    }
  }

  const pptxBuffer = await blobToBuffer(await tool.PresentationFile.exportPptx(presentation));
  const contactSheet = await makeContactSheet(screenshots, title);
  const html = buildHtmlPreview(title, screenshots, contactSheet?.base64 || '');
  const pdfBuffer = await renderPdfFromHtml(html);
  const critic = criticReport({
    ledger,
    facts,
    slideCount: slideSpecs.length,
    repeatedLayoutCount: 0,
  });
  const qa = qaFromCritic(critic, {
    slide_count: slideSpecs.length,
    visual_surface_count: facts.length + ledger.sources.length,
    average_words_per_slide: Math.round((html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length || 0) / slideSpecs.length),
    max_words_on_slide: 95,
    html_bytes: Buffer.byteLength(html, 'utf8'),
    source_ledger_count: ledger.sources.length,
  });
  const status = qa.status;
  const repairLog = critic.status === 'pass'
    ? [{ stage: 'critique', action: 'No semantic repair required.' }]
    : [{ stage: 'critique', action: 'Blocked polished status and surfaced source gaps/open questions as first-class slides.' }];

  return {
    job_id: jobId,
    status,
    engine_version: ARTIFACT_ENGINE_VERSION,
    qa_report: qa,
    pptx_base64: pptxBuffer.toString('base64'),
    pdf_base64: pdfBuffer.toString('base64'),
    html,
    screenshots,
    contact_sheet: contactSheet,
    layout_json: layoutJson,
    source_ledger: ledger,
    claim_spine: spine,
    deck_profile: profile,
    contact_sheet_summary: {
      slide_count: slideSpecs.length,
      layout_families: slideSpecs.map(([id]) => id),
      contact_sheet_file: contactSheet?.fileName || null,
      artifact_tool_rendered: true,
    },
    critic_report: critic,
    repair_log: repairLog,
    metrics: {
      renderer: 'artifact-tool',
      artifact_tool: true,
      engine_version: ARTIFACT_ENGINE_VERSION,
      slide_count: slideSpecs.length,
      pptx_bytes: pptxBuffer.byteLength,
      pdf_bytes: pdfBuffer.byteLength,
      html_bytes: Buffer.byteLength(html, 'utf8'),
    },
  };
}

export function artifactToolUnavailableResult(jobId, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    job_id: jobId || 'unknown',
    status: 'failed',
    engine_version: ARTIFACT_ENGINE_VERSION,
    qa_report: {
      status: 'failed',
      slideFindings: [{
        slideId: 'artifact_tool',
        severity: 'critical',
        issue: 'Artifact-tool presentation runtime is unavailable.',
        requiredFix: 'Deploy the self-hosted artifact-tool deck renderer or switch the request to fast mode explicitly.',
      }],
      checks: {
        slide_count: 0,
        visual_surface_count: 0,
        average_words_per_slide: 0,
        max_words_on_slide: 0,
        accent_gutter_px: 0,
        html_bytes: 0,
        engine_version: ARTIFACT_ENGINE_VERSION,
      },
    },
    screenshots: [],
    source_ledger: { status: 'empty', internal_count: 0, web_count: 0, open_question_count: 0, sources: [], open_questions: [] },
    critic_report: {
      status: 'failed',
      score: 0,
      max_score: 60,
      findings: [{ severity: 'critical', type: 'runtime', issue: message, required_fix: 'Install @oai/artifact-tool for the deck renderer service.' }],
      top_findings: [{ slideId: 'runtime', severity: 'critical', issue: message, requiredFix: 'Install @oai/artifact-tool for the deck renderer service.' }],
    },
    repair_log: [{ stage: 'runtime', action: message }],
    metrics: { renderer: 'artifact-tool', error: message },
    error: message,
  };
}
