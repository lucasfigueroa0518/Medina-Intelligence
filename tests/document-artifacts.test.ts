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
});
