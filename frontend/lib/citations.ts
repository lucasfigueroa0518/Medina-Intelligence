// Mirrors src/lib/citations.ts on the backend.
export type CitationSourceType =
  | 'email'
  | 'meeting'
  | 'document'
  | 'contact'
  | 'company'
  | 'slack'
  | 'news';

export interface CitationSource {
  id: number;
  type: CitationSourceType;
  source_table: string;
  source_id: string;
  entity_id?: string;
  title: string;
  subtitle?: string;
  date?: string;
  url_path: string;
  external_url?: string;
}

// Tokenized form for non-markdown rendering paths (footer, plain-text fallback).
export interface MessageToken {
  type: 'text' | 'citation';
  content?: string;
  sourceId?: number;
}

export function parseMessageWithCitations(message: string): MessageToken[] {
  const tokens: MessageToken[] = [];
  const regex = /\[\^(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(message)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', content: message.slice(lastIndex, match.index) });
    }
    tokens.push({ type: 'citation', sourceId: parseInt(match[1], 10) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < message.length) {
    tokens.push({ type: 'text', content: message.slice(lastIndex) });
  }
  return tokens;
}

// Strip a trailing partial marker like "...ARR[^" or "...ARR[" so the
// streaming renderer doesn't display an in-flight citation as broken text.
// Once the closing bracket arrives, the marker is parsed normally.
export function trimPartialCitation(text: string): string {
  // Trailing "[" or "[^" or "[^123" (no closing ]) — peel it off.
  return text.replace(/\[\^?\d*$/, '');
}

// Remark plugin: rewrites every `[^N]` marker into a `link` node whose URL is
// `citation:N`. The MarkdownMessage component hooks into the `a` renderer and
// recognizes that scheme to render a CitationPill instead of a real link.
//
// remark-gfm's footnote syntax extension runs at the PARSE stage, regardless
// of plugin order — by the time any tree-transformer runs, `[^N]` has already
// been parsed into `footnoteReference` mdast nodes (and any matching `[^N]: …`
// definitions into `footnoteDefinition`s, which GFM otherwise renders as a
// "Footnotes" section at the bottom of the message). To intercept citations,
// the plugin handles BOTH cases:
//   1. `footnoteReference` nodes — rewritten to `link → citation:N` in place.
//   2. text nodes containing literal `[^N]` — split and rewritten the same way
//      (covers the case where remark-gfm isn't loaded, or future markdown
//      renderers without GFM footnote support).
// `footnoteDefinition` nodes are stripped from the tree so the auto-generated
// footnotes section never renders.
export function citationsRemarkPlugin() {
  return function transform(tree: any) {
    walk(tree);
  };
}

function walk(node: any): void {
  if (!node || !Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];

    // Strip GFM's auto-generated footnote definitions — we render citations
    // ourselves via CitationPill + the SourcePanel side panel, so the footnote
    // section at the bottom of the message would be a duplicate.
    if (child?.type === 'footnoteDefinition') {
      node.children.splice(i, 1);
      i -= 1;
      continue;
    }

    // GFM has already parsed `[^N]` into a footnoteReference node. Replace it
    // with a citation link node in place.
    if (child?.type === 'footnoteReference') {
      const idStr = String(child.identifier ?? child.label ?? '');
      const idNum = parseInt(idStr, 10);
      if (!Number.isNaN(idNum)) {
        node.children[i] = {
          type: 'link',
          url: `citation:${idNum}`,
          title: null,
          children: [{ type: 'text', value: String(idNum) }],
        };
      }
      continue;
    }

    // Fallback: GFM not loaded → markers are still in raw text nodes.
    if (child?.type === 'text' && typeof child.value === 'string' && child.value.includes('[^')) {
      const replacements = splitText(child.value);
      if (replacements) {
        node.children.splice(i, 1, ...replacements);
        i += replacements.length - 1;
        continue;
      }
    }

    // Don't recurse into citation:N links — they're already terminal.
    if (child?.type === 'link' && typeof child.url === 'string' && child.url.startsWith('citation:')) {
      continue;
    }
    walk(child);
  }
}

function splitText(value: string): any[] | null {
  const regex = /\[\^(\d+)\]/g;
  const out: any[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push({
      type: 'link',
      url: `citation:${m[1]}`,
      title: null,
      children: [{ type: 'text', value: m[1] }],
    });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}
