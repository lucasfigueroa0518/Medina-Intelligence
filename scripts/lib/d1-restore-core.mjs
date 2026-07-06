// Shared primitives for replaying JSONL D1 snapshots (maintenance
// snapshots and full backups share the format: one JSON object per
// line, one file per table part, restored with INSERT OR REPLACE).
//
// Used by scripts/restore-d1-backup.mjs and
// scripts/restore-maintenance-snapshot.mjs, and unit-tested by
// tests/d1-backup.test.ts (the round-trip proof applies these exact
// statements to a real SQLite database).
//
// ENCODING INVARIANT (audit round 1, F1): every text value is emitted
// as a hex blob cast — CAST(X'…' AS TEXT) — never as a quoted string
// literal. `wrangler d1 execute --file` runs a client-side "trimmer"
// that greps the SQL text for `BEGIN TRANSACTION` / `COMMIT;` and
// strips/errors on what it finds — including occurrences INSIDE data
// (a transcript or note containing uppercase SQL aborts the restore,
// or worse, gets a stray COMMIT stripped out of its content). Hex
// literals make generated SQL contain only [A-F0-9] inside values, so
// no data can ever collide with SQL tokens, quote-escaping, or the
// trimmer. The ~2x size cost is irrelevant next to a restore that
// cannot be corrupted by its own payload. For the same reason the
// restore scripts do NOT wrap batches in BEGIN/COMMIT: wrangler
// strips them anyway (no atomicity was ever provided), and their only
// observable effect was colliding with the trimmer.

export function sqlLiteral(value) {
  if (value === null || typeof value === 'undefined') return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') {
    // BLOB columns are backed up as tagged base64 ({ $b64: "..." })
    // because D1 returns them as ArrayBuffer and raw JSON would corrupt
    // them. They restore as X'..' blob literals.
    if (typeof value.$b64 === 'string') return `X'${base64ToHex(value.$b64)}'`;
    // Unknown object shape — store its JSON text rather than
    // '[object Object]'. Backups themselves never produce this.
    return textLiteral(JSON.stringify(value));
  }
  return textLiteral(String(value));
}

function textLiteral(s) {
  if (s === '') return "''";
  return `CAST(X'${Buffer.from(s, 'utf8').toString('hex').toUpperCase()}' AS TEXT)`;
}

