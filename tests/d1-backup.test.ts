import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import {
  classifySqliteMaster,
  dumpTablePart,
  runBackupRetention,
  runD1Backup,
  BACKUP_ROOT,
  __d1BackupTestHooks,
} from '../src/lib/d1-backup';
// The restore side of the round trip uses the exact primitives the
// restore CLI uses.
// eslint-disable-next-line import/no-relative-packages
import { insertSql, rowsFromJsonlText, sqlLiteral, statementsForRow, MAX_STATEMENT_BYTES } from '../scripts/lib/d1-restore-core.mjs';

type Row = Record<string, unknown>;

interface FakeTable {
  rows: Row[];
  noRowid?: boolean;
  // Explicit rowid per row (defaults to index+1). Lets tests cover
  // negative/zero rowids, which a seeded `WHERE rowid > -1` keyset
  // would silently drop (audit round 1, F2).
  rowids?: number[];
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

// Focused emulation of the exact query shapes src/lib/d1-backup.ts
// issues. Anything else throws so drift between lib and fake is loud.
class FakeD1 {
  tables = new Map<string, FakeTable>();
  master: MasterRow[] = [];

  prepare(sql: string) {
    const run = async (binds: unknown[]) => this.execute(sql, binds);
    const statement = {
      bind: (...binds: unknown[]) => ({
        all: async <T>() => ({ results: (await run(binds)) as T[] }),
        first: async <T>() => ((await run(binds))[0] ?? null) as T | null,
        run: async () => ({ meta: { changes: 0 } }),
      }),
      all: async <T>() => ({ results: (await run([])) as T[] }),
      first: async <T>() => ((await run([]))[0] ?? null) as T | null,
    };
    return statement;
  }

  private execute(sql: string, binds: unknown[]): Row[] {
    if (/FROM sqlite_master/i.test(sql)) {
      return this.master as unknown as Row[];
    }
    const rowidFirstMatch = sql.match(/^SELECT rowid AS __rowid, \* FROM "([^"]+)" ORDER BY rowid LIMIT \?$/);
    const rowidKeysetMatch = sql.match(/^SELECT rowid AS __rowid, \* FROM "([^"]+)" WHERE rowid > \? ORDER BY rowid LIMIT \?$/);
    if (rowidFirstMatch || rowidKeysetMatch) {
      const name = (rowidFirstMatch ?? rowidKeysetMatch)![1];
      const table = this.tables.get(name);
      if (!table) throw new Error(`no such table: ${name}`);
      if (table.noRowid) throw new Error('no such column: rowid');
      const last = rowidKeysetMatch ? Number(binds[0]) : -Infinity;
      const limit = Number(rowidKeysetMatch ? binds[1] : binds[0]);
      return table.rows
        .map((row, i) => ({ __rowid: table.rowids ? table.rowids[i] : i + 1, ...row }))
        .sort((a, b) => (a.__rowid as number) - (b.__rowid as number))
        .filter(r => (r.__rowid as number) > last)
        .slice(0, limit);
    }
    const offsetMatch = sql.match(/^SELECT \* FROM "([^"]+)" LIMIT \? OFFSET \?$/);
    if (offsetMatch) {
      const table = this.tables.get(offsetMatch[1]);
      if (!table) throw new Error(`no such table: ${offsetMatch[1]}`);
      const limit = Number(binds[0]);
      const offset = Number(binds[1]);
      return table.rows.slice(offset, offset + limit).map(r => ({ ...r }));
    }
    throw new Error(`FakeD1 does not understand: ${sql}`);
  }
}

class FakeR2 {
  objects = new Map<string, { body: string; customMetadata?: Record<string, string> }>();

  async put(key: string, body: string, opts?: { customMetadata?: Record<string, string> }) {
    this.objects.set(key, { body, customMetadata: opts?.customMetadata });
    return {} as unknown;
  }

