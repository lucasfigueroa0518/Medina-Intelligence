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
// The group assembles oversized values as PURE-ASCII HEX TEXT — for
// text values too, not only blobs. Three platform semantics forced this
// exact shape, each caught by a live drill or audit round:
//   - SQLite's || casts BLOB operands to TEXT (round 3 drill): so
//     assembly must be TEXT-typed throughout.
//   - SQLite's TEXT substr() char-scan is NUL-guarded (round 3 audit,
//     Finding 1): raw-byte text assembly silently truncated values
//     containing U+0000 at the final strip. Hex chars can never
//     contain NUL, so the guard is unreachable.
//   - Column affinity coerces numeric-LOOKING text (round 3 audit,
//     Finding 2): the sentinel starts with a literal 'G' — not a hex
//     digit, not 'E', not a sign — so neither the sentinel nor any
//     sentinel-prefixed assembly state can ever look numeric.
//
// Group shape:
//   1. INSERT OR REPLACE with each oversized value replaced by a random
//      per-row sentinel: 'G' + 31 hex chars (TEXT, never numeric-like),
//   2. one UPDATE per chunk appending the value's HEX CHARACTERS as
//      TEXT, keyed on `substr(col, 1, 32) = <sentinel>`,
//   3. a final UPDATE stripping the sentinel and converting:
//      `unhex(substr(col, 33))` for blobs,
//      `CAST(unhex(substr(col, 33)) AS TEXT)` for text — byte-exact
//      including embedded NULs, exactly like the single-statement
//      CAST(X'…' AS TEXT) path. unhex needs SQLite ≥3.41 (D1, workerd,
//      and node:sqlite all ship newer).
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
// Chunks are sized in RAW bytes; in-statement cost is 4× raw (hex chars
// of the content, hex-encoded again into the CAST literal):
// 18KB raw → 72KB in-statement, under the 90KB cap with headroom.
export const CHUNK_RAW_BYTES = 18_000;

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

  const simple = insertSql(table, row);
  if (!simple) return [];
  if (Buffer.byteLength(simple, 'utf8') <= maxStatement) return [simple];

  const columns = Object.keys(row).filter(c => IDENTIFIER.test(c));
  const sentinelBytes = opts.sentinelBytes ?? cryptoRandomBytes(16);
  // 'G' + 31 hex chars: structurally non-numeric (round 3, Finding 2 —
  // an all-digit sentinel coerced to REAL under numeric column affinity
  // and killed the group's predicates), still ~124 bits of entropy.
  const sentinel = `G${Buffer.from(sentinelBytes).toString('hex').toUpperCase().slice(0, 31)}`;
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

  // col -> {kind, chunks: hex-char Buffers}. Assembly content is the
  // value's HEX CHARACTERS for text and blob alike — pure ASCII, so no
  // NUL can ever enter the in-flight TEXT value (round 3, Finding 1).
  const moved = new Map();
  const insertFor = () => {
    const columnSql = columns.map(c => `"${c}"`).join(', ');
    const valueSql = columns.map(c => (moved.has(c) ? sentinelLit : sqlLiteral(row[c]))).join(', ');
    return `INSERT OR REPLACE INTO "${table}" (${columnSql}) VALUES (${valueSql});`;
  };

  let insert = insertFor();
  for (const candidate of candidates) {
    if (Buffer.byteLength(insert, 'utf8') <= maxStatement) break;
    const value = row[candidate.col];
    const raw = candidate.kind === 'blob'
      ? Buffer.from(value.$b64, 'base64')
      : Buffer.from(String(value), 'utf8');
    const hexChars = Buffer.from(raw.toString('hex').toUpperCase(), 'utf8');
    moved.set(candidate.col, { kind: candidate.kind, chunks: chunkBuffer(hexChars, chunkRaw * 2) });
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
    // unhex → raw bytes; text columns cast the bytes back to TEXT —
    // byte-exact including embedded NULs, matching the single-statement
    // CAST(X'…' AS TEXT) path.
    const finalExpr = m.kind === 'blob'
      ? `unhex(substr("${col}", 33))`
      : `CAST(unhex(substr("${col}", 33)) AS TEXT)`;
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
