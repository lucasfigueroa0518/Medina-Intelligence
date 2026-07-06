#!/usr/bin/env node
// Wrangler config drift check.
//
// Four wrangler configs duplicate a [vars] block and share bindings;
// nothing stopped them drifting apart silently. Restructuring the
// configs themselves (shared includes) isn't expressible in wrangler
// TOML without changing deploy behavior, so the safe mechanism is this
// checker: it encodes the CANONICAL expectations — which vars must be
// identical everywhere, which divergences are intentional (with their
// expected values), which infra identities must match — and fails loud
// on anything unclassified. Adding a var to one config forces a
// conscious classification here; changing a cron or a binding id
// forces a manifest edit that a reviewer sees.
//
// Zero dependencies (parses only the TOML subset these configs use) so
// CI can run it without npm install. Run directly:
//   node scripts/check-wrangler-drift.mjs
// or via the vitest suite (tests/wrangler-drift.test.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILES = [
  'wrangler.toml',
  'wrangler.pipelines.toml',
  'wrangler.readonly.toml',
  'wrangler.crm-canary.toml',
];

// ---------------------------------------------------------------------------
// The manifest: canonical truth about intentional config shape.
// ---------------------------------------------------------------------------

// Vars that must exist with IDENTICAL values in every config.
const PARITY_VARS = [
  'ENVIRONMENT',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_AI_GATEWAY_SLUG',
  'GEMINI_MAX_RPM',
  'INTERNAL_DOMAINS',
  'OUTLOOK_AUTH_MODE',
];

// Vars that intentionally exist only in SOME configs. For each: which
// configs carry it, and (optionally) per-config pinned values where the
// divergence itself is the point. A var in this map appearing in a
// config not listed for it — or missing from one that is — fails.
const SCOPED_VARS = {
  // CORS/frontend origins: prod workers point at the real frontend;
  // readonly is a localhost-only preview tool (CLAUDE.md warns it hits
  // prod D1 — its localhost origins are load-bearing, keep them).
  ALLOWED_ORIGINS: {
    configs: ['wrangler.toml', 'wrangler.pipelines.toml', 'wrangler.readonly.toml'],
    pinned: {
      'wrangler.toml': 'https://medinaventures.ai,https://www.medinaventures.ai,http://localhost:3000',
      'wrangler.pipelines.toml': 'https://medinaventures.ai,https://www.medinaventures.ai,http://localhost:3000',
      'wrangler.readonly.toml': 'http://localhost:3000,http://127.0.0.1:3000',
    },
  },
  FRONTEND_URL: {
    configs: ['wrangler.toml', 'wrangler.pipelines.toml', 'wrangler.readonly.toml'],
    pinned: {
      'wrangler.toml': 'https://medinaventures.ai',
      'wrangler.pipelines.toml': 'https://medinaventures.ai',
      'wrangler.readonly.toml': 'http://127.0.0.1:3000',
    },
  },
  // Deck renderer: off for readonly (local preview shouldn't render),
  // absent on canary (no deck paths).
  DECK_RENDERER_ENABLED: {
    configs: ['wrangler.toml', 'wrangler.pipelines.toml', 'wrangler.readonly.toml'],
    pinned: {
      'wrangler.toml': 'true',
      'wrangler.pipelines.toml': 'true',
      'wrangler.readonly.toml': 'false',
    },
  },
  DECK_RENDERER_PROVIDER: {
    configs: ['wrangler.toml', 'wrangler.pipelines.toml'],
    equalAcross: true,
  },
  // CRM name resolver rollout flags ride only the two prod workers.
  CRM_NAME_RESOLVER_ENABLED: {
    configs: ['wrangler.toml', 'wrangler.pipelines.toml'],
    equalAcross: true,
  },
  CRM_NAME_BACKFILL_APPLY_ENABLED: {
    configs: ['wrangler.toml', 'wrangler.pipelines.toml'],
    equalAcross: true,
  },
  // RAG v2 queue tuning exists only where the queue consumer runs.
  RAG_V2_QUEUE_DISPATCH_BATCH: { configs: ['wrangler.pipelines.toml'] },
  RAG_V2_QUEUE_MAX_ACTIVE: { configs: ['wrangler.pipelines.toml'] },
};

// Cron triggers: exact expected sets. api deliberately has NONE
// (Phase 8 strip, 2026-05-06) and pipelines has exactly two — a 4th
// registered trigger broke CF cron dispatch on 2026-04-28, so growing
// this set is a decision, not a drive-by (new scheduled work rides the
// minute-tick time-of-day gates in handleScheduled).
const EXPECTED_CRONS = {
  'wrangler.toml': [],
  'wrangler.pipelines.toml': ['0 * * * *', '* * * * *'],
  'wrangler.readonly.toml': [],
  'wrangler.crm-canary.toml': [],
};