  async list(opts: { prefix?: string; delimiter?: string; cursor?: string }) {
    const prefix = opts.prefix ?? '';
    const keys = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
    if (opts.delimiter) {
      const delimited = new Set<string>();
      const objects: { key: string }[] = [];
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(opts.delimiter);
        if (idx >= 0) delimited.add(prefix + rest.slice(0, idx + 1));
        else objects.push({ key });
      }
      return { objects, delimitedPrefixes: [...delimited].sort(), truncated: false as const, cursor: undefined };
    }
    return { objects: keys.map(key => ({ key })), delimitedPrefixes: [], truncated: false as const, cursor: undefined };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

const inlineStep = {
  async do<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    return callback();
  },
};

function makeEnv(d1: FakeD1, r2: FakeR2) {
  return { D1: d1 as never, R2: r2 as never, ENVIRONMENT: 'test' };
}

const MASTER_FIXTURE: MasterRow[] = [
  { type: 'table', name: 'contacts', tbl_name: 'contacts', sql: 'CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, score REAL, age INTEGER, notes TEXT, avatar BLOB)' },
  { type: 'table', name: 'companies', tbl_name: 'companies', sql: 'CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT)' },
  { type: 'table', name: 'kv_meta', tbl_name: 'kv_meta', sql: 'CREATE TABLE kv_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID' },
  { type: 'table', name: 'contact_search_fts', tbl_name: 'contact_search_fts', sql: "CREATE VIRTUAL TABLE contact_search_fts USING fts5(name, content='')" },
  { type: 'table', name: 'contact_search_fts_data', tbl_name: 'contact_search_fts_data', sql: 'CREATE TABLE contact_search_fts_data (id INTEGER PRIMARY KEY, block BLOB)' },
  { type: 'table', name: 'contact_search_fts_idx', tbl_name: 'contact_search_fts_idx', sql: 'CREATE TABLE contact_search_fts_idx (segid, term, pgno)' },
  { type: 'table', name: 'contact_search_fts_config', tbl_name: 'contact_search_fts_config', sql: 'CREATE TABLE contact_search_fts_config (k PRIMARY KEY, v)' },
  { type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'CREATE TABLE _cf_KV (key TEXT, value BLOB)' },
  { type: 'table', name: 'sqlite_sequence', tbl_name: 'sqlite_sequence', sql: 'CREATE TABLE sqlite_sequence(name,seq)' },
  { type: 'index', name: 'idx_contacts_name', tbl_name: 'contacts', sql: 'CREATE INDEX idx_contacts_name ON contacts(name)' },
  { type: 'index', name: 'sqlite_autoindex_contacts_1', tbl_name: 'contacts', sql: null },
  { type: 'trigger', name: 'trg_contacts', tbl_name: 'contacts', sql: 'CREATE TRIGGER trg_contacts AFTER INSERT ON contacts BEGIN SELECT 1; END' },
  { type: 'view', name: 'v_contacts', tbl_name: 'v_contacts', sql: 'CREATE VIEW v_contacts AS SELECT id FROM contacts' },
];

function trickyContactRows(): Row[] {
  return [
    { id: 'c1', name: "O'Brien \"quoted\"", score: 0.5, age: 41, notes: 'line1\nline2\ttabbed', avatar: null },
    { id: 'c2', name: 'Ünïcødé ✓ 名前', score: -12.75, age: null, notes: null, avatar: new Uint8Array([0, 1, 2, 250, 255]).buffer },
    { id: 'c3', name: null, score: 3, age: 0, notes: '', avatar: null },
  ];
}

