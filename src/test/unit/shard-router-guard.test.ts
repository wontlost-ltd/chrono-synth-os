import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../storage/factory.js';
import { MultiShardRuntimeNotReadyError } from '../../storage/build-resolver.js';
import type { AppConfig } from '../../config/schema.js';

/** 造一个最小 config（单库缺省 + 可覆盖 db）。 */
function cfg(dbOverride: Record<string, unknown>): AppConfig {
  return { db: { driver: 'sqlite', path: ':memory:', pool: { max: 10, idleTimeoutMs: 30000 }, ...dbOverride } } as unknown as AppConfig;
}

describe('createDatabase fail-closed guard（不变量 8）', () => {
  it('无 shards → 正常建单库（零回归）', () => {
    const db = createDatabase(cfg({}));
    assert.ok(db);
    db.close();
  });

  it('任何非空 db.shards（含 1 个）→ throw 拒绝（单 shard 也拒；统一 MultiShardRuntimeNotReadyError 真源）', () => {
    assert.throws(() => createDatabase(cfg({ shards: { s1: { connectionString: 'c1' } } })), MultiShardRuntimeNotReadyError);
    assert.throws(() => createDatabase(cfg({ shards: { s1: { connectionString: 'c1' }, s2: { connectionString: 'c2' } } })), MultiShardRuntimeNotReadyError);
  });

  it('空 shards 对象 → 视为无 shards,正常建单库', () => {
    const db = createDatabase(cfg({ shards: {} }));
    assert.ok(db);
    db.close();
  });
});
