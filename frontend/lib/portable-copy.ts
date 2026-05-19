'use client';

import type React from 'react';

type PortableClipboardPayload = {
  text: string;
  html?: string;
};

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'HEADER', 'HR', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION', 'TABLE',
]);

const COPY_ROOT_SELECTOR = '[data-marty-copy-root="true"]';

export async function writePortableClipboard(payload: PortableClipboardPayload): Promise<void> {
  const text = normalizePlainText(payload.text);
  const html = payload.html?.trim();

  if (
    html
    && typeof ClipboardItem !== 'undefined'
    && navigator.clipboard
    && typeof navigator.clipboard.write === 'function'
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      // Fall through to the broadest-supported clipboard API.
    }
  }

  await navigator.clipboard.writeText(text);
}

export async function copyElementAsPortableContent(root: HTMLElement, fallbackText: string): Promise<void> {
  const { html, text } = portableContentFromElement(root, fallbackText);
  await writePortableClipboard({ text, html });
}

export function copySelectionAsPortableContent(
  event: React.ClipboardEvent<HTMLElement> | ClipboardEvent,
  scope: HTMLElement
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (!selectionTouchesMartyCopyRoot(selection, scope)) return false;

  const fragmentHost = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i += 1) {
    fragmentHost.appendChild(selection.getRangeAt(i).cloneContents());
  }

  sanitizePortableFragment(fragmentHost);
  const html = wrapPortableHtml(fragmentHost.innerHTML);
  const text = normalizePlainText(textFromPortableNode(fragmentHost) || selection.toString());
  const clipboardData = 'clipboardData' in event ? event.clipboardData : null;
  if (!clipboardData) return false;

  clipboardData.setData('text/plain', text);
  clipboardData.setData('text/html', html);
  event.preventDefault();
  return true;
}

export function textToPortableHtml(text: string): string {
  const paragraphs = normalizePlainText(text)
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return '';

  return wrapPortableHtml(
    paragraphs
      .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
      .join('')
  );
}

function portableContentFromElement(root: HTMLElement, fallbackText: string): PortableClipboardPayload {
  const clone = root.cloneNode(true) as HTMLElement;
  sanitizePortableFragment(clone);
  return {
    text: normalizePlainText(textFromPortableNode(clone) || fallbackText),
    html: wrapPortableHtml(clone.innerHTML),
  };
}

function sanitizePortableFragment(root: HTMLElement): void {
  root.querySelectorAll('.toc-container, .response-done-line').forEach(node => node.remove());
  root.querySelectorAll('svg').forEach(node => node.remove());

  root.querySelectorAll('button').forEach(button => {
    const text = normalizeWhitespace(button.textContent || '');
    if (!text) {
      button.remove();
      return;
    }
    const citationText = /^\d+$/.test(text) ? `[${text}]` : text;
    button.replaceWith(document.createTextNode(citationText));
  });

  root.querySelectorAll('*').forEach(node => {
    const element = node as HTMLElement;
    const tag = element.tagName;

    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const keep =
        (tag === 'A' && (name === 'href' || name === 'title')) ||
        ((tag === 'TD' || tag === 'TH') && (name === 'colspan' || name === 'rowspan'));
      if (!keep) element.removeAttribute(attr.name);
    }

    applyPortableInlineStyle(element);
  });
}

function applyPortableInlineStyle(element: HTMLElement): void {
  switch (element.tagName) {
    case 'A':
      element.style.color = '#1155cc';
      element.style.textDecoration = 'underline';
      break;
    case 'BLOCKQUOTE':
      element.style.borderLeft = '3px solid #d0d7de';
      element.style.margin = '12px 0';
      element.style.paddingLeft = '12px';
      break;
    case 'CODE':
      element.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      element.style.background = '#f6f8fa';
      element.style.color = '#24292f';
      element.style.padding = '1px 4px';
      element.style.borderRadius = '4px';
      break;
    case 'PRE':
      element.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      element.style.whiteSpace = 'pre-wrap';
      element.style.background = '#f6f8fa';
      element.style.color = '#24292f';
      element.style.padding = '12px';
      element.style.borderRadius = '6px';
      break;
    case 'TABLE':
      element.style.borderCollapse = 'collapse';
      element.style.width = '100%';
      break;
    case 'TH':
      element.style.border = '1px solid #d0d7de';
      element.style.padding = '4px 8px';
      element.style.textAlign = 'left';
      element.style.fontWeight = '700';
      break;
    case 'TD':
      element.style.border = '1px solid #d0d7de';
      element.style.padding = '4px 8px';
      element.style.textAlign = 'left';
      break;
  }

  if (/^H[1-6]$/.test(element.tagName)) {
    element.style.fontWeight = '700';
    element.style.margin = '16px 0 8px';
  }
}

function selectionTouchesMartyCopyRoot(selection: Selection, scope: HTMLElement): boolean {
  const roots = Array.from(scope.querySelectorAll(COPY_ROOT_SELECTOR));
  if (scope.matches(COPY_ROOT_SELECTOR)) roots.unshift(scope);

  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    for (const root of roots) {
      try {
        if (range.intersectsNode(root)) return true;
      } catch {
        // Some browsers throw for detached nodes; ignore and keep scanning.
      }
    }
  }

  return false;
}

function textFromPortableNode(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';

  const element = node as Element;
  const tag = element.tagName;

  if (tag === 'BR') return '\n';
  if (tag === 'HR') return '\n---\n';
  if (tag === 'PRE') return `\n${element.textContent || ''}\n`;
  if (tag === 'TABLE') return tableToText(element as HTMLTableElement);
  if (tag === 'LI') return listItemToText(element, depth);
  if (tag === 'UL' || tag === 'OL') {
    return Array.from(element.children)
      .map(child => textFromPortableNode(child, depth + 1))
      .join('');
  }

  const text = Array.from(node.childNodes)
    .map(child => textFromPortableNode(child, depth))
    .join('');

  if (BLOCK_TAGS.has(tag)) return `\n${text.trim()}\n`;
  return text;
}

function listItemToText(element: Element, depth: number): string {
  const parent = element.parentElement;
  const ordered = parent?.tagName === 'OL';
  const siblings = parent ? Array.from(parent.children).filter(child => child.tagName === 'LI') : [];
  const index = siblings.indexOf(element) + 1;
  const prefix = ordered ? `${index}. ` : '- ';
  const indent = '  '.repeat(Math.max(0, depth - 1));
  const directText = Array.from(element.childNodes)
    .map(child => textFromPortableNode(child, depth))
    .join('')
    .trim();
  return `${indent}${prefix}${directText}\n`;
}

function tableToText(table: HTMLTableElement): string {
  return `\n${Array.from(table.rows)
    .map(row => Array.from(row.cells).map(cell => normalizeWhitespace(cell.textContent || '')).join('\t'))
    .join('\n')}\n`;
}

function wrapPortableHtml(innerHtml: string): string {
  return `<div style="font-family: Arial, Helvetica, sans-serif; color: inherit; background: transparent; line-height: 1.45;">${innerHtml}</div>`;
}

function normalizePlainText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
