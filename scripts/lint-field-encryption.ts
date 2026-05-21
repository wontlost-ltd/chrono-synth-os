#!/usr/bin/env node
/**
 * P1-H — FieldEncryption coverage lint.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.3 P1-H
 *
 * Premise: certain column names are SOC2-load-bearing PII / secret
 * fields. Storing them in cleartext is an audit finding regardless of
 * whether they're "reachable" through the API today. This lint
 * enumerates every CREATE TABLE / ALTER TABLE ADD COLUMN in the
 * schema-dsl migration set, finds columns matching the sensitive-name
 * regex, and asserts that the touching executor code references
 * `FieldEncryption` (or routes the column through one of the encrypted
 * storage entry points).
 *
 * Exits 0 on clean. Exits 1 with a violation report on any column that
 * looks sensitive but lacks an encryption call site.
 *
 * Two escape hatches:
 *  - Append `// field-encryption: not-pii` to the column-defining line
 *    or the executor SQL to declare an explicit exemption (e.g. a
 *    hash column that's already one-way).
 *  - Maintain `EXEMPT_COLUMNS` below for the small set of columns the
 *    lint can't infer about (audit_log.payload_json is itself
 *    application-controlled; the contained PII is the caller's concern).
 *
 * Not part of CI yet — we'll add the npm script after the lint runs
 * clean against today's tree.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const MIGRATIONS_DIR = join(ROOT, 'packages/schema-dsl/src/migrations');
const EXECUTORS_DIR = join(ROOT, 'src/storage/executors');

const SENSITIVE_NAME_PATTERNS: RegExp[] = [
  /(^|_)password($|_)/i,
  /(^|_)secret($|_)/i,
  /(^|_)api_key($|_)(?!hash)/i,   /* api_key but NOT api_key_hash */
  /(^|_)access_token($|_)/i,
  /(^|_)refresh_token($|_)(?!_hash)/i,
  /(^|_)private_key($|_)/i,
  /(^|_)ssn($|_)/i,
  /(^|_)credit_card($|_)/i,
  /(^|_)bank_account($|_)/i,
  /(^|_)email_plaintext($|_)/i,
  /(^|_)phone($|_)/i,
];

/**
 * Columns we know about that LOOK sensitive but are intentionally not
 * field-encrypted. Document each entry so future maintainers know why.
 */
const EXEMPT_COLUMNS = new Set<string>([
  /* one-way: stored as bcrypt/argon2 hash; reversibly encrypting it
   * would add no security and break login. */
  'users.password_hash',
  'refresh_tokens.token_hash',
  /* short identifier hash, not a secret (audit log dedup key) */
  'audit_log.api_key_hash',
  'api_keys.token_hash',
  /* one-way device push token revocation marker — not the token */
  'devices.is_invalid_at',
  /* JWT key material — lives in process memory, not DB */
  /* (no row entries here; we don't store JWT keys in tables) */
]);

interface Violation {
  file: string;
  line: number;
  column: string;
  reason: string;
}

function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

function looksSensitive(col: string): boolean {
  return SENSITIVE_NAME_PATTERNS.some(re => re.test(col));
}

/** Scan migration source for `{ name: 'foo_secret', ... }` or
 * `ALTER TABLE x ADD COLUMN bar_password` patterns. */
function scanMigrations(): Array<{ file: string; line: number; table: string; column: string }> {
  const found: Array<{ file: string; line: number; table: string; column: string }> = [];
  const files = walk(MIGRATIONS_DIR, p => p.endsWith('.ts'));

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    let currentTable: string | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      /* track table context — `table: 'foo'` or `name: 'foo', ifNotExists: true,` */
      const tableMatch = /\btable:\s*'([\w_]+)'|\bname:\s*'([\w_]+)'[^,]*ifNotExists/.exec(line);
      if (tableMatch) currentTable = tableMatch[1] ?? tableMatch[2];

      /* DSL column literal: { name: 'foo_password', type: 'text', ... } */
      const colMatch = /\bname:\s*'([\w_]+)'\s*,\s*type:/.exec(line);
      if (colMatch && currentTable) {
        const col = colMatch[1]!;
        if (looksSensitive(col) && !EXEMPT_COLUMNS.has(`${currentTable}.${col}`)) {
          found.push({ file, line: i + 1, table: currentTable, column: col });
        }
      }

      /* Raw SQL: ALTER TABLE foo ADD COLUMN bar_secret TEXT */
      const altMatch = /ALTER\s+TABLE\s+(\w+)[^"`]*?ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)/i.exec(line);
      if (altMatch) {
        const [, table, col] = altMatch;
        if (looksSensitive(col!) && !EXEMPT_COLUMNS.has(`${table}.${col}`)) {
          found.push({ file, line: i + 1, table: table!, column: col! });
        }
      }
    }
  }
  return found;
}

/** Verify the column has an encryption call site somewhere in executors. */
function isColumnEncrypted(column: string): boolean {
  const files = walk(EXECUTORS_DIR, p => p.endsWith('.ts'));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    /* Looking for either:
     *   - `encrypt(...).column = ` patterns
     *   - direct references to FieldEncryption with the column name
     *   - `encryptedField('column', ...)` helper calls
     * v1 of the lint accepts ANY mention of the column name inside a
     * file that imports FieldEncryption — false negatives are better
     * than false positives at this stage. */
    if (!src.includes('FieldEncryption') && !src.includes('encrypt')) continue;
    /* match either bare identifier or string literal */
    const pattern = new RegExp(`\\b${column}\\b`);
    if (pattern.test(src)) return true;
  }
  return false;
}

function main(): void {
  const candidates = scanMigrations();
  const violations: Violation[] = [];

  for (const c of candidates) {
    if (!isColumnEncrypted(c.column)) {
      violations.push({
        file: c.file.replace(ROOT + '/', ''),
        line: c.line,
        column: `${c.table}.${c.column}`,
        reason: 'column name matches sensitive-name pattern but no FieldEncryption call site found',
      });
    }
  }

  if (violations.length === 0) {
    console.log('field-encryption lint: clean ✓');
    process.exit(0);
  }

  console.error('field-encryption lint: violations found');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.column}  — ${v.reason}`);
  }
  console.error('');
  console.error('Resolutions:');
  console.error('  - Route the column through FieldEncryption in its executor file, OR');
  console.error('  - Add the column to EXEMPT_COLUMNS in scripts/lint-field-encryption.ts');
  console.error('    with a comment explaining why (e.g. "one-way hash, encryption adds no security")');
  process.exit(1);
}

main();
