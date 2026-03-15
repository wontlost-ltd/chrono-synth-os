import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CopyMessageId } from '../src/copy/copy-dictionary.js';
import { zhCNCatalog } from '../src/copy/copy-dictionary.js';

describe('CopyDictionary', () => {
  it('zhCNCatalog covers all CopyMessageId values', () => {
    const expectedIds: CopyMessageId[] = [
      'sync.unconfigured',
      'sync.disabled',
      'sync.idle',
      'sync.pulling',
      'sync.merging',
      'sync.pushing',
      'sync.paused',
      'sync.offline',
      'sync.conflicted',
      'sync.error',
      'portability.export_started',
      'portability.export_completed',
      'portability.export_failed',
      'portability.export_partial',
      'portability.import_dryrun',
      'portability.import_completed',
      'portability.import_failed',
      'portability.import_blocked',
      'conflict.empty_state',
      'conflict.blocking',
      'conflict.warning',
    ];
    for (const id of expectedIds) {
      assert.ok(zhCNCatalog[id], `missing translation for ${id}`);
      assert.equal(typeof zhCNCatalog[id], 'string');
    }
  });

  it('zhCNCatalog has no extra keys beyond CopyMessageId', () => {
    const keys = Object.keys(zhCNCatalog);
    assert.equal(keys.length, 21);
  });

  it('all values are non-empty strings', () => {
    for (const [id, text] of Object.entries(zhCNCatalog)) {
      assert.ok(text.length > 0, `empty text for ${id}`);
    }
  });

  it('template variables use ICU {name} syntax', () => {
    const withParams = Object.entries(zhCNCatalog).filter(([, v]) => v.includes('{'));
    for (const [id, text] of withParams) {
      assert.match(text, /\{[a-zA-Z_]+\}/, `invalid template syntax in ${id}: ${text}`);
    }
  });
});
