#!/usr/bin/env node
/**
 * Smoke test for scripts/lint-updater-pubkey.mjs.
 *
 * Runs the lint in a child process against synthetic tauri.conf.json
 * variants written to a tmpdir. Asserts:
 *   - real-looking ed25519 base64 key → exit 0
 *   - placeholder REPLACE_WITH_* → exit 1
 *   - labeled minisign output (`untrusted comment:` etc) → exit 1
 *   - too-short pubkey → exit 1
 *   - empty pubkey → exit 1
 *   - inactive updater block → exit 0 (skip)
 *
 * Run with: node scripts/lint-updater-pubkey.test.mjs
 * Exit 0 on success.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT_SRC = join(__dirname, 'lint-updater-pubkey.mjs');

/* Mirrors the actual `tauri signer generate` output shape: a ~152-char
 * base64 string that decodes to a minisign block. We use a synthetic
 * blob of the right length (Buffer of 114 bytes base64-encoded). */
const REAL_LOOKING_PUBKEY = Buffer.from(
  'untrusted comment: minisign public key SYNTHETIC\nRWQ' + 'A'.repeat(60),
).toString('base64');

let failures = 0;
const createdTmpdirs = [];

function cleanup() {
  for (const dir of createdTmpdirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch { /* best-effort cleanup */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function run(pubkey, opts = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'chrono-pubkey-lint-'));
  createdTmpdirs.push(tmp);
  mkdirSync(join(tmp, 'src-tauri'), { recursive: true });
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  cpSync(LINT_SCRIPT_SRC, join(tmp, 'scripts', 'lint-updater-pubkey.mjs'));
  const config = {
    plugins: {
      updater: {
        active: opts.inactive ? false : true,
        endpoints: ['https://example.test'],
        ...(pubkey === undefined ? {} : { pubkey }),
      },
    },
  };
  writeFileSync(join(tmp, 'src-tauri', 'tauri.conf.json'), JSON.stringify(config, null, 2));

  const result = spawnSync('node', ['scripts/lint-updater-pubkey.mjs'], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, STRICT_UPDATER_PUBKEY: '1' },
  });
  return { exit: result.status };
}

function expectExit(name, expected, actual) {
  if (expected === actual) {
    console.log(`✓ ${name} (exit=${actual})`);
  } else {
    failures += 1;
    console.error(`✖ ${name} — expected exit=${expected}, got ${actual}`);
  }
}

expectExit('accepts real-looking base64 ed25519 pubkey', 0, run(REAL_LOOKING_PUBKEY).exit);
expectExit('rejects REPLACE_WITH placeholder', 1, run('REPLACE_WITH_TAURI_UPDATER_PUBKEY_AT_RELEASE_TIME').exit);
expectExit('rejects TODO placeholder', 1, run('TODO_set_at_release_time_xxxxxxxxxxxxxxxxxxxx').exit);
expectExit('rejects labeled minisign blob', 1, run(`untrusted comment: minisign public key\n${REAL_LOOKING_PUBKEY}`).exit);
expectExit('rejects "Public:" prefixed key', 1, run(`Public:${REAL_LOOKING_PUBKEY}`).exit);
expectExit('rejects too-short pubkey', 1, run('abc123').exit);
expectExit('rejects empty pubkey', 1, run('').exit);
expectExit('rejects missing pubkey field', 1, run(undefined).exit);
expectExit('skips when updater.active=false', 0, run('irrelevant', { inactive: true }).exit);
expectExit('rejects non-base64 characters', 1, run('this has spaces and ! marks ' + REAL_LOOKING_PUBKEY).exit);

if (failures > 0) {
  console.error(`\n✖ ${failures} test(s) failed`);
  process.exit(1);
}
console.log('\n✓ all pubkey lint tests passed');
