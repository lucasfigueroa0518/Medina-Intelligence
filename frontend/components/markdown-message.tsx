'use client';

import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { citationsRemarkPlugin, findSourceByHashPrefix, type CitationSource } from '@/lib/citations';
import { CitationPill } from './citation-pill';

// React-markdown's defaultUrlTransform allowlists http/https/mailto/tel/#fragments
// and blanks out everything else — which would silently strip our `citation:N`
// scheme, leaving the <a> renderer with an empty href. That's why citation
// pills were falling through to the plain magenta-link branch and rendering as
// bare superscript numbers. Preserve `citation:N` URLs verbatim and delegate
// everything else to the default sanitizer.
function citationUrlTransform(url: string, _key: string, _node: any): string {
  if (typeof url === 'string' && url.startsWith('citation:')) return url;
  return defaultUrlTransform(url);
}

const HEADER_STYLE: React.CSSProperties = { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700 };
const BODY_STYLE: React.CSSProperties = { fontFamily: "'DM Sans', sans-serif", fontWeight: 400 };

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);
  const text = String(children).replace(/\n$/, '');
  const lang = className?.replace('hljs language-', '')?.replace('language-', '') || '';

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative group rounded-lg overflow-hidden my-3 bg-[#0d0d11] border border-border">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-surface border-b border-border">
        <span className="text-[10px] text-text-muted font-mono uppercase">{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors"
        >
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export function MarkdownMessage({
  content,
  sources,
  onCitationClick,
}: {
  content: string;
  sources?: CitationSource[];
  onCitationClick?: (source: CitationSource) => void;
}) {
  const sourceMap = React.useMemo(() => {
    const map = new Map<number, CitationSource>();
    for (const s of sources || []) map.set(s.id, s);
    return map;
  }, [sources]);

  return (
    <div className="markdown-body text-sm text-text-primary leading-relaxed" style={BODY_STYLE}>
      <ReactMarkdown
        remarkPlugins={[citationsRemarkPlugin, remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={citationUrlTransform}
        components={{
          h1: ({ children }) => {
            const id = String(children).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            return <h1 id={id} className="text-xl mt-6 mb-3 text-text-primary scroll-mt-16" style={HEADER_STYLE}>{children}</h1>;
          },
          h2: ({ children }) => {
            const id = String(children).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            return <h2 id={id} className="text-lg mt-5 mb-2 text-text-primary scroll-mt-16" style={HEADER_STYLE}>{children}</h2>;
          },
          h3: ({ children }) => {
            const id = String(children).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            return <h3 id={id} className="text-base mt-4 mb-2 text-text-primary scroll-mt-16" style={HEADER_STYLE}>{children}</h3>;
          },
          h4: ({ children }) => {
            const id = String(children).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            return <h4 id={id} className="text-sm mt-3 mb-1 text-text-primary scroll-mt-16" style={HEADER_STYLE}>{children}</h4>;
          },
          p: ({ children }) => <p className="mb-3 last:mb-0" style={BODY_STYLE}>{children}</p>,
          ul: ({ children }) => <ul className="mb-3 ml-4 space-y-1 list-disc">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 ml-4 space-y-1 list-decimal">{children}</ol>,
          li: ({ children }) => <li className="text-text-primary" style={BODY_STYLE}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-accent-magenta/50 pl-4 my-3 text-text-secondary italic">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => {
            if (typeof href === 'string' && href.startsWith('citation:')) {
              const rest = href.slice('citation:'.length);
              // Off-spec hash form (citation:hash:HEX). Try partial-prefix
              // match against source_id / entity_id; render pill if matched,
              // render nothing if not (don't leak the raw hex to the user).
              if (rest.startsWith('hash:')) {
                const hash = rest.slice('hash:'.length);
                const matched = findSourceByHashPrefix(hash, sources || []);
                if (matched) {
                  return <CitationPill sourceId={matched.id} source={matched} onClick={onCitationClick} />;
                }
                if (typeof console !== 'undefined') {
                  console.warn('[citations] dropping unmatched hash citation', hash);
                }
                return <></>;
              }
              const id = parseInt(rest, 10);
              if (!Number.isNaN(id)) {
                return <CitationPill sourceId={id} source={sourceMap.get(id)} onClick={onCitationClick} />;
              }
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer"
                className="text-accent-magenta hover:underline">
                {children}
              </a>
            );
          },
          strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children, ...props }) => {
            const isBlock = className?.includes('language-') || className?.includes('hljs');
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code className="px-1.5 py-0.5 rounded bg-bg-surface text-accent-magenta text-[13px] font-mono" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => {
            const child = React.Children.toArray(children)[0] as React.ReactElement;
            if (child?.props?.className?.includes('language-') || child?.props?.className?.includes('hljs')) {
              return <>{children}</>;
            }
            return (
              <CodeBlock>{(child as any)?.props?.children || children}</CodeBlock>
            );
          },
          table: ({ children }) => (
            <div className="overflow-x-auto my-3 rounded-lg border border-border">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-bg-surface">{children}</thead>,
          th: ({ children }) => (
            <th className="px-3 py-2 text-left text-[11px] font-semibold text-text-muted uppercase tracking-wider border-b border-border" style={BODY_STYLE}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 border-b border-border/50 text-text-secondary" style={BODY_STYLE}>{children}</td>
          ),
          tr: ({ children }) => <tr className="hover:bg-bg-surface/50">{children}</tr>,
          hr: () => <hr className="my-4 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
