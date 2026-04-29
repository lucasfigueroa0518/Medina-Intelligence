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

  // Display-only fields populated by buildSourcesAndContext for the side
  // panel — not part of the prompt sent to Claude.
  excerpt?: string;
  entity_name?: string;
  entity_url_path?: string;
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

    // GFM has already parsed `[^X]` into a footnoteReference node. Two valid
    // identifier shapes:
    //   • Small positive integer (1–999) — the canonical [^N] format Claude
    //     is instructed to emit. Matches a source by numeric index.
    //   • 6+ hex chars — off-spec but observed in production when Claude
    //     occasionally cites raw UUID fragments. Defer to the link renderer
    //     for partial-prefix lookup against source_id / entity_id; if no
    //     match found, render as empty (don't leak raw IDs to the user).
    // Anything else: strip silently.
    //
    // Earlier versions used `parseInt(idStr, 10)` which silently returns 50
    // for "50af6179" (parseInt stops at first non-digit) — that produced a
    // misleading citation pill linking to source 50. Strict regex check now.
    if (child?.type === 'footnoteReference') {
      const idStr = String(child.identifier ?? child.label ?? '');
      if (/^\d+$/.test(idStr)) {
        const idNum = parseInt(idStr, 10);
        if (idNum > 0 && idNum < 1000) {
          node.children[i] = {
            type: 'link',
            url: `citation:${idNum}`,
            title: null,
            children: [{ type: 'text', value: String(idNum) }],
          };
          continue;
        }
      }
      if (/^[a-f0-9]{6,}$/i.test(idStr)) {
        node.children[i] = {
          type: 'link',
          url: `citation:hash:${idStr.toLowerCase()}`,
          title: null,
          children: [{ type: 'text', value: idStr }],
        };
        continue;
      }
      // Unknown identifier shape — strip silently rather than leak the
      // <sup><a href="#user-content-fn-..."> footnote default render.
      node.children.splice(i, 1);
      i -= 1;
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
  // Match either the canonical [^N] (small int) or [^HEX] off-spec format.
  // Same disposition as the footnoteReference branch above: numeric → pill,
  // hex → defer to link renderer, anything else won't match this regex at all
  // (so it stays as plain text).
  const regex = /\[\^(\d+|[a-f0-9]{6,})\]/gi;
  const out: any[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    const tok = m[1];
    const url = /^\d+$/.test(tok) ? `citation:${tok}` : `citation:hash:${tok.toLowerCase()}`;
    out.push({
      type: 'link',
      url,
      title: null,
      children: [{ type: 'text', value: tok }],
    });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

// Find a CitationSource whose source_id or entity_id starts with `hash`
// (UUID prefix lookup). Used by the link renderer when the marker was an
// off-spec hex identifier rather than a numeric index.
export function findSourceByHashPrefix(
  hash: string,
  sources: CitationSource[]
): CitationSource | undefined {
  const needle = hash.toLowerCase();
  for (const s of sources) {
    const sid = (s.source_id || '').replace(/-/g, '').toLowerCase();
    if (sid.startsWith(needle)) return s;
    const eid = (s.entity_id || '').replace(/-/g, '').toLowerCase();
    if (eid && eid.startsWith(needle)) return s;
  }
  return undefined;
}
