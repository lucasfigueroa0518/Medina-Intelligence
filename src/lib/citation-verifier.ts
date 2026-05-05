// Wave-fix Chunk 3 (5a) — sample claim-grounding verification.
//
// Post-stream, async, sampled at 20%: for each [^N] marker in the persisted
// response, ask a judge model whether source N's chunk excerpt actually
// supports the surrounding claim. Verdicts land in agent_message_verifications
// for trend analysis. Strictly observability — does NOT block the user-
// facing response, does NOT regenerate, does NOT strip claims.
//
// Why sample 20% (not 100%): 2x inference per response is costly and
// unnecessary at this stage. Sampling builds the dataset to scope the
// next decision (5b full verification vs 5c heuristic-fast-path). If the
// sampled rate of 'unsupported' is high, escalate. If it's near zero,
// hold at sample-only.
//
// Audit 2026-05-05: Tony's hallucinated turn cited 10 emails to support
// fabricated Slack content. With this verifier active, ~10 verification
// rows would have been written (one per cited source), most/all with
// verdict='unsupported' — observable evidence of the failure.

import type { Env } from '../types/env';
import type { CitationSource } from './citations';
import { callClaude } from './claude';

const SAMPLE_RATE = 0.20;
const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const CLAIM_WINDOW_CHARS = 250;
const MAX_CLAIMS_PER_MESSAGE = 8; // bound CF subrequest fan-out per the standing 10-step cap

const VERIFIER_PROMPT = `You are a citation grounding judge. Given a SOURCE excerpt and a CLAIM that someone attributed to that source, decide whether the source actually supports the claim.

Verdicts:
- "supported": the source clearly contains the facts the claim asserts
- "partial": the source touches the topic but doesn't fully back the specific facts
- "unsupported": the source doesn't contain the claim's facts at all (the citer is fabricating or mis-attributing)

Be strict. A claim about "Slack channel #fundraising" cited to an email about Positron AI is unsupported, even if both touch venture-capital topics. The source must contain the actual facts the claim states, not just adjacent themes.

Respond with ONLY a JSON object on a single line: {"verdict":"supported|partial|unsupported","confidence":0.0-1.0,"rationale":"<60-word explanation>"}`;

interface ParsedClaim {
  sourceId: number;
  claimText: string;
  sourceExcerpt: string | null;
}

// Extract one claim per [^N] marker. The claim is the ~CLAIM_WINDOW_CHARS
// characters preceding the marker (capped at the start of the prior marker
// or the message start). Multiple markers in the same sentence collapse to
// the same claim text but are scored separately — that's fine for the rate
// metric and gives us per-citation observability.
export function extractClaims(
  responseText: string,
  sources: CitationSource[]
): ParsedClaim[] {
  const sourceById = new Map<number, CitationSource>();
  for (const s of sources) sourceById.set(s.id, s);

  const re = /\[\^(\d+)\]/g;
  const matches: { id: number; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(responseText)) !== null) {
    const id = parseInt(m[1], 10);
    if (sourceById.has(id)) {
      matches.push({ id, index: m.index });
    }
    // Invalid IDs (already stripped by Chunk 2's strip-and-flag) shouldn't
    // appear here at verification time — we run on the persisted (stripped)
    // text. Defensive: if one slips through, skip it.
  }

  const claims: ParsedClaim[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const prevEnd = i > 0 ? matches[i - 1].index + 4 : 0; // 4 ≈ "[^N]" length
    const windowStart = Math.max(prevEnd, cur.index - CLAIM_WINDOW_CHARS);
    const claimText = responseText.slice(windowStart, cur.index).trim();
    if (claimText.length < 10) continue; // sliver — skip

    const src = sourceById.get(cur.id)!;
    claims.push({
      sourceId: cur.id,
      claimText,
      sourceExcerpt: src.excerpt || null,
    });
  }
  return claims;
}

interface VerificationResult {
  verdict: 'supported' | 'partial' | 'unsupported' | 'error';
  confidence: number;
  rationale: string;
}

async function judgeClaim(
  claim: ParsedClaim,
  orgId: string,
  env: Env
): Promise<VerificationResult> {
  if (!claim.sourceExcerpt) {
    return {
      verdict: 'error',
      confidence: 0,
      rationale: '(no source excerpt available — pre-Wave-4 source or hydration miss)',
    };
  }
  try {
    const userPrompt = `SOURCE [${claim.sourceId}] excerpt:\n${claim.sourceExcerpt.slice(0, 1500)}\n\nCLAIM attributed to it:\n${claim.claimText}`;
    const response = await callClaude(
      {
        system: VERIFIER_PROMPT,
        user: userPrompt,
        max_tokens: 200,
        orgId,
        model: JUDGE_MODEL,
      },
      'low',
      env
    );
    const cleaned = response.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const verdict = parsed.verdict;
    const valid: Set<string> = new Set(['supported', 'partial', 'unsupported']);
    return {
      verdict: valid.has(verdict) ? verdict : 'error',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      rationale: String(parsed.rationale || '').slice(0, 500),
    };
  } catch (e: any) {
    return {
      verdict: 'error',
      confidence: 0,
      rationale: `judge error: ${String(e?.message || e).slice(0, 200)}`,
    };
  }
}

export async function verifySampleClaims(
  messageId: string,
  orgId: string,
  responseText: string,
  sources: CitationSource[],
  env: Env
): Promise<void> {
  // Sample gate — the 20% bucket. All-or-nothing per message: avoid the
  // weirdness of partial verification per claim (would skew aggregate
  // verdict rates).
  if (Math.random() > SAMPLE_RATE) return;
  if (sources.length === 0) return;

  const claims = extractClaims(responseText, sources);
  if (claims.length === 0) return;

  // Cap fan-out for the Cloudflare 50-subrequest budget (10/step memory).
  // A response with 20+ markers is rare; if we hit that, skip past 8.
  const sampled = claims.slice(0, MAX_CLAIMS_PER_MESSAGE);

  // Run sequentially to keep the subrequest count predictable; each judge
  // call is one fetch to the Anthropic gateway. 8 × ~400ms = ~3s wall, all
  // in waitUntil() background — never blocks the user.
  for (const claim of sampled) {
    const result = await judgeClaim(claim, orgId, env);
    try {
      await env.D1.prepare(
        `INSERT INTO agent_message_verifications
           (id, message_id, org_id, source_id, claim_text, source_excerpt,
            verdict, confidence, rationale, judge_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        messageId,
        orgId,
        claim.sourceId,
        claim.claimText.slice(0, 1000),
        claim.sourceExcerpt ? claim.sourceExcerpt.slice(0, 1500) : null,
        result.verdict,
        result.confidence,
        result.rationale,
        JUDGE_MODEL
      ).run();
    } catch (e: any) {
      console.error(`[citation-verifier] D1 insert failed for message ${messageId}:`, e?.message || e);
    }
  }
}