// Shared infra identity: these ids must be identical wherever present.
const IDENTITY_KEYS = ['d1_database_id', 'd1_database_name', 'r2_bucket_name', 'kv_id'];

// Binding NAMES the shared codebase compiles against (env.D1, env.R2,
// env.KV). A renamed binding deploys fine and then crashes at runtime
// on the first env access — outside npm-audit/typecheck reach, so it
// belongs to this gate (audit round 1, F6).
const EXPECTED_BINDING_NAMES = { d1: 'D1', r2: 'R2', kv: 'KV' };

// Bindings each config is expected to declare (presence, not values).
// readonly is deliberately thin: D1 only, remote=true — giving it
// R2/KV would let a "readonly preview" write production storage.
const EXPECTED_BINDINGS = {
  'wrangler.toml': ['d1', 'r2', 'kv', 'ai', 'browser', 'vectorize', 'queues'],
  'wrangler.pipelines.toml': ['d1', 'r2', 'kv', 'ai', 'browser', 'vectorize', 'queues', 'workflows'],
  'wrangler.readonly.toml': ['d1'],
  'wrangler.crm-canary.toml': ['d1', 'r2', 'kv', 'queues'],
};

// ---------------------------------------------------------------------------
// Minimal TOML subset parser (sections, [[arrays]], k = "v"|num|bool,
// multi-line string arrays). Fails loud on lines it can't classify.
// ---------------------------------------------------------------------------

