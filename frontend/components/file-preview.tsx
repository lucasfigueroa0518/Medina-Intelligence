'use client';

import React from 'react';
import { Loader2, AlertCircle, FileText } from 'lucide-react';

// Shared inline-preview primitive used by both upload-preview-modal and the
// documents detail page. Pure rendering — caller is responsible for fetching
// the blob/text and passing in `src` (for pdf/image) or `text`. This split
// keeps auth concerns at the call site: the modal can pass a same-origin URL
// (cookie-auth), the detail page passes a blob: URL after a bearer-fetch.
export type FilePreviewKind = 'pdf' | 'image' | 'docx' | 'xlsx' | 'pptx' | 'html' | 'text' | 'unsupported';

export function FilePreview({
  kind,
  src,
  text,
  fileName,
  loading,
  error,
  emptyMessage,
}: {
  kind: FilePreviewKind;
  src?: string;
  text?: string;
  fileName?: string;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
}) {
  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading preview…
      </div>
    );
  }
  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center text-semantic-error text-xs">
        <AlertCircle size={14} className="mr-2" /> {error}
      </div>
    );
  }
  if (kind === 'pdf' && src) {
    const pdfSrc = src.startsWith('blob:') ? `${src}#toolbar=1&navpanes=0&view=FitH` : src;
    return <iframe src={pdfSrc} title={fileName || 'document'} className="w-full h-full rounded-md bg-white" />;
  }
  if (kind === 'image' && src) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black/40 rounded-md overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={fileName || ''} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }
  if (kind === 'docx' && src) {
    return <DocxPreview src={src} fileName={fileName} />;
  }
  if (kind === 'xlsx' && src) {
    return <XlsxPreview src={src} fileName={fileName} />;
  }
  if (kind === 'pptx' && src) {
    return <PptxPreview src={src} fileName={fileName} />;
  }
  if (kind === 'html' && src) {
    return (
      <iframe
        src={src}
        title={fileName || 'deck preview'}
        sandbox="allow-same-origin"
        className="w-full h-full rounded-md bg-white"
      />
    );
  }
  if (kind === 'text' && text) {
    return (
      <pre className="w-full h-full overflow-auto bg-bg-root rounded-md p-4 text-xs text-text-secondary whitespace-pre-wrap font-mono">
        {text}
      </pre>
    );
  }
  return (
    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs gap-2">
      <FileText size={14} />
      {emptyMessage || 'Preview not available for this file type.'}
    </div>
  );
}

// Map a mime_type to a FilePreviewKind. Unknown types fall through to
// 'unsupported' so the caller can render a "Preview not available" hint.
export function kindFromMime(mime: string | null | undefined): FilePreviewKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('application/pdf')) return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.includes('wordprocessingml.document') || m === 'application/msword') return 'docx';
  if (m.includes('spreadsheetml.sheet') || m.includes('ms-excel') || m.includes('excel')) return 'xlsx';
  if (m.includes('presentationml.presentation') || m.includes('powerpoint') || m.includes('presentation')) return 'pptx';
  if (m.startsWith('text/html') || m.includes('html')) return 'html';
  if (m.startsWith('text/')) return 'text';
  return 'unsupported';
}

function DocxPreview({ src, fileName }: { src: string; fileName?: string }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    setError(null);

    (async () => {
      try {
        const [{ renderAsync }, res] = await Promise.all([
          import('docx-preview'),
          fetch(src),
        ]);
        if (!res.ok) throw new Error(`DOCX preview failed (${res.status})`);
        const buffer = await res.arrayBuffer();
        if (cancelled || !hostRef.current) return;
        await renderAsync(buffer, hostRef.current, undefined, {
          className: 'docx-preview',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'DOCX preview unavailable');
      }
    })();

    return () => {
      cancelled = true;
      if (host) host.innerHTML = '';
    };
  }, [src]);

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center text-semantic-error text-xs">
        <AlertCircle size={14} className="mr-2" /> {error}
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-auto rounded-md bg-zinc-100 text-zinc-950" title={fileName}>
      <div
        ref={hostRef}
        className="min-h-full p-3 md:p-5 [&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-0 [&_.docx]:mx-auto [&_.docx]:max-w-full [&_.docx]:shadow-lg"
      />
    </div>
  );
}

