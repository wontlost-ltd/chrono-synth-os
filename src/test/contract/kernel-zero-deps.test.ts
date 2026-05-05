/**
 * Contract test: @chrono/kernel must remain dependency-free.
 *
 * The kernel is the wire-compatibility layer for PPF v1 and the future
 * runtime adapters. Any external import (npm package or node:*) makes it
 * non-portable to Web Worker / RN / Tauri. This test fails the build if a
 * kernel source file imports anything beyond relative paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const KERNEL_SRC = resolve(process.cwd(), 'packages', 'kernel', 'src');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;

describe('kernel zero-dep contract', () => {
  it('every import in packages/kernel/src is relative (no external / no node:*)', () => {
    assert.ok(existsSync(KERNEL_SRC), `expected kernel src at ${KERNEL_SRC}`);
    const files = walkTs(KERNEL_SRC);
    const violations: Array<{ file: string; specifier: string }> = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = IMPORT_RE.exec(src)) !== null) {
        const spec = match[1];
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
          violations.push({ file: file.replace(`${process.cwd()}/`, ''), specifier: spec });
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `kernel must have zero external imports; found:\n${violations.map((v) => `  ${v.file} → ${v.specifier}`).join('\n')}`,
    );
  });

  it('packages/kernel/package.json declares no runtime dependencies', () => {
    const pkgPath = resolve(process.cwd(), 'packages', 'kernel', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const deps = pkg.dependencies as Record<string, string> | undefined;
    if (deps) {
      assert.deepEqual(Object.keys(deps), [], `kernel must have no runtime dependencies; found: ${Object.keys(deps).join(', ')}`);
    }
    /* peerDependencies are also forbidden — kernel is standalone */
    const peers = pkg.peerDependencies as Record<string, string> | undefined;
    if (peers) {
      assert.deepEqual(Object.keys(peers), [], `kernel must have no peerDependencies; found: ${Object.keys(peers).join(', ')}`);
    }
  });
});
