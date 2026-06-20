import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VERSION_MAP } from '../src/version-map.js';

describe('VERSION_MAP', () => {
  it('covers every postgres migration version', () => {
    assert.deepEqual(
      versionsFor('postgres'),
      range('v', 1, 97),
    );
  });

  it('covers every sqlite SQL migration version', () => {
    assert.deepEqual(
      versionsFor('sqlite-sql'),
      range('v', 1, 95),
    );
  });

  it('has unique canonical names', () => {
    const names = VERSION_MAP.map(entry => entry.canonical);
    assert.equal(new Set(names).size, names.length);
  });

  it('does not assign sqlite SQL aliases to pg-only entries', () => {
    for (const entry of VERSION_MAP.filter(item => item.classification === 'pg-only')) {
      assert.equal(entry.aliases['sqlite-sql'], undefined, entry.canonical);
    }
  });

  it('classifies disabled entries explicitly', () => {
    const disabled = VERSION_MAP.filter(entry => entry.canonical === 'v072_pg' || entry.aliases.postgres === 'v072');
    assert.deepEqual(disabled.map(entry => entry.classification), ['disabled']);
  });
});

function versionsFor(target: 'postgres' | 'sqlite-sql'): readonly string[] {
  return VERSION_MAP
    .map(entry => entry.aliases[target])
    .filter((version): version is string => Boolean(version))
    .sort();
}

function range(prefix: string, start: number, end: number): readonly string[] {
  return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${String(start + index).padStart(3, '0')}`);
}
