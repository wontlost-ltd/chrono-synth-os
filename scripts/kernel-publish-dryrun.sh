#!/usr/bin/env bash
# Hands-off pre-publish verification for @chrono/kernel.
# Runs all the checks from docs/release/kernel-1.0.0-runbook.md §1-§2 except npm publish.
# Exits non-zero on any failure — safe to call from CI / pre-release hook.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[1/6] forbidden-imports..."
npm run check:forbidden-imports

echo "[2/6] typecheck..."
npm run typecheck

echo "[3/6] build..."
npm run build

echo "[4/6] kernel-zero-deps contract..."
node --test --test-force-exit dist/test/contract/kernel-zero-deps.test.js

echo "[5/6] PPF v1 test vectors..."
node --test --test-force-exit dist/test/contract/ppf-v1-test-vectors.test.js

echo "[6/6] npm pack dry-run + tarball smoke install..."
cd "$ROOT/packages/kernel"

PACK_OUTPUT="$(npm pack --dry-run 2>&1)"
echo "$PACK_OUTPUT" | grep -q "LICENSE"           || { echo "FAIL: LICENSE missing from tarball"; exit 1; }
echo "$PACK_OUTPUT" | grep -q "README.md"         || { echo "FAIL: README.md missing from tarball"; exit 1; }
echo "$PACK_OUTPUT" | grep -q "dist/index.js"     || { echo "FAIL: dist/index.js missing from tarball"; exit 1; }
echo "$PACK_OUTPUT" | grep -q "dist/index.d.ts"   || { echo "FAIL: dist/index.d.ts missing from tarball"; exit 1; }
if echo "$PACK_OUTPUT" | grep -qE "\.test\.(js|ts)"; then
  echo "FAIL: test files leaked into tarball"
  exit 1
fi

# Real smoke install in a temp dir against the actual tarball.
TARBALL="$(npm pack 2>/dev/null)"
TMPDIR_DIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DIR"; rm -f "$ROOT/packages/kernel/$TARBALL"' EXIT

cd "$TMPDIR_DIR"
cat > package.json <<EOF
{
  "name": "kernel-smoke",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
EOF
npm install --silent "$ROOT/packages/kernel/$TARBALL"

node --input-type=module -e "
  import * as k from '@chrono/kernel';
  import { readFileSync } from 'node:fs';
  const exportsCount = Object.keys(k).length;
  const pkg = JSON.parse(readFileSync('node_modules/@chrono/kernel/package.json','utf8'));
  if (exportsCount < 50) { console.error('FAIL: too few exports', exportsCount); process.exit(1); }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    console.error('FAIL: kernel must have zero dependencies'); process.exit(1);
  }
  console.log('SMOKE OK: exports=' + exportsCount + ', deps=0');
" 2>&1

echo ""
echo "✅ Pre-publish dry-run passed."
echo "   Tarball: $ROOT/packages/kernel/$TARBALL"
echo "   To actually publish: cd packages/kernel && npm publish"
