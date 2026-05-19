const FRIENDLY_TEXT_KEYS = [
  'full_bio',
  'brief_summary',
  'briefing',
  'bio_summary',
  'bio',
  'summary',
  'overview',
  'description',
  'profile',
  'narrative',
  'response',
  'answer',
  'content',
  'text',
  'value',
];

const INTERNAL_TEXT_KEYS = new Set([
  'analysis',
  'metadata',
  'observation',
  'role',
  'steps',
  'thought',
  'tool_call',
  'tool_calls',
  'tool_code',
  'tool_result',
  'tool_results',
  'tool_response',
]);

export function cleanIntelBrief(raw: string | null | undefined): string {
  if (!raw) return '';
  const candidate = extractFriendlyText(raw, 0);
  if (!candidate) return '';
  return cleanProse(candidate);
}

function extractFriendlyText(value: unknown, depth: number): string {
  if (depth > 5 || value == null) return '';

  if (typeof value === 'string') {
    const parsed = parseJsonish(value);
    if (parsed !== undefined) {
      const extracted = extractFriendlyText(parsed, depth + 1);
      return extracted || (typeof parsed === 'string' ? parsed : '');
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(item => extractFriendlyText(item, depth + 1))
      .filter(Boolean)
      .join('\n\n');
  }

  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of FRIENDLY_TEXT_KEYS) {
    if (record[key] !== undefined) {
      const extracted = extractFriendlyText(record[key], depth + 1);
      if (extracted) return extracted;
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (INTERNAL_TEXT_KEYS.has(normalized)) continue;
    if (/(?:bio|brief|summary|overview|description|profile|narrative|response|answer|content|text|value)/i.test(key)) {
      const extracted = extractFriendlyText(nested, depth + 1);
      if (extracted) return extracted;
    }
  }

  return '';
}

function parseJsonish(text: string): unknown | undefined {
  const trimmed = text
    .trim()
    .replace(/^```(?:json|markdown|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  if (!/^[{["]/.test(trimmed)) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function cleanProse(text: string): string {
  let cleaned = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '')
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, '')
    .replace(/<\/?[a-zA-Z][^>]{0,120}>/g, '')
    .replace(/^```(?:json|markdown|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  if (hasToolTranscript(cleaned)) {
    const finalSection = extractFinalSection(cleaned);
    if (!finalSection) return '';
    cleaned = finalSection.trim();
  }

  const preamblePatterns = [
    /^[\s\S]*?I'll research[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?Let me (start|begin)[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?I've (now )?gathered[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?I now have (enough|sufficient)[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?Here is the (polished |thorough |comprehensive |detailed )?(professional )?(bio|briefing|summary)[^\n:]*[:\n]\s*/i,
    /^[\s\S]*?Here it is[^\n:]*[:\n]\s*/i,
    /^[\s\S]*?Here's (the|a) (polished |thorough |comprehensive |detailed )?(professional )?(bio|briefing|summary)[^\n:]*[:\n]\s*/i,
  ];

  for (const pattern of preamblePatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined && match.index + match[0].length < 600) {
      cleaned = cleaned.slice(match.index + match[0].length);
    }
  }

  cleaned = cleaned
    .replace(/^\s*\[(?:source|sources?)\s*:\s*[^\]]+\]\s*/gim, '')
    .replace(/\s*\[(?:source|sources?)\s*:\s*[^\]]+\]\s*/gi, ' ')
    .replace(/^\s*(?:source|sources?)\s*:\s*(?:gemini|claude|web_search|reversecontact)[^\n]*\n?/gim, '')
    .replace(/^[\s\S]{0,400}?---+\s*\n/, '')
    .replace(/^\s*-{3,}\s*\n?/, '')
    .replace(/\n?\s*-{3,}\s*$/, '')
    .replace(/\n*-{3,}\s*\n\s*Grounded sources:[\s\S]*$/i, '')
    .replace(/\n*Grounded sources:\s*\n[\s\S]*$/i, '');

  cleaned = cleaned
    .split(/\n{2,}/)
    .map(paragraph => paragraph.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');

  if (!cleaned || hasToolTranscript(cleaned) || looksLikeRawJsonOrCode(cleaned)) return '';
  return cleaned;
}

function hasToolTranscript(text: string): boolean {
  return (
    /(^|\n)\s*(?:tool_code|tool_call|tool_calls|tool_result|tool_response|thought|analysis|observation)\s*:?\s*(?:\n|$)/i.test(text) ||
    /\b(?:google_search|web_search)\.(?:search|run)\b/i.test(text) ||
    /(^|\n)\s*print\s*\(/i.test(text) ||
    /"(?:tool_code|tool_call|tool_calls|tool_result|tool_response|thought|analysis)"\s*:/i.test(text)
  );
}

function extractFinalSection(text: string): string | null {
  const match = text.match(/(?:^|\n)\s*(?:final|answer|briefing|summary|response)\s*:?\s*\n([\s\S]+)$/i);
  return match?.[1] ?? null;
}

function looksLikeRawJsonOrCode(text: string): boolean {
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed)) return true;
  if ((trimmed.match(/"[^"\n]+"\s*:/g)?.length ?? 0) >= 2) return true;
  return /```|<\/?tool_|(^|\n)\s*(?:const|let|var|function)\s+\w+|(^|\n)\s*print\s*\(|\bgoogle_search\.search\b/i.test(trimmed);
}