function XlsxPreview({ src, fileName }: { src: string; fileName?: string }) {
  const [sheets, setSheets] = React.useState<Array<{ name: string; rows: any[][] }>>([]);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSheets([]);
    setActive(0);

    (async () => {
      try {
        const [XLSX, res] = await Promise.all([
          import('xlsx'),
          fetch(src),
        ]);
        if (!res.ok) throw new Error(`Workbook preview failed (${res.status})`);
        const buffer = await res.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        const parsed = wb.SheetNames.map(name => {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
            header: 1,
            blankrows: false,
            raw: false,
          }) as any[][];
          return { name, rows: rows.slice(0, 200).map(row => row.slice(0, 26)) };
        });
        if (!cancelled) {
          setSheets(parsed);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || 'Workbook preview unavailable');
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [src]);

  if (loading) return <FilePreview kind="unsupported" loading />;
  if (error) return <FilePreview kind="unsupported" error={error} />;
  const sheet = sheets[active];
  if (!sheet || sheet.rows.length === 0) {
    return <FilePreview kind="unsupported" emptyMessage="Workbook has no previewable rows." />;
  }

  const maxCols = Math.max(...sheet.rows.map(row => row.length), 1);
  const header = sheet.rows[0] || [];
  const body = sheet.rows.slice(1);

  return (
    <div className="w-full h-full min-h-0 flex flex-col rounded-md bg-[#08080b] text-text-primary overflow-hidden" title={fileName}>
      <div className="shrink-0 flex items-center gap-1 overflow-x-auto border-b border-white/[0.08] bg-white/[0.025] px-3 py-2">
        {sheets.map((s, idx) => (
          <button
            key={`${s.name}-${idx}`}
            type="button"
            onClick={() => setActive(idx)}
            className={`px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors ${
              idx === active ? 'bg-purple-500/20 text-purple-100' : 'text-text-muted hover:text-text-primary hover:bg-white/5'
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-[#111116]">
            <tr>
              {Array.from({ length: maxCols }, (_, i) => (
                <th
                  key={i}
                  className="min-w-[140px] border-b border-r border-white/[0.07] px-3 py-2 text-left font-medium text-text-muted"
                >
                  {String(header[i] ?? `Column ${i + 1}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIdx) => (
              <tr key={rowIdx} className={rowIdx % 2 === 0 ? 'bg-white/[0.015]' : undefined}>
                {Array.from({ length: maxCols }, (_, i) => (
                  <td key={i} className="max-w-[320px] border-b border-r border-white/[0.05] px-3 py-2 align-top text-text-secondary">
                    <span className="line-clamp-3 break-words">{String(row[i] ?? '')}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 px-3 py-2 text-[11px] text-text-muted border-t border-white/[0.06]">
        Showing up to 200 rows and 26 columns for preview. Download for the native workbook.
      </div>
    </div>
  );
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function PptxPreview({ src, fileName }: { src: string; fileName?: string }) {
  const [slides, setSlides] = React.useState<Array<{ title: string; lines: string[] }>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSlides([]);

    (async () => {
      try {
        const [JSZipModule, res] = await Promise.all([
          import('jszip'),
          fetch(src),
        ]);
        if (!res.ok) throw new Error(`Presentation preview failed (${res.status})`);
        const buffer = await res.arrayBuffer();
        const zip = await JSZipModule.default.loadAsync(buffer);
        const slideNames = Object.keys(zip.files)
          .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => {
            const ai = Number(a.match(/slide(\d+)/)?.[1] || 0);
            const bi = Number(b.match(/slide(\d+)/)?.[1] || 0);
            return ai - bi;
          });
        const parsed: Array<{ title: string; lines: string[] }> = [];
        for (const name of slideNames.slice(0, 40)) {
          const xml = await zip.file(name)?.async('string');
          const textRuns = [...(xml || '').matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
            .map(match => decodeXmlText(match[1]).replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          parsed.push({
            title: textRuns[0] || `Slide ${parsed.length + 1}`,
            lines: textRuns.slice(1, 12),
          });
        }
        if (!cancelled) {
          setSlides(parsed);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || 'Presentation preview unavailable');
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [src]);

  if (loading) return <FilePreview kind="unsupported" loading />;
  if (error) return <FilePreview kind="unsupported" error={error} />;
  if (slides.length === 0) return <FilePreview kind="unsupported" emptyMessage="Presentation has no previewable slides." />;

  return (
    <div className="w-full h-full overflow-auto rounded-md bg-[#07070a] p-4 md:p-6" title={fileName}>
      <div className="mx-auto grid w-full max-w-5xl gap-5">
        {slides.map((slide, idx) => (
          <section
            key={idx}
            className="aspect-video rounded-xl border border-white/[0.08] bg-gradient-to-br from-[#111116] to-[#09090d] shadow-xl overflow-hidden"
          >
            <div className="h-full flex flex-col p-7">
              <div className="text-[11px] uppercase tracking-[0.18em] text-purple-300/75 mb-4">Slide {idx + 1}</div>
              <h3 className="text-2xl font-semibold text-white leading-tight max-w-[80%]">{slide.title}</h3>
              {slide.lines.length > 0 && (
                <ul className="mt-6 space-y-2 text-sm text-zinc-300 max-w-[78%]">
                  {slide.lines.map((line, lineIdx) => (
                    <li key={lineIdx} className="flex gap-2">
                      <span className="mt-2 h-1.5 w-1.5 rounded-full bg-purple-300 shrink-0" />
                      <span className="line-clamp-3">{line}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-auto flex justify-between text-[11px] text-zinc-500">
                <span>Preview rendering</span>
                <span>{idx + 1}/{slides.length}</span>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
