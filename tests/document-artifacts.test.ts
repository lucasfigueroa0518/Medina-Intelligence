import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  __documentArtifactsTestHooks,
  markDeckRenderQueueFailure,
  reconcileDeckArtifactJobs,
} from '../src/lib/document-artifacts';

function makeDeckD1Mock(job: Record<string, any>, queueRows: Array<Record<string, any>> = []) {
  const updates: Array<{ sql: string; args: any[] }> = [];
  const events: Array<{ event_type: string; payload: any; args: any[] }> = [];
  const mock = {
    updates,
    events,
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (sql.includes('COALESCE(MAX(seq)')) return { seq: events.length + 1 };
              if (sql.includes('FROM deck_artifact_jobs')) return { ...job };
              return null;
            },
            async all() {
              if (sql.includes('JOIN work_queue')) {
                return { results: queueRows.map(row => ({ ...job, ...row })) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes('UPDATE deck_artifact_jobs')) updates.push({ sql, args });
              if (sql.includes('INSERT INTO deck_artifact_job_events')) {
                events.push({
                  event_type: args[4],
                  payload: JSON.parse(args[5] || '{}'),
                  args,
                });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return mock;
}

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
    expect(html).toContain('cover-grid');
    expect(html).toContain('HTML source of truth');
    expect(html).not.toContain('color-mix(');
    expect(html).not.toMatch(/Claim spine|Evidence-first proof|QA-gated export/i);
    expect(html).not.toContain('...');
    expect(qa.status).toBe('pass');
    expect(qa.checks.visual_surface_count).toBeGreaterThanOrEqual(4);
  });

  it('renders table-only deck slides as full-width proof surfaces instead of empty narrative columns', () => {
    const html = __documentArtifactsTestHooks.renderPremiumDeckHtml('NeuralSeek Deal Status Update', {
      summary: 'Pipeline status update for internal review.',
      slides: [
        {
          layout: 'cover',
          title: 'NeuralSeek — Deal Status Update | May 2026',
          headline: 'A long-form deal-review cover title should stay away from proof cards and metadata.',
          evidence_blocks: ['Current valuation target: $250M', 'All-channel ARR: $1.8M', 'NS direct ARR: $168K'],
        },
        {
          layout: 'matrix',
          title: 'Financial Snapshot — As of Dec 31, 2025',
          headline: 'All-channel ARR and channel dependency frame the underwriting question.',
          table: {
            headers: ['Dimension', 'Summary', 'Status'],
            rows: [
              ['Product', 'Agentic AI control-layer platform; no-code and multi-cloud', 'Validated'],
              ['ARR', '$1,789,560 all channels; $168,000 NS-led', 'Needs split'],
              ['Valuation', 'Seed round with target $250M via SaaS ARR growth', 'Open'],
            ],
          },
        },
        {
          layout: 'matrix',
          title: 'Pipeline Proof',
          headline: 'Key evidence is stronger when the table owns the slide.',
          table: {
            headers: ['Signal', 'Evidence', 'Implication'],
            rows: [['Customer count', '136 enterprise clients', 'Logo proof'], ['Geography', '24 countries', 'Enterprise reach']],
          },
        },
        { title: 'Risk Register', headline: 'Open risks are explicit.', bullets: ['Revenue bridge', 'IBM channel concentration', 'Corporate structure'] },
        { title: 'Action Grid', headline: 'Owners can resolve the next diligence push.', table: { headers: ['Step', 'Owner'], rows: [['Revenue bridge', 'Finance']] } },
        { title: 'Decision Frame', headline: 'Proceed if revenue quality clears.', bullets: ['Confirm direct ARR', 'Validate customer depth'] },
      ],
    });

    expect(html).toContain('class="proof-full full-table"');
    expect(html).toContain('class="cover-grid"');
    expect(html).not.toContain('<div class="cover-proof" style=');
    expect(html).not.toContain('...');
  });

  it('flags literal dot-dot-dot truncation in generated deck titles and headlines', () => {
    const qa = __documentArtifactsTestHooks.evaluatePremiumDeckQa('NeuralSeek Update', {
      slides: [
        { layout: 'cover', title: 'NeuralSeek Update', headline: 'Decision context' },
        { title: 'Financial Snapshot...', headline: 'ARR evidence should be rewritten without dot-dot-dot truncation.' },
        { title: 'Customer Proof', headline: 'Customer proof is directional.', bullets: ['136 clients', '24 countries'] },
        { title: 'Risk Register', headline: 'Risks are explicit.', bullets: ['Revenue bridge', 'Channel dependence'] },
        { title: 'Action Grid', headline: 'Owners need follow-through.', table: { headers: ['Action', 'Owner'], rows: [['ARR bridge', 'Finance']] } },
        { title: 'Decision Frame', headline: 'Proceed after confirmatory diligence.', bullets: ['Confirm direct ARR', 'Validate customer depth'] },
      ],
    });

    expect(qa.status).toBe('needs_revision');
    expect(qa.slideFindings.some(f => /literal ellipses/i.test(f.issue))).toBe(true);
  });

  it('flags placeholder Slide N titles before export', () => {
    const qa = __documentArtifactsTestHooks.evaluatePremiumDeckQa('TOLUAI Opportunity', {
      slides: [
        { layout: 'cover', title: 'TOLUAI Opportunity', headline: 'Decision context' },
        { title: 'Slide 2', headline: 'This should be a claim, not a placeholder title.', evidence_blocks: ['Founder call needed'] },
        { title: 'Product workflow needs proof', headline: 'The workflow claim should be source-backed.', evidence_blocks: ['ToluAI 360'] },
        { title: 'Market wedge depends on buyer urgency', headline: 'The wedge must connect to budgeted pain.', evidence_blocks: ['Finance and energy buyers'] },
        { title: 'Risks are underwriteable if owners close the gaps', headline: 'Open diligence items are explicit.', bullets: ['Revenue proof', 'Customer validation'] },
        { title: 'Next action is a source-backed founder call', headline: 'Request materials before circulation.', table: { headers: ['Action', 'Owner'], rows: [['Founder call', 'Deal team']] } },
      ],
    });

    expect(qa.status).toBe('failed');
    expect(qa.slideFindings.some(f => /placeholder title/i.test(f.issue))).toBe(true);
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

  it('surfaces QA-blocked draft-review deck artifacts without treating them as polished', () => {
    const job = {
      pptx_document_id: 'pptx_1',
      html_document_id: 'html_1',
      pdf_document_id: 'pdf_1',
    };

    expect(__documentArtifactsTestHooks.deckVisibleDocumentIdsForQa(false, job, 'rendered_pdf_1')).toEqual([]);
    expect(__documentArtifactsTestHooks.deckVisibleDocumentIdsForQa(false, job, 'rendered_pdf_1', { surfaceDraft: true })).toEqual(['pptx_1', 'html_1', 'rendered_pdf_1']);
    expect(__documentArtifactsTestHooks.deckArtifactVisibilityForStatus('qa_blocked', ['html_1'])).toBe('draft_review');
    expect(__documentArtifactsTestHooks.deckArtifactVisibilityForStatus('completed', ['pptx_1'])).toBe('polished');
    expect(__documentArtifactsTestHooks.deckArtifactVisibilityForStatus('failed', [])).toBe('none');
    expect(__documentArtifactsTestHooks.deckDiagnosticDocumentIdsForStatus('qa_blocked', ['shot_1', 'shot_2'], 'qa_1')).toEqual(['shot_1', 'shot_2', 'qa_1']);
    expect(__documentArtifactsTestHooks.deckDiagnosticDocumentIdsForStatus('completed', ['shot_1'], 'qa_1')).toEqual([]);
    expect(__documentArtifactsTestHooks.deckVisibleDocumentIdsForQa(true, job, 'rendered_pdf_1')).toEqual(['pptx_1', 'html_1', 'rendered_pdf_1']);
  });

  it('preserves assistant tool metadata when adding visible deck cards', () => {
    const existingMetadata = JSON.stringify({
      tool_calls: [{ id: 'tool_1', tool: 'create_deck_artifact', runs: [{ status: 'done' }] }],
      document_cards: [{
        document_id: 'existing_doc',
        title: 'Existing document',
        file_name: 'existing.pdf',
        mime_type: 'application/pdf',
        document_type: 'pdf',
        mode: 'compact',
      }],
    });
    const metadata = __documentArtifactsTestHooks.mergeDeckCardsIntoMessageMetadata(
      existingMetadata,
      [{
        document_id: 'draft_html',
        title: 'Draft HTML Deck',
        file_name: 'draft.html',
        mime_type: 'text/html; charset=utf-8',
        document_type: 'html',
        mode: 'dominant',
        reason: 'Draft-review deck export; usable but needs visual QA review',
        actions: { preview: true, download: true, send_to_marty: true },
      }],
      {
        id: 'deck_job_1',
        status: 'qa_blocked',
        phase: 'qa_blocked',
        title: 'Pipeline deck',
        artifact_visibility: 'draft_review',
        visible_document_cards: [{ document_id: 'draft_html', title: 'Draft HTML Deck' }],
      }
    );

    expect(metadata.tool_calls?.[0]).toMatchObject({ id: 'tool_1', tool: 'create_deck_artifact' });
    expect(metadata.document_cards.map((card: any) => card.document_id)).toEqual(['existing_doc', 'draft_html']);
    expect(metadata.deck_jobs).toHaveLength(1);
    expect(metadata.deck_jobs[0]).toMatchObject({ id: 'deck_job_1', artifact_visibility: 'draft_review' });
  });

  it('sanitizes deck render results before D1 storage', () => {
    const safe = __documentArtifactsTestHooks.sanitizeDeckRenderResultForStorage({
      job_id: 'job_1',
      status: 'needs_revision',
      pdf_base64: 'JVBERi0x',
      qa_report: {
        status: 'needs_revision',
        slideFindings: [],
        checks: {
          slide_count: 1,
          visual_surface_count: 1,
          average_words_per_slide: 20,
          max_words_on_slide: 20,
          accent_gutter_px: 104,
          html_bytes: 1024,
        },
      },
      screenshots: [{
        slideId: 'slide_1',
        index: 1,
        fileName: 'slide.png',
        mimeType: 'image/png',
        width: 1600,
        height: 900,
        base64: 'iVBORw0KGgo=',
        document_id: 'shot_1',
      }],
      metrics: { renderer: 'test' },
    });

    expect(JSON.stringify(safe)).not.toContain('pdf_base64');
    expect(JSON.stringify(safe)).not.toContain('iVBORw0KGgo=');
    expect((safe?.screenshots as any[])[0]).toMatchObject({ slideId: 'slide_1', document_id: 'shot_1' });
  });

  it('reconciles queue dead-lettered active deck jobs into draft-review terminal state when artifacts exist', async () => {
    const job = {
      id: 'job_1',
      org_id: 'org_1',
      user_id: null,
      assistant_message_id: 'msg_1',
      status: 'running',
      phase: 'html_render',
      title: 'NeuralSeek Deck',
      html_document_id: 'html_1',
      pdf_document_id: 'pdf_1',
      pptx_document_id: null,
    };
    const d1 = makeDeckD1Mock(job, [{
      queue_status: 'dead_letter',
      queue_last_error: 'PPTX is too bullet-heavy',
      queue_completed_at: '2026-05-18T00:00:00.000Z',
    }]);

    const result = await reconcileDeckArtifactJobs({ D1: d1 } as any, { limit: 5 });

    expect(result).toMatchObject({ scanned: 1, reconciled: 1, qa_blocked: 1, failed: 0 });
    expect(d1.updates[0].args[0]).toBe('qa_blocked');
    expect(d1.updates[0].args[3]).toBe(JSON.stringify(['html_1', 'pdf_1']));
    expect(d1.events.some(event => event.event_type === 'qa_blocked')).toBe(true);
  });

  it('marks renderer failures retrying before terminal failure', async () => {
    const job = {
      id: 'job_retry',
      org_id: 'org_1',
      user_id: null,
      status: 'running',
      phase: 'render_qa',
      title: 'Retry Deck',
    };
    const d1 = makeDeckD1Mock(job);

    await markDeckRenderQueueFailure({ D1: d1 } as any, 'job_retry', new Error('renderer timeout'), {
      terminal: false,
      attempt: 1,
      maxAttempts: 2,
    });

    expect(d1.updates[0].args[0]).toContain('renderer timeout');
    expect(d1.events.some(event => event.event_type === 'retry_scheduled')).toBe(true);
    expect(d1.events.find(event => event.event_type === 'retry_scheduled')?.payload).toMatchObject({
      status: 'queued',
      attempt: 1,
      max_attempts: 2,
    });
  });
});