export function parseWranglerToml(text, fileName = '<config>') {
  const out = {
    name: null,
    vars: {},
    crons: [],
    bindings: new Set(),
    d1: [],
    r2: [],
    kv: [],
  };
  let section = '';
  let arrayCollect = null; // { key, items } while inside a multi-line array

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (arrayCollect) {
      const items = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
      arrayCollect.items.push(...items);
      if (line.includes(']')) {
        if (arrayCollect.key === 'crons' && section === 'triggers') out.crons = arrayCollect.items;
        arrayCollect = null;
      }
      continue;
    }

    const sectionMatch = line.match(/^\[\[?([A-Za-z0-9_.]+)\]\]?$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (section === 'ai') out.bindings.add('ai');
      else if (section === 'browser') out.bindings.add('browser');
      else if (section === 'vectorize') out.bindings.add('vectorize');
      else if (section === 'workflows') out.bindings.add('workflows');
      else if (section === 'd1_databases') { out.bindings.add('d1'); out.d1.push({}); }
      else if (section === 'r2_buckets') { out.bindings.add('r2'); out.r2.push({}); }
      else if (section === 'kv_namespaces') { out.bindings.add('kv'); out.kv.push({}); }
      else if (section.startsWith('queues.')) out.bindings.add('queues');
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kvMatch) {
      throw new Error(`${fileName}:${i + 1}: unparseable line for drift check: ${line}`);
    }
    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    if (value.startsWith('[') && !value.includes(']')) {
      arrayCollect = { key, items: [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]) };
      continue;
    }
    if (value.startsWith('[')) {
      const items = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
      if (key === 'crons' && section === 'triggers') out.crons = items;
      continue;
    }

    const strMatch = value.match(/^"((?:[^"\\]|\\.)*)"/);
    const parsed = strMatch ? strMatch[1] : value.replace(/\s+#.*$/, '');

    if (section === '' && key === 'name') out.name = parsed;
    else if (section === 'vars') out.vars[key] = parsed;
    else if (section === 'd1_databases' && out.d1.length) out.d1[out.d1.length - 1][key] = parsed;
    else if (section === 'r2_buckets' && out.r2.length) out.r2[out.r2.length - 1][key] = parsed;
    else if (section === 'kv_namespaces' && out.kv.length) out.kv[out.kv.length - 1][key] = parsed;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function runChecks(rootDir) {
  const failures = [];
  const configs = {};
  for (const file of CONFIG_FILES) {
    try {
      configs[file] = parseWranglerToml(readFileSync(join(rootDir, file), 'utf8'), file);
    } catch (e) {
      failures.push(String(e?.message || e));
    }
  }
  if (failures.length) return { failures };

  // 1. Parity vars: present + identical everywhere.
  for (const key of PARITY_VARS) {
    const values = new Map();
    for (const file of CONFIG_FILES) {
      const v = configs[file].vars[key];
      if (v === undefined) failures.push(`${file}: parity var ${key} is missing`);
      else values.set(file, v);
    }
    const distinct = new Set(values.values());
    if (distinct.size > 1) {
      failures.push(`parity var ${key} drifted: ${[...values.entries()].map(([f, v]) => `${f}=${JSON.stringify(v)}`).join(' vs ')}`);
    }
  }

  // 2. Scoped vars: exact config membership + pinned/equal values.
  for (const [key, rule] of Object.entries(SCOPED_VARS)) {
    for (const file of CONFIG_FILES) {
      const present = configs[file].vars[key] !== undefined;
      const expected = rule.configs.includes(file);
      if (present && !expected) failures.push(`${file}: var ${key} is not classified for this config — extend SCOPED_VARS in scripts/check-wrangler-drift.mjs deliberately`);
      if (!present && expected) failures.push(`${file}: var ${key} is expected here but missing`);
    }
    if (rule.pinned) {
      for (const [file, want] of Object.entries(rule.pinned)) {
        const got = configs[file]?.vars[key];
        if (got !== undefined && got !== want) {
          failures.push(`${file}: ${key} drifted from its documented intentional value: got ${JSON.stringify(got)}, manifest says ${JSON.stringify(want)}`);
        }
      }
    }
    if (rule.equalAcross) {
      const vals = rule.configs.map(f => configs[f]?.vars[key]).filter(v => v !== undefined);
      if (new Set(vals).size > 1) failures.push(`var ${key} must be equal across ${rule.configs.join(', ')} but differs`);
    }
  }

  // 3. Unclassified vars: everything appearing anywhere must be known.
  const known = new Set([...PARITY_VARS, ...Object.keys(SCOPED_VARS)]);
  for (const file of CONFIG_FILES) {
    for (const key of Object.keys(configs[file].vars)) {
      if (!known.has(key)) {
        failures.push(`${file}: var ${key} is unclassified — add it to PARITY_VARS or SCOPED_VARS in scripts/check-wrangler-drift.mjs (a conscious decision, reviewed)`);
      }
    }
  }

  // 4. Cron triggers: exact match per config.
  for (const file of CONFIG_FILES) {
    const got = configs[file].crons;
    const want = EXPECTED_CRONS[file];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${file}: cron triggers ${JSON.stringify(got)} != expected ${JSON.stringify(want)} — cron changes are a deliberate manifest edit (4 triggers broke CF dispatch 2026-04-28; prefer minute-tick gates)`);
    }
  }

  // 5. Infra identity where present.
  const identity = { d1_database_id: new Map(), d1_database_name: new Map(), r2_bucket_name: new Map(), kv_id: new Map() };
  for (const file of CONFIG_FILES) {
    for (const d1 of configs[file].d1) if (d1.database_id) identity.d1_database_id.set(file, d1.database_id);
    for (const d1 of configs[file].d1) if (d1.database_name) identity.d1_database_name.set(file, d1.database_name);
    for (const r2 of configs[file].r2) if (r2.bucket_name) identity.r2_bucket_name.set(file, r2.bucket_name);
    for (const kv of configs[file].kv) if (kv.id) identity.kv_id.set(file, kv.id);
  }
  for (const key of IDENTITY_KEYS) {
    const distinct = new Set(identity[key].values());
    if (distinct.size > 1) {
      failures.push(`${key} differs across configs: ${[...identity[key].entries()].map(([f, v]) => `${f}=${v}`).join(' vs ')}`);
    }
  }

  // 6. Binding shape per config (presence only).
  for (const file of CONFIG_FILES) {
    const got = configs[file].bindings;
    const want = new Set(EXPECTED_BINDINGS[file]);
    for (const b of want) if (!got.has(b)) failures.push(`${file}: expected ${b} binding is missing`);
    for (const b of got) if (!want.has(b)) failures.push(`${file}: unexpected ${b} binding — classify it in EXPECTED_BINDINGS deliberately (readonly especially: R2/KV there would let a "readonly" preview write production storage)`);
  }

  // 6b. Binding NAMES the shared code compiles against (env.D1 etc.).
  for (const file of CONFIG_FILES) {
    const groups = { d1: configs[file].d1, r2: configs[file].r2, kv: configs[file].kv };
    for (const [kind, entries] of Object.entries(groups)) {
      for (const entry of entries) {
        const want = EXPECTED_BINDING_NAMES[kind];
        if (entry.binding && entry.binding !== want) {
          failures.push(`${file}: ${kind} binding named ${JSON.stringify(entry.binding)} — shared code expects ${JSON.stringify(want)}; a rename deploys fine and crashes at runtime`);
        }
      }
    }
  }

  // 7. readonly safety invariants.
  const ro = configs['wrangler.readonly.toml'];
  if (ro.d1[0]?.remote !== 'true') {
    failures.push(`wrangler.readonly.toml: [d1] remote=true expected (documented: readonly preview reads PROD D1; if this changed, update CLAUDE.md's local-dev warning too)`);
  }

  return { failures };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const { failures } = runChecks(process.cwd());
  if (failures.length) {
    console.error(`wrangler config drift check FAILED (${failures.length}):\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`wrangler config drift check passed (${CONFIG_FILES.length} configs, ${PARITY_VARS.length} parity vars, scoped + crons + identity + bindings verified).`);
}
