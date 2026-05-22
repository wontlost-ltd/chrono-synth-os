/**
 * Release manifest v1 契约测试 — 锁定 fixture 与 schema 边界。
 *
 * 该契约在 chrono-synth-os 与 chrono-synth-deploy 之间共享，任何
 * 字段改动都必须破坏本测试，以便消费方主动评估兼容性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReleaseManifestV1Schema } from '@chrono/contracts';

function readValidFixture(): unknown {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'packages', 'contracts', 'src', 'release', '__fixtures__', 'release-manifest.valid.json'),
    'utf8',
  )) as unknown;
}

function invalidPaths(value: unknown): string[] {
  const result = ReleaseManifestV1Schema.safeParse(value);
  assert.equal(result.success, false);
  if (result.success) return [];
  return result.error.issues.map(issue => issue.path.join('.'));
}

describe('ReleaseManifestV1Schema', () => {
  it('round-trips a valid release manifest fixture', () => {
    const fixture = readValidFixture();
    const parsed = ReleaseManifestV1Schema.parse(fixture);
    assert.deepEqual(parsed, fixture);
  });

  it('rejects an artifact with an invalid digest', () => {
    const manifest = ReleaseManifestV1Schema.parse(readValidFixture());
    const first = manifest.artifacts[0];
    assert.ok(first, 'fixture must have at least one artifact');
    manifest.artifacts[0] = { ...first, digest: 'sha256:not-a-valid-digest' };
    assert.ok(invalidPaths(manifest).includes('artifacts.0.digest'));
  });

  it('rejects a manifest without artifacts', () => {
    const manifest = ReleaseManifestV1Schema.parse(readValidFixture());
    const invalidManifest: unknown = { ...manifest, artifacts: [] };
    assert.deepEqual(invalidPaths(invalidManifest), ['artifacts']);
  });

  it('rejects a manifest with the wrong manifestVersion', () => {
    const manifest = ReleaseManifestV1Schema.parse(readValidFixture());
    const invalidManifest: unknown = { ...manifest, manifestVersion: 'v2' };
    assert.deepEqual(invalidPaths(invalidManifest), ['manifestVersion']);
  });

  it('rejects unknown top-level keys (strict mode)', () => {
    const manifest = ReleaseManifestV1Schema.parse(readValidFixture());
    const invalidManifest: unknown = { ...manifest, unexpectedField: true };
    const paths = invalidPaths(invalidManifest);
    assert.ok(paths.includes('unexpectedField') || paths.includes(''));
  });

  it('rejects a non-uuid releaseId', () => {
    const manifest = ReleaseManifestV1Schema.parse(readValidFixture());
    const invalidManifest: unknown = { ...manifest, releaseId: 'not-a-uuid' };
    assert.deepEqual(invalidPaths(invalidManifest), ['releaseId']);
  });

  it('rejects a manifest whose signatures do not cover any container digest', () => {
    const manifest = ReleaseManifestV1Schema.parse(readValidFixture());
    const tampered: unknown = {
      ...manifest,
      signatures: manifest.signatures.map(signature => ({
        ...signature,
        subject: 'ghcr.io/wontlost/chrono-synth-os@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      })),
    };
    const result = ReleaseManifestV1Schema.safeParse(tampered);
    assert.equal(result.success, false);
    assert.ok(!result.success && result.error.issues.some(issue =>
      issue.message.includes('container artifact digest'),
    ));
  });

  it('accepts a manifest with no container artifacts (e.g. binary-only releases)', () => {
    const fixture = readValidFixture() as {
      artifacts: Array<{ name: string; kind: string; digest: string; size: number }>;
    };
    const binaryArtifact = {
      name: 'chrono-synth-cli',
      kind: 'binary' as const,
      digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      size: 8388608,
    };
    const binaryOnly = {
      ...fixture,
      artifacts: [
        ...fixture.artifacts.filter(artifact => artifact.kind !== 'container'),
        binaryArtifact,
      ],
    };
    /* 无 container → container-binding 约束不触发 */
    const parsed = ReleaseManifestV1Schema.parse(binaryOnly);
    assert.equal(parsed.artifacts.some(a => a.kind === 'container'), false);
  });
});
