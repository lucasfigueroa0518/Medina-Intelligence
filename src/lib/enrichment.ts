// TRD §7.7 — Multi-source enrichment pipeline
//
// Redesigned approval flow:
//   1. Run ALL sources (LinkedIn discovery, ReverseContact, Claude web search, Claude extraction)
//   2. Produce ONE unified enrichment report per contact
//   3. Auto-apply everything that fills a NULL field (first-fill = no approval needed)
//   4. Stage ONE approval_queue entry per contact for proposed overwrites
//   5. Store the full report in R2 + embed into Vectorize for RAG

import type { Env } from '../types/env';
import type { EnrichmentSourceContribution, ChunkMetadata } from '../types/interfaces';
import { chunkEmbedAndPersistAll } from './embedding';
import {
  checkClaudeRateLimit,
  checkEnrichmentRateLimit,
  recordEnrichmentRateLimit,
  clearEnrichmentRateLimit,
} from './rate-limit';
import { callClaude } from './claude';
import { callGemini } from './gemini';
import { emitAudit } from './audit';
import { hashShort } from './helpers';
import { GEMINI_ENRICHMENT_PROMPT, buildGeminiEnrichmentUserPrompt } from '../prompts/gemini-enrichment';
import { enrichContactFromLinkedIn } from '../integrations/reversecontact';
import { discoverLinkedInUrl, assessLinkedInUrlAuthenticity } from './linkedin-discovery';
import { findCompanyByDomain, findOrCreateCompanyByDomain, PERSONAL_DOMAINS } from './discovery';
import { proposeEntityUpdate, proposeMultipleUpdates } from './progressive-enrichment';
import { jaroWinkler } from './dedup';

// Returns true if two company names plausibly refer to the same entity:
// exact match, high Jaro-Winkler similarity (catches typos/spellings), or
// any non-trivial token in common (catches "Pagsa" vs "Grupo Pagsa").
function isSameCompany(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (jaroWinkler(x, y) >= 0.75) return true;
  const tokenize = (s: string) =>
    new Set(s.split(/[\s,.\-_/]+/).filter(w => w.length >= 4));
  const tx = tokenize(x);
  const ty = tokenize(y);
  for (const t of tx) if (ty.has(t)) return true;
  return false;
}

