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
import { PpfV1DocumentSchema } from '@chrono/contracts';

const VECTOR_DIR = resolve(process.cwd(), 'docs', 'ppf', 'v1', 'test-vectors');

const MUST_PARSE = ['minimal-valid.json'];

const MUST_REJECT = ['invalid-values-out-of-order.json'];

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
});
