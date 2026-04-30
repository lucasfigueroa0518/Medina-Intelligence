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

// Wave 5.6 (A safety-net): PDF extraction is currently disabled in
// production. Both unpdf@1.6.2 and direct pdfjs-dist@5.7.284 fail under
// esbuild + wrangler bundling — esbuild cannot preserve pdfjs's static-
// class-block semantics, mangling identifiers and breaking polyfill setup
// at module-init. Tracked as Wave 5.6 follow-up; needs either (a) Rollup-
// pre-bundled artifact shipped as a Worker module, replicating what unpdf
// does internally, or (b) external extraction service. Phase A's failure-
// visibility infrastructure ensures every PDF now lands processing_status=
// 'failed' with a clear, stable error_message so users see the limitation
// rather than confusing parser internals like "Ch is not a constructor".

export async function extractTextFromFile(file: File): Promise<string> {
  const mimeType = file.type.toLowerCase();
  const fileName = file.name.toLowerCase();

  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    // Phase A's catch-and-stamp infra still runs against this throw —
    // the row lands processing_status='failed' with this stable message.
    // Stable string > confusing parser internals while we scope Wave 5.6.
    throw new Error('PDF extraction not yet supported in Workers runtime — Wave 5.6 follow-up');
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileName.endsWith('.docx')
  ) {
    try {
      const buffer = await file.arrayBuffer();
      const mod = await import('mammoth');
      const mammoth = (mod as any).default || mod;
      const result = await mammoth.extractRawText({ buffer });
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
      const XLSX = await import('xlsx');
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