describe('backup table classification', () => {
  it('keeps base tables, skips internals, virtual tables, and their shadows', () => {
    const plan = classifySqliteMaster(MASTER_FIXTURE);
    expect(plan.tables).toEqual(['companies', 'contacts', 'kv_meta']);
    const skippedNames = plan.skipped.map(s => s.name).sort();
    expect(skippedNames).toEqual([
      '_cf_KV',
      'contact_search_fts',
      'contact_search_fts_config',
      'contact_search_fts_data',
      'contact_search_fts_idx',
      'sqlite_sequence',
    ]);
  });

  it('captures schema for tables, virtual tables, named indexes, triggers, views — not auto-indexes or internals', () => {
    const plan = classifySqliteMaster(MASTER_FIXTURE);
    expect(plan.schemaSql).toContain('CREATE TABLE contacts');
    expect(plan.schemaSql).toContain('CREATE VIRTUAL TABLE contact_search_fts');
    expect(plan.schemaSql).toContain('CREATE INDEX idx_contacts_name');
    expect(plan.schemaSql).toContain('CREATE TRIGGER trg_contacts');
    expect(plan.schemaSql).toContain('CREATE VIEW v_contacts');
    expect(plan.schemaSql).not.toContain('_cf_KV');
    expect(plan.schemaSql).not.toContain('autoindex');
    expect(plan.schemaSql).not.toContain('contact_search_fts_data');
  });
});

describe('dumpTablePart pagination', () => {
  it('pages a rowid table with keyset cursors and strips __rowid', async () => {
    const d1 = new FakeD1();
    d1.tables.set('t', { rows: Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, n: i })) });
    const env = makeEnv(d1, new FakeR2());

    const part1 = await dumpTablePart(env, 't', null, { maxRows: 10 });
    expect(part1.rows).toBe(10);
    expect(part1.nextCursor).toEqual({ mode: 'rowid', last: 10 });
    expect(part1.lines).not.toContain('__rowid');

    const part2 = await dumpTablePart(env, 't', part1.nextCursor, { maxRows: 10 });
    const part3 = await dumpTablePart(env, 't', part2.nextCursor, { maxRows: 10 });
    expect(part2.rows).toBe(10);
    expect(part3.rows).toBe(5);
    expect(part3.nextCursor).toBeNull();

    const all = [...rowsFromJsonlText(part1.lines + part2.lines + part3.lines)];
    expect(all).toHaveLength(25);
    expect(all.map(r => r.id)).toEqual(Array.from({ length: 25 }, (_, i) => `r${i}`));
  });

  it('captures negative and zero rowids (no keyset seed constant)', async () => {
    const d1 = new FakeD1();
    d1.tables.set('t', {
      rows: [{ id: 'neg5' }, { id: 'neg1' }, { id: 'zero' }, { id: 'two' }, { id: 'forty' }],
      rowids: [-5, -1, 0, 2, 40],
    });
    const env = makeEnv(d1, new FakeR2());

    const part1 = await dumpTablePart(env, 't', null, { maxRows: 2 });
    expect(part1.rows).toBe(2);
    expect(part1.nextCursor).toEqual({ mode: 'rowid', last: -1 });
    const part2 = await dumpTablePart(env, 't', part1.nextCursor, { maxRows: 2 });
    const part3 = await dumpTablePart(env, 't', part2.nextCursor, { maxRows: 2 });
    const all = [...rowsFromJsonlText(part1.lines + part2.lines + part3.lines)];
    expect(all.map(r => r.id)).toEqual(['neg5', 'neg1', 'zero', 'two', 'forty']);
    expect(part3.nextCursor).toBeNull();
  });

  it('falls back to offset pagination for WITHOUT ROWID tables', async () => {
    const d1 = new FakeD1();
    d1.tables.set('t', { rows: Array.from({ length: 7 }, (_, i) => ({ k: `k${i}` })), noRowid: true });
    const env = makeEnv(d1, new FakeR2());

    const part1 = await dumpTablePart(env, 't', null, { maxRows: 4 });
    expect(part1.mode).toBe('offset');
    expect(part1.rows).toBe(4);
    expect(part1.nextCursor).toEqual({ mode: 'offset', offset: 4 });

    const part2 = await dumpTablePart(env, 't', part1.nextCursor, { maxRows: 4 });
    expect(part2.rows).toBe(3);
    expect(part2.nextCursor).toBeNull();
  });

  it('honors the byte budget', async () => {
    const d1 = new FakeD1();
    const big = 'x'.repeat(400);
    d1.tables.set('t', { rows: Array.from({ length: 50 }, (_, i) => ({ id: i, blob: big })) });
    const env = makeEnv(d1, new FakeR2());
    const part = await dumpTablePart(env, 't', null, { maxRows: 1000, maxBytes: 2000 });
    expect(part.rows).toBeGreaterThan(0);
    expect(part.rows).toBeLessThan(50);
    expect(part.nextCursor).not.toBeNull();
  });
});