// Check for optional circuit breaker — if the module doesn't exist, skip gracefully.
let isRcCircuitOpen: ((orgId: string, env: Env) => Promise<boolean>) | null = null;
try {
  // Dynamic import at module level won't work in Workers — use a try/catch around
  // a synchronous require-style approach. If the file doesn't exist the enrichment
  // pipeline still runs (just without the circuit breaker).
  const mod = require('./rc-circuit-breaker');
  isRcCircuitOpen = mod.isRcCircuitOpen;
} catch {
  // rc-circuit-breaker.ts doesn't exist yet — that's fine, skip it.
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Strip Claude's internal <tool_call>/<tool_response> XML blocks from web search output. */
function stripToolArtifacts(text: string): string {
  let t = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '')
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, '')
    // Remove any other XML-ish tags like </s>, <s>, <thinking>, <search>, etc.
    .replace(/<\/?[a-zA-Z][^>]{0,120}>/g, '');

  // Strip known preamble phrases when they appear at the start of a line/paragraph,
  // up to the next sentence end or newline.
  const preamblePatterns = [
    /^[\s\S]*?I'll research[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?Let me (start|begin)[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?I've (now )?gathered[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?I now have (enough|sufficient)[^\n.]*[.!\n]\s*/i,
    /^[\s\S]*?Here is the (polished |thorough |comprehensive |detailed )?(professional )?bio[^\n:]*[:\n]\s*/i,
    /^[\s\S]*?Here it is[^\n:]*[:\n]\s*/i,
    /^[\s\S]*?Here's (the|a) (polished |thorough |comprehensive |detailed )?(professional )?bio[^\n:]*[:\n]\s*/i,
  ];
  for (const pat of preamblePatterns) {
    const m = t.match(pat);
    // Only strip if the match is within the first 600 chars — avoid gutting the body.
    if (m && m.index !== undefined && m.index + m[0].length < 600) {
      t = t.slice(m.index + m[0].length);
    }
  }

  // If the text still begins with a "---" divider (sometimes preceded by whitespace),
  // strip everything up to and including it so the bio starts clean.
  const dividerMatch = t.match(/^[\s\S]{0,400}?---+\s*\n/);
  if (dividerMatch) t = t.slice(dividerMatch[0].length);

  // Remove leading/trailing "---" separators.
  t = t.replace(/^\s*-{3,}\s*\n?/, '').replace(/\n?\s*-{3,}\s*$/, '');

  // Strip any trailing "Grounded sources:" bibliography block.
  t = t.replace(/\n*-{3,}\s*\n\s*Grounded sources:[\s\S]*$/i, '');
  t = t.replace(/\n*Grounded sources:\s*\n[\s\S]*$/i, '');

  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Short bio for D1 (≤500 chars, sentence-boundary truncation). */
function buildShortBio(text: string, maxChars = 500): string {
  const cleaned = stripToolArtifacts(text)
    .replace(/\*{2,}(.*?)\*{2,}/g, '$1')
    .replace(/^#+\s+.+\n/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxChars) return cleaned;

  const truncated = cleaned.slice(0, maxChars);
  const lastSentence = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastSentence > maxChars * 0.5) return truncated.slice(0, lastSentence + 1).trim();
  return truncated.trim() + '…';
}

function normalizeLinkedInUrl(raw: string): string | null {
  const m = raw.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%.]+?)(?:[\/?#]|$)/i);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1].replace(/\/+$/, '')}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Structured field extraction (single Claude call → JSON)
// ────────────────────────────────────────────────────────────────────────────

interface ExtractedFields {
  job_title?: string | null;
  company_name?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  topics_of_interest?: string[];
  key_facts?: string[];
}

async function extractFieldsWithClaude(
  bioText: string,
  orgId: string,
  env: Env
): Promise<ExtractedFields> {
  const cleanBio = stripToolArtifacts(bioText);
  if (cleanBio.length < 50) return {};

  try {
    const response = await callClaude(
      {
        system: `You extract structured data from professional bios. Return ONLY valid JSON, no markdown, no code fences. Use null for unknown fields. Arrays should be empty if nothing applies.`,
        user: `Extract structured data from this bio. Return ONLY valid JSON:\n{"job_title":"...","company_name":"...","linkedin_url":"...","twitter_url":"...","topics_of_interest":["..."],"key_facts":["..."]}\n\nBio:\n${cleanBio}`,
        max_tokens: 800,
        orgId,
      },
      'low',
      env
    );

    const cleaned = response.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(cleaned) as ExtractedFields;
  } catch (e: any) {
    console.error(`[enrichment] field-extraction failed: ${e?.message}`);
    return {};
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Unified enrichment report
// ────────────────────────────────────────────────────────────────────────────

interface EnrichmentReport {
  bio: string;
  fields: Record<string, string | string[]>;
  auto_applied: Record<string, string | string[]>;
  proposed_changes: Record<string, { current: string | null; proposed: string | string[] }>;
  sources: string[];
  linkedin_url_discovered?: string;
}

/**
 * Builds ONE unified enrichment report from all sources, applies NULL-fill
 * fields directly, and stages a single approval_queue entry for overwrites.
 */
async function applyUnifiedEnrichment(
  contactId: string,
  fullBioText: string,
  r2Key: string,
  discoveredLinkedinUrl: string | null,
  orgId: string,
  sources: string[],
  env: Env
): Promise<void> {
  // ── 1. Clean the bio ──
  const cleanBio = stripToolArtifacts(fullBioText);
  const shortBio = buildShortBio(fullBioText);
  console.log(`[enrichment] ${contactId}: clean bio ${cleanBio.length} chars, short bio ${shortBio.length} chars`);

  // ── 2. Extract structured fields via Claude ──
  const extracted = await extractFieldsWithClaude(fullBioText, orgId, env);
  console.log(`[enrichment] ${contactId}: extracted fields: ${JSON.stringify(extracted).slice(0, 300)}`);

  // ── 3. Load existing contact row ──
  const existing = await env.D1.prepare(
    `SELECT full_name, bio_summary, job_title, linkedin_url, twitter_url, topics_of_interest, custom_fields
     FROM contacts WHERE id = ?`
  ).bind(contactId).first<{
    full_name: string | null;
    bio_summary: string | null;
    job_title: string | null;
    linkedin_url: string | null;
    twitter_url: string | null;
    topics_of_interest: string | null;
    custom_fields: string | null;
  }>();

  // ── 4. Build the unified field map from ALL sources ──
  // LinkedIn discovery URL takes precedence over extraction-parsed URL
  const resolvedFields: Record<string, string> = {};

  if (discoveredLinkedinUrl) {
    resolvedFields.linkedin_url = discoveredLinkedinUrl;
  } else if (extracted.linkedin_url) {
    const norm = normalizeLinkedInUrl(extracted.linkedin_url);
    if (norm) {
      const auth = assessLinkedInUrlAuthenticity(norm, existing?.full_name || undefined);
      if (auth.likelyFabricated) {
        console.log(`[enrichment] ${contactId}: Claude-extracted LinkedIn URL "${norm}" looks fabricated (${auth.reason}) — skipping`);
      } else {
        resolvedFields.linkedin_url = norm;
      }
    }
  }

  if (extracted.job_title) {
    let title = String(extracted.job_title).trim();
    title = title.replace(/^the\s+/i, '');
    if (title.length >= 2 && title.length <= 120) {
      resolvedFields.job_title = title;
    }
  }

  if (extracted.twitter_url) resolvedFields.twitter_url = String(extracted.twitter_url).trim();

  if (Array.isArray(extracted.topics_of_interest) && extracted.topics_of_interest.length > 0) {
    const topics = extracted.topics_of_interest
      .map(s => String(s).trim())
      .filter(s => s.length >= 2 && s.length <= 80)
      .slice(0, 15);
    if (topics.length > 0) resolvedFields.topics_of_interest = JSON.stringify(topics);
  }

  // ── 5. Classify each field: auto_applied vs proposed_change ──
  const autoApplied: Record<string, string> = {};
  const proposedChanges: Record<string, { current: string | null; proposed: string }> = {};

  const dbUpdates: string[] = ['bio_summary = ?', 'web_enrichment_r2_key = ?'];
  const dbBinds: unknown[] = [shortBio, r2Key];

  for (const [field, value] of Object.entries(resolvedFields)) {
    const currentVal = (existing as any)?.[field] as string | null | undefined;
    const current = currentVal == null || currentVal === '' ? null : String(currentVal).trim();

    if (current === null) {
      // NULL → first fill: auto-apply, no approval needed
      dbUpdates.push(`${field} = ?`);
      dbBinds.push(value);
      autoApplied[field] = value;
      console.log(`[enrichment] ${contactId}: auto-apply ${field} = "${String(value).slice(0, 60)}"`);
    } else if (current.toLowerCase() === String(value).trim().toLowerCase()) {
      // Same value: skip
      console.log(`[enrichment] ${contactId}: ${field} already matches — skip`);
    } else {
      // Different value: propose overwrite
      proposedChanges[field] = { current, proposed: value };
      console.log(`[enrichment] ${contactId}: propose ${field}: "${current.slice(0, 40)}" → "${String(value).slice(0, 40)}"`);
    }
  }

  // Reconcile the contact's company assignment with the bio.
  // Email-domain auto-linking (the default) can attach a contact to the wrong
  // real-world employer (side domains, family business, vendor, personal mailbox
  // at a related entity). When the bio names a different company, queue a
  // human approval rather than silently keeping the wrong link.
  if (extracted.company_name && typeof extracted.company_name === 'string') {
    const proposedName = String(extracted.company_name).trim();
    if (proposedName.length >= 2) {
      const link = await env.D1.prepare(
        'SELECT company_id FROM contacts WHERE id = ?'
      ).bind(contactId).first<{ company_id: string | null }>();

      if (!link?.company_id) {
        const matchedCompany = await env.D1.prepare(
          'SELECT id FROM companies WHERE org_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1'
        ).bind(orgId, proposedName).first<{ id: string }>();
        if (matchedCompany) {
          dbUpdates.push('company_id = ?');
          dbBinds.push(matchedCompany.id);
          autoApplied['company_id'] = matchedCompany.id;
          console.log(`[enrichment] ${contactId}: auto-link to company "${proposedName}" id=${matchedCompany.id}`);
        }
      } else {
        const current = await env.D1.prepare(
          'SELECT name, domain FROM companies WHERE id = ?'
        ).bind(link.company_id).first<{ name: string; domain: string | null }>();

        const matchesName = current && isSameCompany(current.name, proposedName);
        const matchesDomain = current?.domain && isSameCompany(current.domain, proposedName);
        if (current && !matchesName && !matchesDomain) {
          let proposedCompanyId: string | null = null;
          const matched = await env.D1.prepare(
            'SELECT id FROM companies WHERE org_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1'
          ).bind(orgId, proposedName).first<{ id: string }>();

          if (matched) {
            proposedCompanyId = matched.id;
          } else {
            proposedCompanyId = crypto.randomUUID();
            await env.D1.prepare(
              `INSERT INTO companies (id, org_id, name, company_type, created_at, updated_at)
               VALUES (?, ?, ?, 'other', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
            ).bind(proposedCompanyId, orgId, proposedName).run();
            console.log(`[enrichment] ${contactId}: created placeholder company "${proposedName}" id=${proposedCompanyId} for approval`);
          }

          const slug = proposedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
          const idempotencyKey = `${orgId}:${contactId}:company_mismatch:${slug}`;
          const proposedValue = JSON.stringify({
            value: proposedCompanyId,
            context: {
              current_company_id: link.company_id,
              current_company_name: current.name,
              proposed_company_name: proposedName,
              reason: 'email_domain_disagrees_with_bio',
            },
          });

          await env.D1.prepare(
            `INSERT OR IGNORE INTO approval_queue
               (org_id, idempotency_key, entity_type, entity_id, change_type, field_name,
                proposed_value, confidence, status)
             VALUES (?, ?, 'contact', ?, 'update_contact', 'company_id', ?, 0.6, 'pending')`
          ).bind(orgId, idempotencyKey, contactId, proposedValue).run();

          console.log(`[enrichment] ${contactId}: queued company-mismatch approval — current="${current.name}" proposed="${proposedName}"`);
        }
      }
    }
  }

  // key_facts → custom_fields JSON
  let customFields: Record<string, unknown> = {};
  try { customFields = JSON.parse(existing?.custom_fields || '{}'); } catch { customFields = {}; }
  if (Array.isArray(extracted.key_facts) && extracted.key_facts.length > 0) {
    customFields.key_facts = extracted.key_facts.map(s => String(s).trim()).filter(s => s.length >= 2).slice(0, 20);
  }
  dbUpdates.push('custom_fields = ?');
  dbBinds.push(JSON.stringify(customFields));

  dbUpdates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

  // ── 6. Write auto-applied fields to D1 ──
  await env.D1.prepare(
    `UPDATE contacts SET ${dbUpdates.join(', ')} WHERE id = ?`
  ).bind(...dbBinds, contactId).run();

  console.log(
    `[enrichment] ${contactId}: auto-applied ${Object.keys(autoApplied).length} fields, ` +
    `${Object.keys(proposedChanges).length} proposed changes`
  );

  // ── 7. Build the unified enrichment report ──
  const report: EnrichmentReport = {
    bio: cleanBio,
    fields: { ...autoApplied },
    auto_applied: autoApplied,
    proposed_changes: proposedChanges,
    sources,
    linkedin_url_discovered: discoveredLinkedinUrl || undefined,
  };

  // ── 8. Stage individual progressive_update entries for proposed overwrites ──
  if (Object.keys(proposedChanges).length > 0) {
    for (const [field, change] of Object.entries(proposedChanges)) {
      await proposeEntityUpdate(
        orgId, 'contact', contactId, field, change.proposed,
        'enrichment', 0.85, env,
        { source_description: `Enrichment re-run (sources: ${sources.join(', ')})` }
      );
    }
    console.log(
      `[enrichment] ${contactId}: staged ${Object.keys(proposedChanges).length} progressive updates`
    );
  } else {
    console.log(`[enrichment] ${contactId}: no overwrites — no approval needed`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export function aggregateEnrichmentResult(
  contributions: EnrichmentSourceContribution[]
): { text: string; visibility: 'org_wide' | 'confidential' } {
  const text = contributions
    .filter(c => c.text.length > 0)
    .map(c => {
      if (c.source === 'llm_extraction' && c.sanitized_text) {
        return `[Source: ${c.source}]\n${c.sanitized_text}`;
      }
      return `[Source: ${c.source}]\n${c.text}`;
    })
    .join('\n\n');

  const hasRestricted = contributions.some(
    c => c.visibility === 'private' || c.visibility === 'confidential'
  );
  return { text, visibility: hasRestricted ? 'confidential' : 'org_wide' };
}

export async function triggerContactEnrichment(
  contactId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const contact = await env.D1.prepare(
    `SELECT id, full_name, email, linkedin_url, company_id, job_title
     FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<any>();
  if (!contact) {
    console.log(`[enrichment] ${contactId}: not found — skipping`);
    return;
  }

  console.log(
    `[enrichment] ${contactId}: starting for "${contact.full_name}" email=${contact.email || 'none'} linkedin=${contact.linkedin_url || 'none'}`
  );

  const contributions: EnrichmentSourceContribution[] = [];
  let discoveredLinkedinUrl: string | null = null;
  let rcVerifiedUrl = false;

  // ── Circuit breaker gate ──
  const rcOpen = isRcCircuitOpen ? await isRcCircuitOpen(orgId, env) : false;
  if (rcOpen) {
    console.warn(`[enrichment] ${contactId}: ReverseContact circuit open — skipping RC + discovery`);
  }

  // ── Step 0: LinkedIn URL discovery ──
  // Discovery no longer writes directly to DB — we verify with RC first.
  let skipReverseContact = rcOpen;
  if (!rcOpen && !contact.linkedin_url) {
    console.log(`[enrichment] ${contactId}: no linkedin_url → LinkedIn discovery`);
    try {
      const discovery = await discoverLinkedInUrl(contact, orgId, env);
      console.log(`[enrichment] ${contactId}: discovery → ${discovery.status} url=${discovery.linkedin_url || 'none'}`);
      if (discovery.status === 'found' && discovery.linkedin_url) {
        contact.linkedin_url = discovery.linkedin_url;
        discoveredLinkedinUrl = discovery.linkedin_url;
        contributions.push({
          source: 'claude_web_search',
          text: `LinkedIn profile discovered: ${discovery.linkedin_url}`,
          visibility: 'org_wide',
        });
      } else if (discovery.status === 'multiple') {
        skipReverseContact = true;
      }
    } catch (e) {
      console.error(`[enrichment] ${contactId}: discovery error:`, e);
    }
  }

  // ── Source 1: ReverseContact ──
  if (!skipReverseContact) {
    const claudeOk = await checkClaudeRateLimit(env, orgId, 'low');
    const rcOk = await checkEnrichmentRateLimit('reversecontact', orgId, env);
    if (claudeOk && rcOk) {
      try {
        const result = await enrichContactFromLinkedIn(contact, orgId, env);
        if (result) {
          rcVerifiedUrl = true;
          console.log(`[enrichment] ${contactId}: RC returned ${result.text.length} chars (identity verified)`);
          contributions.push({ source: 'reversecontact', text: result.text, visibility: 'org_wide' });
          await clearEnrichmentRateLimit('reversecontact', orgId, env);
        }
      } catch (e: any) {
        console.error(`[enrichment] ${contactId}: RC failed: ${e.message}`);
        if (String(e.message).includes('429')) await recordEnrichmentRateLimit('reversecontact', orgId, env);
        if (String(e.message).includes('LINKEDIN_IDENTITY_UNVERIFIED') && discoveredLinkedinUrl) {
          console.log(`[enrichment] ${contactId}: RC identity unverified — discarding discovered URL "${discoveredLinkedinUrl}"`);
          contact.linkedin_url = null;
          discoveredLinkedinUrl = null;
        }
      }
    }
  }

  // ── Persist discovered URL based on verification ──
  if (discoveredLinkedinUrl) {
    if (rcVerifiedUrl) {
      await env.D1.prepare(
        `UPDATE contacts SET linkedin_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(discoveredLinkedinUrl, contactId).run();
      console.log(`[enrichment] ${contactId}: discovered URL verified by RC — persisted to DB`);
    } else {
      const auth = assessLinkedInUrlAuthenticity(discoveredLinkedinUrl, contact.full_name);
      if (auth.likelyFabricated) {
        console.log(`[enrichment] ${contactId}: discovered URL not RC-verified AND looks fabricated (${auth.reason}) — discarding`);
        contact.linkedin_url = null;
        discoveredLinkedinUrl = null;
      } else {
        await env.D1.prepare(
          `UPDATE contacts SET linkedin_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        ).bind(discoveredLinkedinUrl, contactId).run();
        console.log(`[enrichment] ${contactId}: discovered URL not RC-verified but passes authenticity check (${auth.reason}) — persisted`);
      }
    }
  }

  // ── Source 2: Gemini web search (grounded) ──
  if (await checkEnrichmentRateLimit('gemini_enrichment', orgId, env)) {
    try {
      const company = contact.company_id
        ? await env.D1.prepare('SELECT name, sector, website FROM companies WHERE id = ?')
            .bind(contact.company_id).first<any>()
        : null;

      // Feed any RC payload we gathered above into Gemini so it can merge
      // verified LinkedIn data with live web findings in a single dossier.
      const rcContrib = contributions.find(c => c.source === 'reversecontact');

      const { text, sources } = await callGemini(
        {
          system: GEMINI_ENRICHMENT_PROMPT,
          user: buildGeminiEnrichmentUserPrompt({
            entityName: contact.full_name,
            entityType: 'contact',
            sector: company?.sector,
            emailDomain: contact.email ? contact.email.split('@')[1] : undefined,
            knownContacts: company ? [company.name] : [],
            jobTitle: contact.job_title || undefined,
            reverseContactPayload: rcContrib?.text,
          }),
          max_tokens: 5000,
          orgId,
        },
        'low',
        env
      );

      console.log(`[enrichment] ${contactId}: Gemini web search → ${text.length} chars, ${sources.length} sources`);
      contributions.push({
        source: 'gemini_web_search',
        text: text,
        visibility: 'org_wide',
      });
      await clearEnrichmentRateLimit('gemini_enrichment', orgId, env);
    } catch (e: any) {
      console.error(`[enrichment] ${contactId}: Gemini failed: ${e.message}`);
      if (String(e.message).includes('GEMINI_RATE_LIMITED')) {
        await recordEnrichmentRateLimit('gemini_enrichment', orgId, env);
      }
    }
  }

  console.log(`[enrichment] ${contactId}: ${contributions.length} contributions from [${contributions.map(c => c.source).join(', ')}]`);
  if (contributions.length === 0) return;

  // ── Aggregate for Vectorize ──
  const { text: aggText, visibility } = aggregateEnrichmentResult(contributions);

  // ── Pick the best bio text (longest web search contribution) ──
  const bestBio = contributions
    .filter(c => (c.source === 'gemini_web_search' || c.source === 'claude_web_search') && c.text.length > 200)
    .sort((a, b) => b.text.length - a.text.length)[0]?.text || aggText;

  // ── R2: full enrichment payload ──
  const r2Key = `${orgId}/enrichment/aggregated/${contactId}.json`;
  await env.R2.put(r2Key, JSON.stringify({
    full_bio: stripToolArtifacts(bestBio),
    visibility,
    updated_at: new Date().toISOString(),
    contributions,
  }));

  // ── Vectorize embed ──
  const meta: ChunkMetadata = {
    org_id: orgId,
    document_type: 'enrichment',
    source_table: 'contacts',
    source_id: contactId,
    r2_key: r2Key,
    visibility,
    primary_entity_id: contactId,
    created_at: new Date().toISOString(),
    entity_name: contact.full_name,
  };

  const entries = await chunkEmbedAndPersistAll(aggText, meta, env);
  if (entries.length > 0) {
    await env.D1.batch(entries.map(e =>
      env.D1.prepare('INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)')
        .bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
    ));
  }

  // ── Unified enrichment report: auto-apply NULLs, stage overwrites ──
  try {
    await applyUnifiedEnrichment(contactId, bestBio, r2Key, discoveredLinkedinUrl, orgId, contributions.map(c => c.source), env);
  } catch (e) {
    console.error(`[enrichment] ${contactId}: applyUnifiedEnrichment failed:`, e);
  }

  // ── Auto-link contact to company if not already linked ──
  if (!contact.company_id && contact.email) {
    try {
      const emailDomain = contact.email.split('@')[1]?.toLowerCase();
      if (emailDomain && !PERSONAL_DOMAINS.has(emailDomain)) {
        const companyId = await findOrCreateCompanyByDomain(emailDomain, orgId, env);
        if (companyId) {
          await env.D1.prepare(
            `UPDATE contacts SET company_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ? AND company_id IS NULL`
          ).bind(companyId, contactId).run();
          console.log(`[enrichment] ${contactId}: auto-linked to company ${companyId} via email domain ${emailDomain}`);
        }
      }
    } catch (e) {
      console.error(`[enrichment] ${contactId}: company auto-link failed:`, e);
    }
  }

  // ── Update enrichment metadata ──
  await env.D1.prepare(
    `UPDATE contacts SET enrichment_confidence = ?, enrichment_last_run = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(Math.min(0.95, 0.4 + contributions.length * 0.25), contactId).run();

  await emitAudit(env, {
    org_id: orgId,
    action: 'enrich',
    entity_type: 'contact',
    entity_id: contactId,
    metadata: { sources: contributions.map(c => c.source), visibility },
    created_at: new Date().toISOString(),
  });
}

export async function triggerCompanyEnrichment(
  companyId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const company = await env.D1.prepare(
    `SELECT id, name, sector, website, domain FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
  ).bind(companyId, orgId).first<any>();
  if (!company) return;

  const contributions: EnrichmentSourceContribution[] = [];

  // Fetch recent news for context in enrichment prompt
  let recentNewsContext = '';
  try {
    const recentNews = await env.D1.prepare(
      `SELECT title, summary, relevance_tag, published_at FROM news_articles
       WHERE company_id = ? AND org_id = ?
       ORDER BY published_at DESC LIMIT 5`
    ).bind(companyId, orgId).all<{
      title: string; summary: string | null; relevance_tag: string; published_at: string | null;
    }>();

    if (recentNews.results.length > 0) {
      recentNewsContext = '\n\nRecent news in this company\'s space:\n' +
        recentNews.results.map(n =>
          `- [${n.relevance_tag}] ${n.title} (${n.published_at || 'recent'}): ${n.summary || ''}`
        ).join('\n');
    }
  } catch { /* news fetch is optional */ }

  if (await checkEnrichmentRateLimit('gemini_enrichment', orgId, env)) {
    try {
      const contactsRow = await env.D1.prepare(
        'SELECT full_name, job_title, email FROM contacts WHERE company_id = ? AND deleted_at IS NULL LIMIT 5'
      ).bind(companyId).all<{ full_name: string; job_title: string | null; email: string | null }>();

      const emailDomain = company.website
        ? company.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
        : contactsRow.results[0]?.email?.split('@')[1] || undefined;

      const contactAnchors = contactsRow.results.map(c => {
        let s = c.full_name;
        if (c.job_title) s += ` (${c.job_title})`;
        return s;
      });

      const enrichmentPromptText = buildGeminiEnrichmentUserPrompt({
        entityName: company.name,
        entityType: 'company',
        sector: company.sector,
        emailDomain,
        knownContacts: contactAnchors,
      }) + recentNewsContext;

      const { text, sources } = await callGemini(
        {
          system: GEMINI_ENRICHMENT_PROMPT,
          user: enrichmentPromptText,
          max_tokens: 5000,
          orgId,
        },
        'low',
        env
      );

      contributions.push({
        source: 'gemini_web_search',
        text: text,
        visibility: 'org_wide',
      });
      await clearEnrichmentRateLimit('gemini_enrichment', orgId, env);
    } catch (e: any) {
      if (String(e.message).includes('GEMINI_RATE_LIMITED')) {
        await recordEnrichmentRateLimit('gemini_enrichment', orgId, env);
      }
      console.error('Company enrichment failed:', e);
    }
  }

  // Website title fallback runs even when Gemini is rate-limited (no contributions).
  if (contributions.length === 0 && isDomainShapedName(company.name, company.domain, company.website) && company.domain) {
    const canonical = await extractNameFromWebsite(company.domain);
    if (canonical) {
      console.log(`[enrichment] website title fallback (no briefing): "${canonical}" for ${company.domain}`);
      await resolveCompanyName(companyId, orgId, canonical, env);
    }
    await env.D1.prepare(
      `UPDATE companies SET enrichment_last_run = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(companyId).run();
    return;
  }

  if (contributions.length === 0) return;

  const { text: aggText, visibility } = aggregateEnrichmentResult(contributions);
  const cleanBio = stripToolArtifacts(contributions[0]?.text || aggText);
  const r2Key = `${orgId}/enrichment/aggregated/${companyId}.json`;

  await env.R2.put(r2Key, JSON.stringify({
    full_bio: cleanBio, visibility,
    updated_at: new Date().toISOString(), contributions,
  }));

  const meta: ChunkMetadata = {
    org_id: orgId,
    document_type: 'enrichment',
    source_table: 'companies',
    source_id: companyId,
    r2_key: r2Key,
    visibility,
    primary_entity_id: companyId,
    created_at: new Date().toISOString(),
    entity_name: company.name,
  };

  const entries = await chunkEmbedAndPersistAll(aggText, meta, env);
  if (entries.length > 0) {
    await env.D1.batch(entries.map(e =>
      env.D1.prepare('INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)')
        .bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
    ));
  }

  await env.D1.prepare(
    `UPDATE companies SET enrichment_confidence = ?, enrichment_last_run = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(0.7, companyId).run();

  const facts = await extractCompanyStructuredFacts(cleanBio, env, orgId, contributions.length);
  if (facts.length > 0) {
    await proposeMultipleUpdates(
      orgId, 'company', companyId,
      facts.map(f => ({
        field: f.field,
        value: f.value,
        source: 'web_enrichment_company',
        confidence: f.confidence,
        source_description: `web enrichment (${contributions.length} source(s))`,
      })),
      env,
      { policy: 'auto_if_confident' }
    );
  }

  // Resolve placeholder domain-name into a canonical human-readable name and
  // dedupe against any existing company that already has that name.
  if (isDomainShapedName(company.name, company.domain, company.website)) {
    let canonical = await extractCanonicalCompanyName(cleanBio, env, orgId);
    if (!canonical && company.domain) {
      canonical = await extractNameFromWebsite(company.domain);
      if (canonical) console.log(`[enrichment] website title fallback: "${canonical}" for ${company.domain}`);
    }
    if (canonical) {
      await resolveCompanyName(companyId, orgId, canonical, env);
    }
  }

  await emitAudit(env, {
    org_id: orgId, action: 'enrich', entity_type: 'company', entity_id: companyId,
    metadata: { sources: contributions.map(c => c.source), visibility },
    created_at: new Date().toISOString(),
  });
}

export function isDomainShapedName(
  name: string | null,
  domain: string | null,
  website: string | null
): boolean {
  if (!name) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lower = name.toLowerCase().trim();
  const namePacked = norm(name);

  if (domain) {
    if (lower === domain.toLowerCase()) return true;
    const stem = domain.toLowerCase().split('.')[0];
    if (stem && namePacked === norm(stem)) return true;
  }
  if (website) {
    const host = website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (lower === host) return true;
    const stem = host.split('.')[0];
    if (stem && namePacked === norm(stem)) return true;
  }
  if (/\.[a-z]{2,}(\/|$)/i.test(lower)) return true;
  return false;
}

const MARKETING_PHRASES = /\b(the best|leading|professional|premier|top rated|#1|number one|your |we are|welcome to|solutions for|platform for)\b/i;

function validateCompanyName(raw: string): string | null {
  let name = raw.trim();
  if (name.length < 2) return null;
  if (/^https?:\/\//i.test(name)) return null;
  if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(name)) return null;
  if (name.length > 60) {
    const sepIdx = name.search(/\s+[–—|\-:]\s+/);
    if (sepIdx > 1) name = name.slice(0, sepIdx).trim();
    if (name.length > 60) return null;
  }
  const sepIdx = name.search(/\s+[–—|\-:]\s+/);
  if (sepIdx > 1) {
    const after = name.slice(sepIdx).replace(/^\s+[–—|\-:]\s+/, '');
    if (after.split(/\s+/).length > 3 || MARKETING_PHRASES.test(after)) {
      name = name.slice(0, sepIdx).trim();
    }
  }
  if (MARKETING_PHRASES.test(name)) return null;
  if (name.length < 2) return null;
  return name;
}

async function extractCanonicalCompanyName(
  briefing: string,
  env: Env,
  orgId: string
): Promise<string | null> {
  const system = `You extract the official, human-readable company name from an investor briefing. Return ONLY raw JSON, no markdown, no commentary. Schema:
{"canonical_name": string | null, "confidence": "high" | "medium" | "low"}

Rules:
- canonical_name is the company's branded/legal name as written by the company itself (e.g. "Bain Capital Ventures", not "bain.com").
- If the briefing does not clearly identify the company (bare stub, no real content, only describes people without naming the firm), return {"canonical_name": null, "confidence": "low"}.
- Never return a domain, URL, or hostname as the canonical_name.
- Never return a tagline or marketing slogan as the canonical_name.
- Never invent a name.`;
  const user = `Briefing:\n${briefing.slice(0, 4000)}`;

  let raw: string;
  try {
    raw = await callClaude(
      { system, user, max_tokens: 200, orgId, model: 'claude-haiku-4-5-20251001' },
      'low',
      env
    );
  } catch (e) {
    console.error('[enrichment] canonical name extraction failed:', e);
    return null;
  }

  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.confidence === 'low') return null;
    if (typeof parsed.canonical_name !== 'string') return null;
    return validateCompanyName(parsed.canonical_name);
  } catch {
    console.error('[enrichment] canonical name parse failed:', raw);
    return null;
  }
}

const TITLE_SUFFIXES = /\s*[|\-–—:]\s*(home|homepage|official\s*site|official\s*website|welcome|main|index|landing|default|404|page\s*not\s*found).*$/i;
const GENERIC_TITLES = new Set([
  'home', 'homepage', 'welcome', 'index', 'untitled', '404', 'not found',
  'page not found', 'coming soon', 'under construction', 'website',
]);

async function extractNameFromWebsite(domain: string): Promise<string | null> {
  let html: string;
  try {
    const res = await fetch(`https://${domain}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'MedinaBot/1.0 (company-enrichment)' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const candidates: string[] = [];

  const ogMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (ogMatch) candidates.push(ogMatch[1]);

  const appMatch = html.match(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']application-name["']/i);
  if (appMatch) candidates.push(appMatch[1]);

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) candidates.push(titleMatch[1]);

  for (const raw of candidates) {
    let name = raw.trim()
      .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—').replace(/&#x2013;/g, '–').replace(/&#x2014;/g, '—')
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
    name = name.replace(TITLE_SUFFIXES, '').trim();
    name = name.replace(/\s*[|\-–—]\s*$/, '').trim();

    if (GENERIC_TITLES.has(name.toLowerCase())) continue;
    if (/^(the|a|an)\s/i.test(name) && name.split(/\s+/).length > 4) continue;
    const valid = validateCompanyName(name);
    if (valid) return valid;
  }
  return null;
}

// Pulls structured field values out of an enrichment briefing so progressive
// enrichment can propose them. Per-field self-reported confidence is mapped
// onto the [0..1] scale; corroboration across multiple contributions bumps to
// 0.95 so the auto-apply path can fire.
export interface ExtractedCompanyFact {
  field: string;
  value: string;
  confidence: number;
}

const COMPANY_FACT_FIELDS = [
  'sector', 'stage', 'website', 'hq_location', 'employee_count',
  'investment_status', 'linkedin_url', 'current_valuation',
  'last_funding_amount', 'last_funding_round', 'last_funding_date',
  'description',
] as const;

export async function extractCompanyStructuredFacts(
  briefing: string,
  env: Env,
  orgId: string,
  contributionCount: number
): Promise<ExtractedCompanyFact[]> {
  const system = `You extract structured company facts from an investor briefing. Return ONLY raw JSON, no markdown, no commentary. Schema:
{
  "sector": {"value": string, "confidence": "high"|"medium"|"low"} | null,
  "stage": {"value": "pre_seed"|"seed"|"series_a"|"series_b"|"series_c"|"growth"|"public"|"acquired"|"other", "confidence": "high"|"medium"|"low"} | null,
  "website": {"value": string, "confidence": "high"|"medium"|"low"} | null,
  "hq_location": {"value": string, "confidence": "high"|"medium"|"low"} | null,
  "employee_count": {"value": number, "confidence": "high"|"medium"|"low"} | null,
  "investment_status": {"value": "tracking"|"prospect"|"due_diligence"|"term_sheet"|"invested"|"passed"|"exited", "confidence": "high"|"medium"|"low"} | null,
  "linkedin_url": {"value": string, "confidence": "high"|"medium"|"low"} | null,
  "current_valuation": {"value": number, "confidence": "high"|"medium"|"low"} | null,
  "last_funding_amount": {"value": number, "confidence": "high"|"medium"|"low"} | null,
  "last_funding_round": {"value": string, "confidence": "high"|"medium"|"low"} | null,
  "last_funding_date": {"value": "YYYY-MM-DD", "confidence": "high"|"medium"|"low"} | null,
  "description": {"value": string, "confidence": "high"|"medium"|"low"} | null
}

Rules:
- Omit (null) any field not clearly stated in the briefing. Never guess.
- "high" = the briefing states the fact directly, with corroborating context.
- "medium" = single source / mild inference.
- "low" = weak inference. Prefer to return null over "low".
- description is a 1-2 sentence company summary, not a full bio.
- Numeric fields must be raw numbers (no currency symbols, no commas, no "$1.2M" — convert to 1200000).
- investment_status reflects only what the briefing implies about *our* relationship; default to omitting.`;
  const user = `Briefing:\n${briefing.slice(0, 6000)}`;

  let raw: string;
  try {
    raw = await callClaude(
      { system, user, max_tokens: 800, orgId, model: 'claude-haiku-4-5-20251001' },
      'low',
      env
    );
  } catch (e) {
    console.error('[enrichment] structured fact extraction failed:', e);
    return [];
  }

  let parsed: Record<string, { value: unknown; confidence: string } | null>;
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('[enrichment] structured fact parse failed:', raw.slice(0, 200));
    return [];
  }

  const corroborationBoost = contributionCount >= 2 ? 0.1 : 0;
  const confMap: Record<string, number> = { high: 0.85, medium: 0.6, low: 0.4 };

  const facts: ExtractedCompanyFact[] = [];
  for (const field of COMPANY_FACT_FIELDS) {
    const f = parsed[field];
    if (!f || f.value === null || f.value === undefined) continue;
    const baseConf = confMap[String(f.confidence).toLowerCase()] ?? 0.4;
    if (baseConf < 0.5) continue;
    const value = typeof f.value === 'number' ? String(f.value) : String(f.value).trim();
    if (!value || value.toLowerCase() === 'null' || value.toLowerCase() === 'unknown') continue;
    facts.push({
      field,
      value,
      confidence: Math.min(0.95, baseConf + corroborationBoost),
    });
  }

  return facts;
}

async function resolveCompanyName(
  companyId: string,
  orgId: string,
  canonicalName: string,
  env: Env
): Promise<void> {
  const dup = await env.D1.prepare(
    `SELECT id FROM companies
       WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id != ?
         AND deleted_at IS NULL AND merged_into IS NULL
       LIMIT 1`
  ).bind(orgId, canonicalName, companyId).first<{ id: string }>();

  if (dup) {
    const survivor = dup.id;
    await env.D1.batch([
      env.D1.prepare(`UPDATE contacts SET company_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE company_id = ?`).bind(survivor, companyId),
      env.D1.prepare(`UPDATE deals SET company_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE company_id = ?`).bind(survivor, companyId),
      env.D1.prepare(`UPDATE documents SET company_id = ? WHERE company_id = ?`).bind(survivor, companyId),
      env.D1.prepare(`UPDATE tasks SET company_id = ? WHERE company_id = ?`).bind(survivor, companyId),
      env.D1.prepare(`UPDATE news_articles SET company_id = ? WHERE company_id = ?`).bind(survivor, companyId),
      env.D1.prepare(`DELETE FROM company_tags WHERE company_id = ?`).bind(companyId),
      env.D1.prepare(`UPDATE companies SET merged_into = ?, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(survivor, companyId),
    ]);

    await emitAudit(env, {
      org_id: orgId, action: 'merge', entity_type: 'company', entity_id: companyId,
      metadata: { merged_into: survivor, canonical_name: canonicalName, reason: 'enrichment_resolved_existing_name' },
      created_at: new Date().toISOString(),
    });
    console.log(`[enrichment] merged company ${companyId} → ${survivor} (canonical "${canonicalName}")`);
    return;
  }

  await env.D1.prepare(
    `UPDATE companies SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(canonicalName, companyId).run();

  await emitAudit(env, {
    org_id: orgId, action: 'update', entity_type: 'company', entity_id: companyId,
    metadata: { field: 'name', new_name: canonicalName, reason: 'enrichment_canonical_name' },
    created_at: new Date().toISOString(),
  });
  console.log(`[enrichment] resolved company name: ${companyId} → "${canonicalName}"`);
}
