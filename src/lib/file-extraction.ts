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