describe('full backup → restore round trip (real SQLite)', () => {
  it('replays every dumped row into a real database byte-identically', async () => {
    const d1 = new FakeD1();
    d1.master = MASTER_FIXTURE;
    d1.tables.set('contacts', { rows: trickyContactRows() });
    d1.tables.set('companies', { rows: [] });
    d1.tables.set('kv_meta', { rows: [{ k: 'a', v: '1' }, { k: 'b', v: null }], noRowid: true });
    const r2 = new FakeR2();
    const env = makeEnv(d1, r2);

    const result = await runD1Backup(env, inlineStep, { date: '2026-07-06' });
    expect(result.tables).toBe(3);
    expect(result.rows).toBe(5);
    expect(result.skipped.map(s => s.name)).toContain('contact_search_fts');

    // Manifest is the completion marker and must reference only keys that exist.
    const manifestObj = r2.objects.get('backups/d1/2026-07-06/manifest.json');
    expect(manifestObj).toBeDefined();
    const manifest = JSON.parse(manifestObj!.body);
    expect(manifest.format).toBe('medina-d1-backup/1');
    for (const table of manifest.tables) {
      for (const part of table.parts) expect(r2.objects.has(part.key)).toBe(true);
    }
    expect(r2.objects.has('backups/d1/latest.json')).toBe(true);
    const kvMeta = manifest.tables.find((t: { name: string }) => t.name === 'kv_meta');
    expect(kvMeta.mode).toBe('offset');

    // Restore into a REAL SQLite database using the restore CLI's own
    // SQL generation, then compare.
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, score REAL, age INTEGER, notes TEXT, avatar BLOB)');
    db.exec('CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT)');
    db.exec('CREATE TABLE kv_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID');

    for (const table of manifest.tables) {
      for (const part of table.parts) {
        const body = r2.objects.get(part.key)!.body;
        for (const row of rowsFromJsonlText(body)) {
          const sql = insertSql(table.name, row as Record<string, unknown>);
          db.exec(sql);
        }
      }
    }

    const contacts = db.prepare('SELECT * FROM contacts ORDER BY id').all() as Record<string, unknown>[];
    expect(contacts).toHaveLength(3);
    expect(contacts[0].name).toBe("O'Brien \"quoted\"");
    expect(contacts[0].notes).toBe('line1\nline2\ttabbed');
    expect(contacts[1].name).toBe('Ünïcødé ✓ 名前');
    expect(contacts[1].score).toBe(-12.75);
    expect(contacts[1].age).toBeNull();
    expect(contacts[2].name).toBeNull();
    expect(contacts[2].notes).toBe('');
    const avatar = contacts[1].avatar as Uint8Array;
    expect([...avatar]).toEqual([0, 1, 2, 250, 255]);

    const kv = db.prepare('SELECT * FROM kv_meta ORDER BY k').all() as Record<string, unknown>[];
    expect(kv).toEqual([{ k: 'a', v: '1' }, { k: 'b', v: null }]);

    // Idempotency: replaying the same backup again must not duplicate rows.
    for (const table of manifest.tables) {
      for (const part of table.parts) {
        for (const row of rowsFromJsonlText(r2.objects.get(part.key)!.body)) {
          db.exec(insertSql(table.name, row as Record<string, unknown>));
        }
      }
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS c FROM kv_meta').get() as { c: number }).c).toBe(2);
  });
});

