import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { __documentArtifactsTestHooks } from '../src/lib/document-artifacts';

describe('document artifact quality gates', () => {
  it('flags skeletal DOCX sections and raw markup leaks before generation', () => {
    const issues = __documentArtifactsTestHooks.contentQualityIssues('docx', {
      subtitle: 'Investment memo',
      summary: 'Short summary of the memo.',
      sections: [
        {
          heading: 'High-Conviction Concerns',
          paragraphs: ['These are the three concerns that most materially affect the underwriting case.'],
        },
        { heading: 'Medium Concerns' },
        { heading: 'Risk Register', paragraphs: ['<w:tbl><w:tr><w:tc>bad</w:tc></w:tr></w:tbl>'] },
      ],
    });

    expect(issues.join(' ')).toMatch(/empty section headings/i);
    expect(issues.join(' ')).toMatch(/setup-only sections/i);
    expect(issues.join(' ')).toMatch(/raw markup/i);
  });

  it('allocates readable DOCX table columns instead of 100-unit percentage grids', async () => {
    const widths = __documentArtifactsTestHooks.docxTableColumnWidths(
      ['#', 'Concern', 'Tier', 'Status', 'Owner'],
      [
        ['1', 'Revenue quality / channel concentration requires clean SaaS ARR bridge.', 'High', 'Open - needs mitigation before close.', 'Alvaro'],
        ['2', 'Technical diligence depth and roadmap evidence still need customer proof.', 'Medium', 'In progress.', 'Tony'],
      ]
    );

    expect(widths).toHaveLength(5);
    expect(widths.reduce((sum: number, width: number) => sum + width, 0)).toBe(9360);
    expect(Math.max(...widths)).toBeGreaterThan(2500);
    expect(widths.every((width: number) => width > 200)).toBe(true);

    const bytes = await __documentArtifactsTestHooks.makeDocx('Risk Memo', {
      subtitle: 'Prepared by MARTy',
      summary: 'A concise decision frame with enough space around the callout border to read comfortably.',
      sections: [{
        heading: 'Risk Register',
        paragraphs: ['The table below is intentionally wide enough to be useful in Word.'],
        tables: [{
          headers: ['#', 'Concern', 'Tier', 'Status', 'Owner'],
          rows: [
            ['1', 'Revenue quality / channel concentration requires clean SaaS ARR bridge.', 'High', 'Open - needs mitigation before close.', 'Alvaro'],
            ['2', 'Technical diligence depth and roadmap evidence still need customer proof.', 'Medium', 'In progress.', 'Tony'],
          ],
        }],
      }],
    });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')?.async('string');
    expect(xml).toBeTruthy();
    expect(xml).toContain('w:type="dxa"');
    expect(xml).not.toContain('w:type="pct" w:w="100%"');
    const gridWidths = [...String(xml).matchAll(/<w:gridCol[^>]+w:w="(\d+)"/g)].map(match => Number(match[1]));
    expect(gridWidths.length).toBeGreaterThanOrEqual(5);
    expect(gridWidths.slice(0, 5).every(width => width > 200)).toBe(true);
  });

  it('keeps the DOCX callout accent away from the text', async () => {
    const bytes = await __documentArtifactsTestHooks.makeDocx('Callout Memo', {
      subtitle: 'Prepared by MARTy',
      summary: 'This is the lead callout. It should read like a memo note, not like text pressed against a vertical rule.',
      sections: [{ heading: 'Executive Summary', paragraphs: ['The body content is present and substantive enough for the generator.'] }],
    });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')?.async('string');
    const calloutBlock = String(xml).match(/<w:p\b[\s\S]*?<w:pStyle[^>]+w:val="Callout"[\s\S]*?<\/w:p>/)?.[0] || '';
    const indent = Number(calloutBlock.match(/<w:ind[^>]+w:left="(\d+)"/)?.[1] || 0);

    expect(indent).toBeGreaterThanOrEqual(540);
    expect(calloutBlock).toContain('w:space="14"');
  });

  it('builds an HTML-first deck plan with Medina branding and safe accent spacing', () => {
    const content = {
      audience: 'internal IC',
      objective: 'decide',
      style_pack: 'medina_default',
      summary: 'NeuralSeek is ready for a decision if revenue quality and channel concentration are underwritten explicitly.',
      slides: [
        { layout: 'cover', title: 'NeuralSeek IC Decision', headline: 'A focused diligence deck for the investment committee.' },
        { layout: 'executive_summary', title: 'The decision is attractive but not automatic', headline: 'Medina can underwrite the round if SaaS ARR and IBM channel dependence are separated.', metrics: [{ label: 'Probability', value: '84%' }, { label: 'Lead', value: '$1M' }] },
        { layout: 'matrix', title: 'Revenue quality is the central diligence issue', headline: 'The underwriting case depends on isolating repeatable SaaS from services and channel resale.', table: { headers: ['Question', 'Why it matters', 'Status'], rows: [['SaaS ARR', 'Baseline for valuation', 'Needs bridge'], ['IBM channel', 'Concentration risk', 'Needs mitigation']] } },
        { layout: 'evidence', title: 'Customer proof is real but uneven', headline: 'Enterprise logos support the thesis while usage depth still needs confirmation.', evidence_blocks: ['136 enterprise clients', '24 countries', 'Customer-driven roadmap'] },
        { layout: 'risk', title: 'Open diligence items remain underwriteable', headline: 'The risks are explicit enough to assign owners before close.', bullets: ['Revenue bridge', 'Channel concentration', 'Corporate structure'] },
        { layout: 'next_steps', title: 'The next step is a scoped confirmatory diligence push', headline: 'Resolve the open questions before Medina commits.', table: { headers: ['Step', 'Owner', 'Output'], rows: [['Revenue bridge', 'Finance', 'Clean ARR split'], ['Customer calls', 'Deal team', 'Reference notes']] } },
      ],
    };

    const plan = __documentArtifactsTestHooks.deckPlanFromContent('NeuralSeek IC Decision', content);
    const html = __documentArtifactsTestHooks.renderPremiumDeckHtml('NeuralSeek IC Decision', content);
    const qa = __documentArtifactsTestHooks.evaluatePremiumDeckQa('NeuralSeek IC Decision', content, html);

    expect(plan.style_pack).toBe('medina_default');
    expect(plan.objective).toBe('decide');
    expect(plan.slides).toHaveLength(6);
    expect(html).toContain('--accent-gutter: 104px');
    expect(html).toContain('data-accent-line="true"');
    expect(html).toContain('HTML source of truth');
    expect(qa.status).toBe('pass');
    expect(qa.checks.visual_surface_count).toBeGreaterThanOrEqual(4);
  });

  it('blocks critically unsafe deck QA before polished export', () => {
    const qa = __documentArtifactsTestHooks.evaluatePremiumDeckQa('Thin Deck', {
      slides: [
        { layout: 'cover', title: 'Thin Deck' },
        { title: '' },
      ],
    });

    expect(qa.status).toBe('failed');
    expect(qa.slideFindings.some(f => f.severity === 'critical')).toBe(true);
  });

  it('repairs blocking deck QA by compressing dense bullets into safer exhibits', () => {
    const denseContent = {
      slides: [
        { layout: 'cover', title: 'Portfolio Review', headline: 'Weekly operating update' },
        {
          layout: 'evidence',
          title: 'Everything that happened across the portfolio this week and why each item needs a decision',
          headline: 'This slide intentionally carries too much detail so the deterministic repair must reduce density.',
          bullets: [
            'NeuralSeek diligence needs a revenue bridge, channel concentration analysis, customer proof, and corporate structure resolution.',
            'Tier4 AI needs sales pipeline cleanup, champion mapping, follow-up ownership, and renewed urgency around next customer meetings.',
            'QNECT requires clearer founder updates, financial hygiene, and a concise memo on traction since the last board discussion.',
            'Hedgehog needs current metrics, burn trajectory, runway, team plan, and evidence of durable customer pull.',
            'Medina should consolidate owners, due dates, blockers, next decisions, and evidence quality before the next IC meeting.',
            'The appendix should hold raw detail while the main slide focuses on the operating point and the decision required.',
          ],
        },
      ],
    };
    const qa = __documentArtifactsTestHooks.evaluatePremiumDeckQa('Portfolio Review', denseContent);

    expect(__documentArtifactsTestHooks.deckQaHasBlockingFindings(qa)).toBe(true);

    const repaired = __documentArtifactsTestHooks.deterministicDeckRepair('Portfolio Review', denseContent, qa, 1);
    const repairedSlide = repaired.slides[1];

    expect(repairedSlide.layout).toBe('matrix');
    expect(repairedSlide.bullets).toEqual([]);
    expect(repairedSlide.table.rows.length).toBeLessThanOrEqual(6);
    expect(repairedSlide.table.rows[0][1].split(/\s+/).length).toBeLessThanOrEqual(17);
  });

  it('normalizes deck output formats and exposes the render queue domain', () => {
    expect(__documentArtifactsTestHooks.normalizeDeckOutputFormats(['pdf', 'pptx', 'bogus', 'pdf'])).toEqual(['pdf', 'pptx']);
    expect(__documentArtifactsTestHooks.normalizeDeckOutputFormats([])).toEqual(['html', 'pdf', 'pptx']);
    expect(__documentArtifactsTestHooks.DECK_RENDER_WORK_DOMAIN).toBe('deck_render');
    expect(__documentArtifactsTestHooks.MAX_DECK_REVISION_ROUNDS).toBe(3);
  });
});
