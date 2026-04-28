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

// Remark plugin: walks the mdast tree, splits text nodes around `[^N]` matches,
// and rewrites each marker as a `link` node whose URL is `citation:N`. The
// MarkdownMessage component hooks into the `a` renderer and recognizes that
// scheme to render a CitationPill instead of a real link.
//
// Runs before remark-gfm so GFM's footnote-reference parsing never sees the
// markers; this avoids them being lifted into a footnote definitions list.
export function citationsRemarkPlugin() {
  return function transform(tree: any) {
    walk(tree);
  };
}

function walk(node: any): void {
  if (!node || !Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child?.type === 'text' && typeof child.value === 'string' && child.value.includes('[^')) {
      const replacements = splitText(child.value);
      if (replacements) {
        node.children.splice(i, 1, ...replacements);
        i += replacements.length - 1; // skip past the freshly inserted leaf nodes
        continue;
      }
    }
    // Don't recurse into link children — citation:N links are already terminal.
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