describe('retention', () => {
  it('keeps the newest N date partitions and never touches non-partition keys', async () => {
    const r2 = new FakeR2();
    for (let day = 1; day <= 20; day++) {
      const date = `2026-06-${String(day).padStart(2, '0')}`;
      await r2.put(`${BACKUP_ROOT}${date}/manifest.json`, '{}');
      await r2.put(`${BACKUP_ROOT}${date}/parts/0001-contacts.jsonl`, '{}');
    }
    await r2.put(`${BACKUP_ROOT}latest.json`, '{}');
    await r2.put('maintenance/d1/2026-06-01/0001-foo.jsonl', '{}');

    const env = makeEnv(new FakeD1(), r2);
    const result = await runBackupRetention(env, 14);

    expect(result.kept).toHaveLength(14);
    expect(result.deleted_prefixes).toEqual(
      Array.from({ length: 6 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`)
    );
    expect(result.deleted_objects).toBe(12);
    expect(r2.objects.has(`${BACKUP_ROOT}2026-06-01/manifest.json`)).toBe(false);
    expect(r2.objects.has(`${BACKUP_ROOT}2026-06-07/manifest.json`)).toBe(true);
    expect(r2.objects.has(`${BACKUP_ROOT}latest.json`)).toBe(true);
    expect(r2.objects.has('maintenance/d1/2026-06-01/0001-foo.jsonl')).toBe(true);
  });
});

describe('restore SQL literals', () => {
  it('encodes scalars safely and text as hex casts', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(-0.5)).toBe('-0.5');
    expect(sqlLiteral(NaN)).toBe('NULL');
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral('')).toBe("''");
    // Text never appears as a quoted literal — only hex bytes.
    expect(sqlLiteral("it's")).toBe(`CAST(X'${Buffer.from("it's", 'utf8').toString('hex').toUpperCase()}' AS TEXT)`);
    expect(sqlLiteral({ $b64: Buffer.from([0, 255]).toString('base64') })).toBe("X'00FF'");
  });

  it('generated SQL never contains data-shaped SQL tokens (wrangler trimmer hazard)', () => {
    // wrangler's d1 file trimmer greps for these tokens and aborts or
    // strips them even when they occur INSIDE data. Hex text literals
    // make that structurally impossible.
    const hostile = {
      id: 'h1',
      body: 'meeting notes: BEGIN TRANSACTION; then we agreed. COMMIT; -- done\nAlso: DROP TABLE contacts;',
      quote: `O'Brien said "COMMIT;"`,
    };
    const sql = insertSql('notes', hostile);
    expect(sql).not.toMatch(/BEGIN TRANSACTION/);
    expect(sql).not.toMatch(/COMMIT;/);
    expect(sql).not.toMatch(/DROP TABLE/);

    // And the statement still restores the exact content into real SQLite.
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, quote TEXT)');
    db.exec(sql);
    const row = db.prepare('SELECT * FROM notes').get() as Record<string, unknown>;
    expect(row.body).toBe(hostile.body);
    expect(row.quote).toBe(hostile.quote);
  });

  it('fnv1a is stable', () => {
    expect(__d1BackupTestHooks.fnv1a('hello')).toBe(__d1BackupTestHooks.fnv1a('hello'));
    expect(__d1BackupTestHooks.fnv1a('hello')).not.toBe(__d1BackupTestHooks.fnv1a('hellp'));
  });
});

describe('oversized values restore via bounded statement groups (R2-1)', () => {
  // D1 caps statements at ~100KB and hex doubles bytes, so values
  // ≥ ~45KB must restore via sentinel + chunked appends with EVERY
  // statement under the cap.
  function applyStatements(db: InstanceType<typeof DatabaseSync>, statements: string[]) {
    for (const statement of statements) {
      expect(Buffer.byteLength(statement, 'utf8')).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
      db.exec(statement);
    }
  }

  it('round-trips 60KB and 150KB text plus an 80KB blob byte-exactly', () => {
    // 60KB sits in the band that regressed vs quoted literals; 150KB
    // was un-restorable under any prior encoding. Unicode padding makes
    // chunk boundaries land mid-character (multi-byte splits).
    const text60 = ('ü✓' + 'a'.repeat(58)).repeat(1000);        // ~60KB utf8
    const text150 = ('名前🚀' + 'b'.repeat(89)).repeat(1500);    // ~150KB utf8
    const blob = new Uint8Array(80_000).map((_, i) => i % 256);
    const row = {
      id: 'big1',
      body: text60,
      extracted: text150,
      payload: { $b64: Buffer.from(blob).toString('base64') },
      small: 'ordinary',
      empty: '',
      maybe_null: null,
    };

    const statements = statementsForRow('chat_uploads', row) as string[];
    expect(statements.length).toBeGreaterThan(3); // insert + appends + strips
    for (const statement of statements) {
      expect(statement).not.toMatch(/BEGIN TRANSACTION/);
      expect(statement).not.toMatch(/COMMIT;/);
    }

    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE chat_uploads (id TEXT PRIMARY KEY, body TEXT, extracted TEXT, payload BLOB, small TEXT, empty TEXT, maybe_null TEXT)');
    applyStatements(db, statements);

    const got = db.prepare('SELECT * FROM chat_uploads').get() as Record<string, unknown>;
    expect(got.body).toBe(text60);
    expect(got.extracted).toBe(text150);
    expect([...(got.payload as Uint8Array)]).toEqual([...blob]);
    expect(got.small).toBe('ordinary');
    expect(got.empty).toBe('');
    expect(got.maybe_null).toBeNull();

    // Stored TYPES must survive too: SQLite's || casts blobs to text,
    // which is exactly the corruption the TEXT-space assembly avoids.
    const types = db.prepare(
      'SELECT typeof(body) AS t_body, typeof(payload) AS t_payload FROM chat_uploads'
    ).get() as Record<string, string>;
    expect(types.t_body).toBe('text');
    expect(types.t_payload).toBe('blob');

    // Idempotency: replaying the whole group again converges to the
    // same single row with identical content.
    applyStatements(db, statementsForRow('chat_uploads', row) as string[]);
    const rows = db.prepare('SELECT * FROM chat_uploads').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].extracted).toBe(text150);
  });

  it('small rows keep the single-statement path', () => {
    const statements = statementsForRow('t', { id: 'x', v: 'small' }) as string[];
    expect(statements).toHaveLength(1);
    expect(statements[0]).toBe(insertSql('t', { id: 'x', v: 'small' }));
  });

  it('groups for two oversized rows use distinct sentinels and coexist', () => {
    const big = 'z'.repeat(60_000);
    const rowA = { id: 'a', body: `${big}A` };
    const rowB = { id: 'b', body: `${big}B` };
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)');
    // Interleave the two groups' inserts before appends run — the
    // stateless sentinel predicates must not cross-contaminate.
    const groupA = statementsForRow('t', rowA) as string[];
    const groupB = statementsForRow('t', rowB) as string[];
    db.exec(groupA[0]);
    db.exec(groupB[0]);
    for (const statement of groupA.slice(1)) db.exec(statement);
    for (const statement of groupB.slice(1)) db.exec(statement);
    const rows = db.prepare('SELECT id, body FROM t ORDER BY id').all() as Record<string, unknown>[];
    expect(rows[0].body).toBe(`${big}A`);
    expect(rows[1].body).toBe(`${big}B`);
  });
});
