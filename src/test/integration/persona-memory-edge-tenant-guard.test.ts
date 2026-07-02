/**
 * F1（全维度评审）——persona_memory_edges 运行时 upsert 的**跨租户篡改守卫**。
 *
 * persona_memory_edges 的唯一约束是 (source, target)，不含 tenant_id/persona_id。运行时 upsert 用
 * `ON CONFLICT(source, target) DO UPDATE`，若不加守卫，租户 B 得知租户 A 的 memory node id 后，构造同
 * (source,target) 的边即可凭 ON CONFLICT **覆盖** A 的 strength/relation（跨租户数据篡改）。
 * 修复=ON CONFLICT DO UPDATE 加 WHERE 守卫：仅当既有行 tenant/persona 与本次相同才 UPDATE，否则 no-op。
 *
 * 本测**专测 ON CONFLICT 守卫 SQL 不变量**：关闭 FK（不测 FK 完整性，只测冲突守卫），直接跑 upsert 命令，
 * 用不同 tenant/persona 复现「同 (source,target) 冲突」并断言守卫拒绝跨界覆盖。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';
import { pcmemCmdUpsertEdge } from '@chrono/kernel';

describe('F1 persona_memory_edges 跨租户 upsert 守卫', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    registerCoreSelfExecutors();
    /* 本测只验 ON CONFLICT 守卫 SQL，不验 FK 完整性——关 FK 便可直接落 edge 而不必建整条 node/persona_core 链。 */
    db.exec('PRAGMA foreign_keys=OFF');
  });
  afterEach(() => db.close());

  function upsertEdge(tenantId: string, personaId: string, source: string, target: string, strength: number, relation: string): void {
    db.execute(pcmemCmdUpsertEdge({ tenantId, personaId, source, target, strength, relation }));
  }

  function readEdge(source: string, target: string): { tenant_id: string; persona_id: string; strength: number; relation: string } | undefined {
    return db.prepare<{ tenant_id: string; persona_id: string; strength: number; relation: string }>(
      'SELECT tenant_id, persona_id, strength, relation FROM persona_memory_edges WHERE source = ? AND target = ?',
    ).get(source, target);
  }

  it('★跨租户篡改守卫★：另一租户 upsert 同 (source,target) 不覆盖 tenant-a 的边', () => {
    upsertEdge('tenant-a', 'p1', 'mem_s', 'mem_t', 0.9, 'trusts');
    const before = readEdge('mem_s', 'mem_t')!;
    assert.equal(before.tenant_id, 'tenant-a');
    assert.equal(before.strength, 0.9);

    /* 攻击：tenant-b 用同 (source,target)（得知 A 的 node id）尝试覆盖 → ON CONFLICT WHERE 守卫 → no-op。 */
    upsertEdge('tenant-b', 'p1', 'mem_s', 'mem_t', 0.01, 'distrusts');

    const after = readEdge('mem_s', 'mem_t')!;
    assert.equal(after.tenant_id, 'tenant-a', '边仍属 tenant-a，未被 tenant-b 劫持');
    assert.equal(after.strength, 0.9, 'strength 未被覆盖');
    assert.equal(after.relation, 'trusts', 'relation 未被覆盖');
    const count = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM persona_memory_edges').get()!.n;
    assert.equal(count, 1, '无新增行（唯一约束冲突 + WHERE 拒绝 UPDATE）');
  });

  it('★跨 persona 守卫★：同租户不同 persona upsert 同 (source,target) 不互相覆盖', () => {
    upsertEdge('tenant-a', 'p1', 'mem_x', 'mem_y', 0.8, 'relates_to');
    upsertEdge('tenant-a', 'p2', 'mem_x', 'mem_y', 0.2, 'conflicts');
    const after = readEdge('mem_x', 'mem_y')!;
    assert.equal(after.persona_id, 'p1', '边仍属 p1');
    assert.equal(after.strength, 0.8, 'p2 未覆盖 p1');
  });

  it('★合法更新不误伤★：本人（同 tenant+persona）upsert 同 (source,target) 正常更新', () => {
    upsertEdge('tenant-a', 'p1', 'mem_u', 'mem_v', 0.5, 'relates_to');
    upsertEdge('tenant-a', 'p1', 'mem_u', 'mem_v', 0.95, 'strongly_relates');
    const after = readEdge('mem_u', 'mem_v')!;
    assert.equal(after.strength, 0.95, '本人 upsert 正常更新 strength');
    assert.equal(after.relation, 'strongly_relates', '本人 upsert 正常更新 relation');
  });
});
