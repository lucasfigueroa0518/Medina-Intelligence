// TRD §18.6 — Extract text from uploaded files
// Uses dynamic imports so Workers bundles pdf-parse + mammoth on demand.

export async function extractTextFromFile(file: File): Promise<string> {
  const mimeType = file.type.toLowerCase();
  const fileName = file.name.toLowerCase();

  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    try {
      const buffer = await file.arrayBuffer();
      // @ts-expect-error — pdf-parse has no TypeScript types
      const mod = await import('pdf-parse');
      const pdfParse = (mod as any).default || mod;
      // Buffer is available at runtime via nodejs_compat flag
      const BufferCtor = (globalThis as any).Buffer;
      const result = await pdfParse(BufferCtor.from(buffer));
      return result.text as string;
    } catch (e) {
      console.error('PDF extraction failed:', e);
      return '';
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
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (e) {
      console.error('DOCX extraction failed:', e);
      return '';
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
    } catch (e) {
      console.error('XLSX extraction failed:', e);
      return '';
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
    } catch (e) {
      console.error('PPTX extraction failed:', e);
      return '';
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

  console.warn(`Unsupported file type for text extraction: ${mimeType} (${fileName})`);
  return '';
}
