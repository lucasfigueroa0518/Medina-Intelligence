import type { Env } from '../types/env';
import { proposeMultipleUpdates } from './progressive-enrichment';

interface ParsedSignature {
  full_name?: string;
  job_title?: string;
  phone?: string;
  linkedin_url?: string;
  twitter_url?: string;
}

const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+/i;
const TWITTER_RE = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[\w]+/i;

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

function extractSignatureBlock(body: string): string | null {
  const lines = body.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '--' || line === '---' || line === '—') {
      return lines.slice(i + 1).join('\n');
    }
  }

  const sigMarkers = [
    /^regards,?\s*$/i,
    /^best,?\s*$/i,
    /^best regards,?\s*$/i,
    /^thanks,?\s*$/i,
    /^thank you,?\s*$/i,
    /^cheers,?\s*$/i,
    /^sincerely,?\s*$/i,
    /^kind regards,?\s*$/i,
    /^warm regards,?\s*$/i,
    /^sent from my/i,
  ];

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const line = lines[i].trim();
    if (sigMarkers.some(r => r.test(line))) {
      return lines.slice(i + 1).join('\n');
    }
  }

  if (lines.length > 6) {
    const tail = lines.slice(-8).join('\n');
    if (PHONE_RE.test(tail) || LINKEDIN_RE.test(tail)) {
      return tail;
    }
  }

  return null;
}

function parseTitleFromPipeLine(line: string, senderName: string): string | null {
  const parts = line.split(/\s*[|·•–—,]\s*/);
  const nameNorm = senderName.toLowerCase().trim();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 120) continue;
    if (trimmed.toLowerCase() === nameNorm) continue;
    if (PHONE_RE.test(trimmed)) continue;
    if (LINKEDIN_RE.test(trimmed)) continue;
    if (TWITTER_RE.test(trimmed)) continue;
    if (trimmed.includes('@') || trimmed.includes('http')) continue;

    const titleKeywords = /\b(vp|ceo|cto|cfo|coo|president|director|manager|head|lead|founder|partner|associate|analyst|engineer|consultant|advisor|officer|chief|senior|junior|principal)\b/i;
    if (titleKeywords.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function parseEmailSignature(body: string, senderDisplayName: string): ParsedSignature {
  const result: ParsedSignature = {};

  const sigBlock = extractSignatureBlock(body);
  if (!sigBlock) return result;

  const lines = sigBlock.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return result;

  const phoneMatch = sigBlock.match(PHONE_RE);
  if (phoneMatch) {
    result.phone = normalizePhone(phoneMatch[0]);
  }

  const linkedinMatch = sigBlock.match(LINKEDIN_RE);
  if (linkedinMatch) {
    let url = linkedinMatch[0];
    if (!url.startsWith('http')) url = `https://${url}`;
    result.linkedin_url = url;
  }

  const twitterMatch = sigBlock.match(TWITTER_RE);
  if (twitterMatch) {
    let url = twitterMatch[0];
    if (!url.startsWith('http')) url = `https://${url}`;
    result.twitter_url = url;
  }

  for (const line of lines) {
    if (line.includes('|') || line.includes('·') || line.includes('•')) {
      const title = parseTitleFromPipeLine(line, senderDisplayName);
      if (title) {
        result.job_title = title;

        const parts = line.split(/\s*[|·•–—]\s*/);
        const nameCandidate = parts[0]?.trim();
        if (nameCandidate && nameCandidate.length >= 3 && nameCandidate.length <= 60) {
          if (!PHONE_RE.test(nameCandidate) && !nameCandidate.includes('@')) {
            const words = nameCandidate.split(/\s+/);
            if (words.length >= 2 && words.every(w => /^[A-Z]/.test(w))) {
              result.full_name = nameCandidate;
            }
          }
        }
        break;
      }
    }
  }

  return result;
}

export async function processEmailSignature(
  contactId: string,
  orgId: string,
  emailBody: string,
  senderDisplayName: string,
  conversationId: string,
  sentAt: string,
  env: Env,
  /** Wave 6: observing user (mailbox owner) for channel attribution.
   *  Same contact's signature observed in user A's vs user B's inbox
   *  counts as two distinct channels in the corroboration model.
   *  Optional during Phase B — callers that don't yet pass it produce
   *  a fallback channel via resolveChannel('unknown'). */
  observerUserId?: string | null
): Promise<void> {
  const parsed = parseEmailSignature(emailBody, senderDisplayName);
  const fields = Object.entries(parsed).filter(([, v]) => v);

  if (fields.length === 0) return;

  const dateStr = sentAt ? new Date(sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'recent';

  const updates = fields.map(([field, value]) => ({
    field,
    value: value!,
    source: 'email_signature' as const,
    confidence: field === 'full_name' ? 0.85 : 0.9,
    source_description: `Email signature from ${senderDisplayName}, ${dateStr}`,
    source_communication_id: conversationId,
    context: { userId: observerUserId, conversationId },
  }));

  const result = await proposeMultipleUpdates(orgId, 'contact', contactId, updates, env);

  if (result.auto_applied.length > 0 || result.proposed.length > 0) {
    console.log(
      `[sig-parser] contact ${contactId}: auto=${result.auto_applied.join(',')}, proposed=${result.proposed.join(',')}, skipped=${result.skipped.join(',')}`
    );
  }
}

export async function processDisplayNameUpdate(
  contactId: string,
  orgId: string,
  displayName: string,
  conversationId: string,
  sentAt: string,
  env: Env,
  /** Wave 6: observing user for channel attribution. See
   *  processEmailSignature note. */
  observerUserId?: string | null
): Promise<void> {
  if (!displayName || displayName.length < 3) return;

  const words = displayName.trim().split(/\s+/);
  if (words.length < 2) return;
  if (!words.every(w => /^[A-Z]/.test(w))) return;

  const current = await env.D1.prepare(
    'SELECT full_name FROM contacts WHERE id = ? AND deleted_at IS NULL'
  ).bind(contactId).first<{ full_name: string }>();

  if (!current) return;

  const currentWords = current.full_name.trim().split(/\s+/).length;
  const newWords = words.length;

  if (newWords <= currentWords) return;
  if (current.full_name.trim().toLowerCase() === displayName.trim().toLowerCase()) return;

  const dateStr = sentAt ? new Date(sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'recent';

  await proposeMultipleUpdates(orgId, 'contact', contactId, [{
    field: 'full_name',
    value: displayName.trim(),
    source: 'display_name',
    confidence: 0.85,
    source_description: `Email display name, ${dateStr}`,
    source_communication_id: conversationId,
    context: { userId: observerUserId, conversationId },
  }], env);
}
