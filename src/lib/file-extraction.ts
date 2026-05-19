// TRD §18.6 — Extract text from uploaded files
//
// Wave 5 Phase A: extraction failures NO LONGER silently return ''. Each
// binary-format branch (PDF / DOCX / XLSX / PPTX) re-throws with a wrapping
// context, so callers can:
//   1) propagate the throw → persistDocument finalize() catches and marks
//      processing_status='failed' + error_message
//   2) catch locally and decide per-pipeline (e.g. intelligent_import keeps
//      ingesting but with no text payload)
// The CSV / text / markdown / JSON branch returns file.text() directly — no
// parser to fail. The "Unsupported file type" branch still returns '' (it's
// a known case, not an error).

// Wave 5.6: PDF extraction restored. Strategy after the unpdf and
// pdfjs-dist direct attempts both broke under esbuild's transformation:
// vendor unpdf's already-rolled pdfjs serverless bundle as a separate
// Worker additional module. wrangler.toml's `find_additional_modules`
// + `[[rules]] type = "ESModule"` ships the file as-is — esbuild does
// not transform it. The bundle is self-contained: DOMMatrix polyfill,
// fake-worker setup, and pdfjs internals all in correct init order.
// We skip the unpdf wrapper (which has its own `import('unpdf/pdfjs')`
// line that esbuild would follow and re-process the bundle) and call
// the vendored exports directly.
//
// Lazy-import pattern: the dynamic `import('./pdfjs-vendor/pdfjs.mjs')`
// fires on first PDF only, NOT at module init. This keeps cold-starts
// fast and isolates any future bundle issues to PDF requests.
let pdfjsCache: any = null;
async function getPdfjs(): Promise<any> {
  if (!pdfjsCache) {
    // Variable import path — esbuild cannot statically resolve, so it
    // does NOT bundle the target inline. The Worker runtime resolves
    // the path at request time, hitting the file shipped as additional
    // module by wrangler.toml's [[rules]] block. This is the load-
    // bearing trick: prior attempts used a literal string here, which
    // esbuild followed and re-bundled, mangling pdfjs's class identifiers.
    // Workers runtime resolves additional-module IDs relative to bundle
    // root (= base_dir = src/), not relative to the importing file. So
    // even though file-extraction.ts lives in src/lib/, the import path
    // for the additional module is its path FROM src/.
    const vendoredPath = 'lib/pdfjs-vendor/pdfjs.mjs';
    pdfjsCache = await import(vendoredPath);
  }
  return pdfjsCache;
}

export function isTextExtractionSupported(file: Pick<File, 'name' | 'type'>): boolean {
  const mimeType = (file.type || '').toLowerCase();
  const fileName = (file.name || '').toLowerCase();

  return (
    mimeType === 'application/pdf' ||
    fileName.endsWith('.pdf') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileName.endsWith('.docx') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    fileName.endsWith('.xlsx') ||
    fileName.endsWith('.xls') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    fileName.endsWith('.pptx') ||
    mimeType === 'text/csv' ||
    fileName.endsWith('.csv') ||
    mimeType.startsWith('text/') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.json')
  );
}

export function textExtractionUnsupportedMessage(file: Pick<File, 'name' | 'type'>): string {
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  const type = (file.type || '').trim();
  const format = ext ? `.${ext}` : (type || 'this file type');
  return `No readable text could be extracted from ${format}. The original file was stored, but no CRM records were created from its contents.`;
}

export async function extractTextFromFile(file: File): Promise<string> {
  const mimeType = file.type.toLowerCase();
  const fileName = file.name.toLowerCase();

  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    try {
      const buffer = await file.arrayBuffer();
      const pdfjs = await getPdfjs();
      const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        // Disable everything that would touch network, fonts, or eval —
        // we run headless inside a Worker and only want the text layer.
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        useWorkerFetch: false,
        disableAutoFetch: true,
        disableStream: true,
        verbosity: 0,
      });
      const doc = await loadingTask.promise;
      const parts: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        parts.push(content.items.map((it: any) => it.str || '').join(' '));
        try { page.cleanup?.(); } catch { /* best-effort */ }
      }
      try { await doc.destroy?.(); } catch { /* best-effort */ }
      return parts.join('\n\n');
    } catch (e: any) {
      throw new Error(`PDF extraction failed: ${e?.message || e}`);
    }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileName.endsWith('.docx')
  ) {
    try {
      const buffer = await file.arrayBuffer();
      const mod = await import('mammoth');
      const mammoth = (mod as any).default || mod;
      // mammoth expects `arrayBuffer` for browser/Worker contexts;
      // `buffer` is the Node Buffer key. Pre-Wave-5 this silently
      // failed (returned '' under the old swallow). Phase A's re-
      // throw made it visible during Phase D drain. Fix is the right
      // option key for ArrayBuffer input.
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      return result.value;
    } catch (e: any) {
      throw new Error(`DOCX extraction failed: ${e?.message || e}`);
    }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    fileName.endsWith('.xlsx') ||
    fileName.endsWith('.xls')
  ) {
    try {
      const XLSX = await import('@e965/xlsx');
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows: string[] = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if (csv.trim()) rows.push(`--- Sheet: ${sheetName} ---\n${csv}`);
      }
      return rows.join('\n\n');
    } catch (e: any) {
      throw new Error(`XLSX extraction failed: ${e?.message || e}`);
    }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    fileName.endsWith('.pptx')
  ) {
    try {
      const buffer = await file.arrayBuffer();
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buffer);
      const slides: string[] = [];
      const slideFiles = Object.keys(zip.files)
        .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort();
      for (const sf of slideFiles) {
        const xml = await zip.files[sf].async('text');
        const texts = xml.match(/<a:t>([^<]+)<\/a:t>/g)?.map(m => m.replace(/<\/?a:t>/g, '')) || [];
        if (texts.length > 0) slides.push(texts.join(' '));
      }
      return slides.join('\n\n');
    } catch (e: any) {
      throw new Error(`PPTX extraction failed: ${e?.message || e}`);
    }
  }

  if (mimeType === 'text/csv' || fileName.endsWith('.csv')) {
    return await file.text();
  }

  if (
    mimeType.startsWith('text/') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.json')
  ) {
    return await file.text();
  }

  // Known case, not an error: nothing to extract from this format. Caller
  // gets an empty string and proceeds (classifier sees filename only).
  console.warn(`Unsupported file type for text extraction: ${mimeType} (${fileName})`);
  return '';
}
