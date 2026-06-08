#!/usr/bin/env node
/**
 * GA Sprint 3 Step 13 — Tauri updater pubkey enforcement.
 *
 * Reads src-tauri/tauri.conf.json and refuses the release if
 * `plugins.updater.pubkey` is the placeholder, empty, or missing.
 *
 * The pubkey is the load-bearing signature anchor for desktop auto-update;
 * shipping with the placeholder means any attacker who can intercept the
 * update channel can deliver a signed-by-anyone payload.
 *
 * Modes:
 *   - `node scripts/lint-updater-pubkey.mjs`        → exit 0/1 by content
 *   - `STRICT_UPDATER_PUBKEY=0 node scripts/...`    → warn only (dev builds)
 *
 * The release pipeline must set STRICT_UPDATER_PUBKEY=1 (or leave it
 * unset — strict is the default).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '..', 'src-tauri', 'tauri.conf.json');
const STRICT = process.env.STRICT_UPDATER_PUBKEY !== '0';

const PLACEHOLDER_PATTERNS = [
  /REPLACE_WITH/i,
  /PLACEHOLDER/i,
  /<your[-_ ]pubkey>/i,
  /TODO/i,
];

function fail(message) {
  if (STRICT) {
    console.error(`✖ updater-pubkey lint: ${message}`);
    console.error('  Resolution: set tauri.conf.json plugins.updater.pubkey to the');
    console.error('  base64-encoded ed25519 public key produced by `tauri signer generate`.');
    console.error('  Run with STRICT_UPDATER_PUBKEY=0 to downgrade this to a warning.');
    process.exit(1);
  } else {
    console.warn(`⚠ updater-pubkey lint (warn-only): ${message}`);
    process.exit(0);
  }
}

function main() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    fail(`cannot read ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    fail(`tauri.conf.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const updater = config?.plugins?.updater;
  if (!updater) {
    fail('plugins.updater block missing — updater plugin is required for GA');
    return;
  }

  if (updater.active === false) {
    console.log('updater-pubkey lint: skipped (plugins.updater.active=false)');
    return;
  }

  const pubkey = updater.pubkey;
  if (typeof pubkey !== 'string' || pubkey.trim() === '') {
    fail('plugins.updater.pubkey is missing or empty');
    return;
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(pubkey)) {
      fail(`plugins.updater.pubkey looks like a placeholder (matched /${pattern.source}/)`);
      return;
    }
  }

  /* Strict format guard.
   *
   * tauri-action's actual contract: paste the whole "Public:" string
   * from `tauri signer generate` — which IS a base64-encoded blob whose
   * decoded bytes start with the minisign header line
   * "untrusted comment: minisign public key...\n<algo+key>".
   *
   * So a valid pubkey:
   *   - is itself in the base64 alphabet (the outer encoding)
   *   - is ~152 chars long (encodes ~114 bytes of minisign block)
   *   - is NOT raw minisign text (i.e. must not contain the literal
   *     string "untrusted comment" at the OUTER level — that would
   *     mean the operator pasted the human-readable form, not the
   *     base64 form that tauri-action wants)
   *
   * We allow 60..200 chars to cover the standard ~152-char Tauri
   * envelope while still catching truncated paste-overs (< 60) and
   * accidental whole-key-file dumps (> 200, which would also fail the
   * base64 alphabet check below).
   */
  if (/(^untrusted comment|^Public:|^trusted comment|^minisign)/im.test(pubkey)) {
    fail('plugins.updater.pubkey looks like the RAW minisign/tauri-signer output — paste the base64 string from the "Public:" line, NOT the multi-line minisign text');
    return;
  }
  if (pubkey.length < 60 || pubkey.length > 200) {
    fail(`plugins.updater.pubkey has unexpected length ${pubkey.length} (expected 60..200 for a tauri-action base64 envelope)`);
    return;
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(pubkey)) {
    fail('plugins.updater.pubkey contains characters outside the base64/base64-url alphabet');
    return;
  }

  console.log(`✓ updater-pubkey lint: clean (length=${pubkey.length})`);
}

main();