export function base64ToHex(b64) {
  const bytes = Buffer.from(b64, 'base64');
  return bytes.toString('hex').toUpperCase();
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function insertSql(table, row) {
  if (!IDENTIFIER.test(table)) throw new Error(`Unsafe table name: ${table}`);
  const columns = Object.keys(row).filter(c => IDENTIFIER.test(c));
  if (columns.length === 0) return '';
  const columnSql = columns.map(c => `"${c}"`).join(', ');
  const valueSql = columns.map(c => sqlLiteral(row[c])).join(', ');
  return `INSERT OR REPLACE INTO "${table}" (${columnSql}) VALUES (${valueSql});`;
}

// D1 rejects statements over 100KB (measured: SQLITE_TOOBIG at ~100,171
// bytes), and hex encoding doubles payload bytes — so a ~50KB text value
// would make a single INSERT un-restorable (audit round 2, R2-1; real
// tables like chat_uploads.extracted_text hold such values). Rows whose
// single-statement form exceeds MAX_STATEMENT_BYTES are therefore
// emitted as a bounded statement GROUP.
//
// The group assembles oversized values ENTIRELY IN TEXT SPACE — for
// BLOBs too — because SQLite's || operator casts BLOB operands to TEXT
// (a blob-appending group would silently store TEXT and the typed strip
// predicate would never match; caught by the round-3 wrangler drill):
//
//   1. INSERT OR REPLACE with each oversized value replaced by a random
//      per-row 32-hex-char TEXT sentinel,
//   2. one UPDATE per chunk appending content as TEXT — raw bytes for
//      text values, pure-ASCII hex characters for blob values — keyed
//      on `substr(col, 1, 32) = <sentinel>`,
//   3. a final UPDATE stripping the sentinel and converting: substr()
//      for text, unhex(substr()) for blobs (unhex → real BLOB; needs
//      SQLite ≥3.41 — D1, workerd, and node:sqlite all ship newer).
//
// Every statement stays under the cap by construction. Predicates are
// STATELESS (no last_insert_rowid(), no PK/schema knowledge, no session
// affinity), so groups survive any statement/file/request splitting as
// long as order is preserved — which sequential execution guarantees.
// Re-running a group is idempotent: the INSERT OR REPLACE resets the row
// (same PK), appends redo, the final statement converts once. The
// substr() scan per append is unindexed but oversized rows are rare;
// correctness over speed in a DR path.
export const MAX_STATEMENT_BYTES = 90_000;
// Text chunks: raw utf8 bytes, hex-doubled in the statement → ≤80KB.
export const CHUNK_RAW_BYTES = 40_000;
// Blob chunks: content is hex CHARS (2× raw) which the statement then
// hex-encodes again (4× raw) → 18KB raw = 72KB in-statement.
export const BLOB_CHUNK_RAW_BYTES = 18_000;

function chunkBuffer(buf, size) {
  const chunks = [];
  for (let i = 0; i < buf.length; i += size) {
    chunks.push(buf.subarray(i, i + size));
  }
  return chunks;
}

export function statementsForRow(table, row, opts = {}) {
  const maxStatement = opts.maxStatementBytes ?? MAX_STATEMENT_BYTES;
  const chunkRaw = opts.chunkRawBytes ?? CHUNK_RAW_BYTES;
  const blobChunkRaw = opts.blobChunkRawBytes ?? BLOB_CHUNK_RAW_BYTES;

  const simple = insertSql(table, row);
  if (!simple) return [];
  if (Buffer.byteLength(simple, 'utf8') <= maxStatement) return [simple];

  const columns = Object.keys(row).filter(c => IDENTIFIER.test(c));
  const sentinelBytes = opts.sentinelBytes ?? cryptoRandomBytes(16);
  // The sentinel is always a 32-hex-char TEXT value (ASCII), for blob
  // columns too — assembly is uniformly TEXT until the final convert.
  const sentinel = Buffer.from(sentinelBytes).toString('hex').toUpperCase();
  const sentinelLit = `CAST(X'${Buffer.from(sentinel, 'utf8').toString('hex').toUpperCase()}' AS TEXT)`;

  // Move the largest chunkable values out of the INSERT until it fits.
  const candidates = columns
    .map(col => {
      const value = row[col];
      if (typeof value === 'string') {
        const bytes = Buffer.byteLength(value, 'utf8');
        return bytes > 0 ? { col, kind: 'text', bytes } : null;
      }
      if (value && typeof value === 'object' && typeof value.$b64 === 'string') {
        return { col, kind: 'blob', bytes: Buffer.from(value.$b64, 'base64').length };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.bytes - a.bytes);

  const moved = new Map(); // col -> {kind, chunks: Buffer[] of TEXT-space content}
  const insertFor = () => {
    const columnSql = columns.map(c => `"${c}"`).join(', ');
    const valueSql = columns.map(c => (moved.has(c) ? sentinelLit : sqlLiteral(row[c]))).join(', ');
    return `INSERT OR REPLACE INTO "${table}" (${columnSql}) VALUES (${valueSql});`;
  };

  let insert = insertFor();
  for (const candidate of candidates) {
    if (Buffer.byteLength(insert, 'utf8') <= maxStatement) break;
    const value = row[candidate.col];
    if (candidate.kind === 'blob') {
      // TEXT-space content for a blob is its hex characters.
      const hexChars = Buffer.from(Buffer.from(value.$b64, 'base64').toString('hex').toUpperCase(), 'utf8');
      moved.set(candidate.col, { kind: 'blob', chunks: chunkBuffer(hexChars, blobChunkRaw * 2) });
    } else {
      moved.set(candidate.col, { kind: 'text', chunks: chunkBuffer(Buffer.from(String(value), 'utf8'), chunkRaw) });
    }
    insert = insertFor();
  }
  if (Buffer.byteLength(insert, 'utf8') > maxStatement) {
    throw new Error(`D1_RESTORE_STATEMENT_TOO_LARGE:${table}: row does not fit even with all chunkable values moved out — inspect the row (many medium non-string columns?)`);
  }

  const statements = [insert];
  for (const [col, m] of moved) {
    for (const chunk of m.chunks) {
      const chunkLit = `CAST(X'${chunk.toString('hex').toUpperCase()}' AS TEXT)`;
      statements.push(
        `UPDATE "${table}" SET "${col}" = "${col}" || ${chunkLit} WHERE substr("${col}", 1, 32) = ${sentinelLit};`
      );
    }
    const finalExpr = m.kind === 'blob'
      ? `unhex(substr("${col}", 33))`
      : `substr("${col}", 33)`;
    statements.push(
      `UPDATE "${table}" SET "${col}" = ${finalExpr} WHERE substr("${col}", 1, 32) = ${sentinelLit};`
    );
  }
  return statements;
}

function cryptoRandomBytes(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function* rowsFromJsonlText(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}
