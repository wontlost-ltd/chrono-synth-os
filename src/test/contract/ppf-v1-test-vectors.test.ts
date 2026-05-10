/**
 * Contract test: PPF v1 schema must accept the canonical test vectors and
 * reject the deliberately malformed ones.
 *
 * Vectors live in docs/ppf/v1/test-vectors/. Adding a new file there requires
 * adding it to one of the two arrays below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PpfV1DocumentSchema, canonicalize, documentChecksum } from '@chrono/contracts';

const VECTOR_DIR = resolve(process.cwd(), 'docs', 'ppf', 'v1', 'test-vectors');

const MUST_PARSE = ['minimal-valid.json'];

const MUST_REJECT = ['invalid-values-out-of-order.json'];

/**
 * Cross-impl checksum pin (EP-4.1).
 *
 * Computed by the Python reference implementation at
 * ``reference-impls/python/`` over the *same* vector bytes. If the TS
 * canonicalizer drifts, this assertion fails before anyone ships a
 * broken kernel release.
 */
const MINIMAL_VALID_CHECKSUM =
  'sha256:0x082d2793c3d6366750be45fb0fea7f4129836743cb8bbe9ed813064d967da680';

function loadVector(name: string): unknown {
  return JSON.parse(readFileSync(resolve(VECTOR_DIR, name), 'utf8'));
}

describe('PPF v1 test vectors', () => {
  for (const name of MUST_PARSE) {
    it(`accepts ${name}`, () => {
      const doc = loadVector(name);
      const result = PpfV1DocumentSchema.safeParse(doc);
      assert.equal(
        result.success,
        true,
        result.success ? '' : `expected ${name} to parse, got: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    });
  }

  for (const name of MUST_REJECT) {
    it(`rejects ${name}`, () => {
      const doc = loadVector(name);
      const result = PpfV1DocumentSchema.safeParse(doc);
      assert.equal(result.success, false, `expected ${name} to fail validation but it passed`);
    });
  }

  it('canonicalize is deterministic round-trip', () => {
    const doc = loadVector('minimal-valid.json');
    const first = canonicalize(doc);
    const second = canonicalize(JSON.parse(first));
    assert.equal(first, second);
  });

  it('documentChecksum matches the Python reference impl', async () => {
    const doc = PpfV1DocumentSchema.parse(loadVector('minimal-valid.json'));
    const hash = await documentChecksum(doc);
    assert.equal(
      hash,
      MINIMAL_VALID_CHECKSUM,
      'TS canonicalizer drifted from Python reference — keep both in sync or update both',
    );
  });
});
