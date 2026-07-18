import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a64, shardIdForTenant } from '../../storage/shard-hash.js';

describe('shard-hash（确定性模哈希路由）', () => {
  it('fnv1a64 确定性：同串恒同值', () => {
    assert.equal(fnv1a64('tenant_abc'), fnv1a64('tenant_abc'));
    assert.notEqual(fnv1a64('a'), fnv1a64('b'));
  });

  it('fnv1a64 golden vector（锁定 charCodeAt UTF-16 语义，防漂移）', () => {
    /* 与 #311 decision-style-perturbation hashSeed 同算法（offset 0xcbf29ce484222325, prime 0x100000001b3, 64 位掩码）。 */
    /* ASCII */
    assert.equal(fnv1a64(''), 0xcbf29ce484222325n, '空串=offset basis');
    assert.equal(fnv1a64('a'), 0xaf63dc4c8601ec8cn, "'a' 的 FNV-1a 64");
    /* golden 值由实现首次运行锁定（BMP 中文/代理对 emoji），任何算法改动都会红。 */
    assert.equal(fnv1a64('租户'), 14289518132694369051n, "'租户'（BMP 中文）的 FNV-1a 64");
    assert.equal(fnv1a64('😀'), 16565464328977483992n, "'😀'（UTF-16 代理对）的 FNV-1a 64");
  });

  it('shardIdForTenant 确定性 + 排序稳定（config key 顺序变不影响）', () => {
    const ids = ['s1', 's2', 's3'];
    const t = 'tenant_x';
    const a = shardIdForTenant(t, ids);
    const b = shardIdForTenant(t, ['s3', 's1', 's2']);  // 顺序打乱
    assert.equal(a, b, '内部排序后取模,顺序无关');
    assert.ok(ids.includes(a));
  });

  it('shardIdForTenant 单 shard 恒返回该 shard', () => {
    assert.equal(shardIdForTenant('anything', ['only']), 'only');
  });
});
