// Shared primitives for replaying JSONL D1 snapshots (maintenance
// snapshots and full backups share the format: one JSON object per
// line, one file per table part, restored with INSERT OR REPLACE).
//
// Used by scripts/restore-d1-backup.mjs and unit-tested by
// tests/d1-backup.test.ts (the round-trip proof applies these exact
// statements to a real SQLite database).

// BLOB columns are backed up as tagged base64 objects ({ $b64: "..." })
// because D1 returns them as ArrayBuffer and raw JSON would corrupt
// them. They restore as X'..' blob literals.
export function sqlLiteral(value) {
  if (value === null || typeof value === 'undefined') return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') {
    if (typeof value.$b64 === 'string') return `X'${base64ToHex(value.$b64)}'`;
    // Unknown object shape — store its JSON text rather than
    // '[object Object]'. Backups themselves never produce this.
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
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

export function* rowsFromJsonlText(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}
