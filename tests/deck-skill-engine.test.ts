import { describe, expect, it } from 'vitest';
import {
  MEDINA_DECK_ENGINE_VERSION,
  buildMedinaDeckStudio,
  evaluateDeckStudioSpec,
  type DeckStudioSpec,
} from '../src/lib/deck-skill-engine';

function layoutFamilyCount(spec: DeckStudioSpec): number {
  return new Set(spec.contact_sheet.layout_families).size;
}

describe('Medina deck skill engine', () => {
  it('turns a TOLUAI-like loose prompt into claim-led slides with layout variety', () => {
    const result = buildMedinaDeckStudio('TOLUAI — Investment Opportunity Overview', {
      summary: 'TOLUAI is an AI-native decision intelligence platform for finance, energy, and private equity.',
      source_document_ids: ['doc_toluai_profile'],
      slides: [
        { title: 'Slide 1', headline: 'The Opportunity in One Slide', evidence_blocks: ['Targets finance, energy, and private equity institutions'] },
        { title: 'Slide 2', headline: 'The Problem: institutions fly blind on high-stakes decisions', evidence_blocks: ['Forward-looking simulation before expensive decisions'] },
        { title: 'Slide 3', headline: 'TOLUAI 360 and Peridot connect risk, operations, and energy intelligence', evidence_blocks: ['ToluAI 360', 'Peridot for Exploration & Production'] },
        { title: 'Market', headline: 'U.S. and LATAM expansion creates a wedge if budgeted pain is proven', evidence_blocks: ['eMerge Americas presence in Miami'] },
        { title: 'Team', headline: 'Founder Tosin Joel maps energy and technology credibility to the wedge', evidence_blocks: ['Tosin Joel, Founder & CEO'] },
        { title: 'Next Steps', headline: 'Request the pitch deck, founder call, and evidence pack', bullets: ['Founder call', 'Pitch deck', 'Customer proof'] },
      ],
    }, {
      prompt: 'Make me a deck about the TOLUAI opportunity. Explain it to me.',
      audience: 'Medina investment team',
      objective: 'decide',
    });

    const slideTitles = result.structuredContent.slides.map((slide: any) => slide.title).join(' ');

    expect(result.structuredContent.engine_version).toBe(MEDINA_DECK_ENGINE_VERSION);
    expect(result.spec.slides.length).toBeGreaterThanOrEqual(8);
    expect(layoutFamilyCount(result.spec)).toBeGreaterThanOrEqual(5);
    expect(slideTitles).not.toMatch(/\bSlide\s+\d+\b/i);
    expect(slideTitles).not.toMatch(/claim spine|evidence-first proof|qa-gated export|proof object/i);
    expect(result.spec.slides.every(slide => slide.claim_title.split(/\s+/).length >= 4)).toBe(true);
  });

  it('critic blocks noun-swappable placeholder decks even when the object shape is valid', () => {
    const base = buildMedinaDeckStudio('TOLUAI — Investment Opportunity Overview', {
      summary: 'TOLUAI investment overview.',
      source_document_ids: ['doc_toluai_profile'],
    });
    const badSpec: DeckStudioSpec = {
      ...base.spec,
      contact_sheet: {
        slide_count: 6,
        layout_families: ['cover', 'executive_summary', 'executive_summary', 'executive_summary', 'executive_summary', 'executive_summary'],
        rhythm_notes: [],
      },
      slides: base.spec.slides.slice(0, 6).map((slide, index) => ({
        ...slide,
        id: `slide_${index + 1}`,
        claim_title: `Slide ${index + 1}`,
        layout_family: index === 0 ? 'cover' : 'executive_summary',
        proof_object: {
          ...slide.proof_object,
          title: 'Proof object',
          values: [],
          rows: [],
          source_ids: [],
          status: 'needs_source',
        },
      })),
    };

    const critic = evaluateDeckStudioSpec('TOLUAI — Investment Opportunity Overview', badSpec);

    expect(critic.status).toBe('failed');
    expect(critic.top_findings.some(finding => /placeholder title/i.test(finding.issue))).toBe(true);
    expect(critic.top_findings.some(finding => /internal generation language/i.test(finding.issue))).toBe(true);
    expect(critic.top_findings.some(finding => /Proof object is empty/i.test(finding.issue))).toBe(true);
  });

  it('keeps unsupported metrics as explicit source gaps instead of inventing values', () => {
    const result = buildMedinaDeckStudio('Early Stage Deal Review', {
      summary: 'The company looks promising, but the current source pack has no revenue, customer, or pricing metrics.',
      slides: [
        { title: 'Executive Summary', headline: 'The story is plausible but under-sourced.' },
        { title: 'Product', headline: 'The product claim needs proof.' },
        { title: 'Market', headline: 'The buyer wedge needs evidence.' },
      ],
    });

    const openQuestions = result.spec.slides.filter(slide => slide.proof_object.status === 'needs_source');

    expect(openQuestions.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.structuredContent)).toMatch(/Source gap|Open source gap|Need source-backed evidence/i);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/\$[0-9]/);
  });
});
