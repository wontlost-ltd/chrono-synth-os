/**
 * 端侧 kernel 运行证明（ADR-0052 Edge-P2）：kernel 领域逻辑能在非 Node、非 SQLite 的端侧
 * adapter 上确定性运行——可移植性从「架构承诺」变成「可跑 + golden replay 的证明」。
 *
 *   - 价值闭环：用端侧 host adapter 驱动真实 kernel value-service（创建/更新/删除/读回）；
 *   - golden replay：同种子 + 同脚本 → 同结果（确定性，为 WASM/MCU 回放打基础）；
 *   - 事务回滚：内存 UoW 事务失败还原；
 *   - 零-node ratchet：src/edge 全树零 `node:*` import（端侧可移植性硬约束）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  runValueClosedLoop, InMemoryValueUnitOfWork, DeterministicClock, DeterministicRandom,
} from '../../edge/index.js';
import { createValue, getAllValues } from '@chrono/kernel';

describe('端侧 kernel 运行证明（ADR-0052 Edge-P2）', () => {
  it('价值闭环：端侧 adapter 驱动真实 kernel value-service', () => {
    const r = runValueClosedLoop();
    /* 创建 3 个、删 1 个 → 剩 2 个（探索 + 联结）。 */
    assert.equal(r.values.length, 2);
    const labels = r.values.map((v) => v.label).sort();
    assert.deepEqual(labels, ['探索', '联结'].sort());
    /* 探索权重被更新为 0.55。 */
    const explore = r.values.find((v) => v.label === '探索')!;
    assert.equal(explore.weight, 0.55);
  });

  it('golden replay：同种子 + 同脚本 → 同结果 hash（确定性）', () => {
    const a = runValueClosedLoop();
    const b = runValueClosedLoop();
    assert.equal(a.hash, b.hash, '端侧 kernel 运行必须确定可回放');
    assert.deepEqual(a.values, b.values);
  });

  it('确定性 host：同种子 random 产相同 id 序列', () => {
    const r1 = new DeterministicRandom('edge');
    const r2 = new DeterministicRandom('edge');
    const ids1 = [r1.uuid('val'), r1.uuid('val'), r1.uuid()];
    const ids2 = [r2.uuid('val'), r2.uuid('val'), r2.uuid()];
    assert.deepEqual(ids1, ids2);
    assert.match(ids1[0], /^val_edge-0000000/);
  });

  it('确定性 clock：单调递增 + 可 reset', () => {
    const c = new DeterministicClock(1000, 500);
    assert.equal(c.now(), 1000);
    assert.equal(c.now(), 1500);
    c.reset(1000);
    assert.equal(c.now(), 1000);
  });

  it('内存 UoW 事务：失败回滚还原', () => {
    const tx = new InMemoryValueUnitOfWork();
    const clock = new DeterministicClock();
    const random = new DeterministicRandom();
    createValue(tx, clock, random, '基线', 0.5);
    const before = tx.snapshotHash();

    assert.throws(() => {
      tx.transaction(() => {
        createValue(tx, clock, random, '临时', 0.5);
        throw new Error('boom');
      });
    });
    /* 回滚后状态还原（临时价值不存在）。 */
    assert.equal(tx.snapshotHash(), before);
    assert.equal(getAllValues(tx).size, 1);
  });

  it('零-node ratchet：src/edge 全树零 node:* import（端侧可移植硬约束）', () => {
    const EDGE_ROOT = resolve(process.cwd(), 'src', 'edge');
    const files = walkTs(EDGE_ROOT);
    assert.ok(files.length > 0, 'sanity: 应扫到 edge 源文件');

    const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        if (m[1].startsWith('node:')) {
          violations.push({ file: file.replace(`${process.cwd()}/`, ''), spec: m[1] });
        }
      }
    }
    assert.deepEqual(
      violations, [],
      `src/edge 必须零 node:* import（否则不可移植到 Web Worker/RN/Tauri）：\n` +
      violations.map((v) => `  ${v.file} → ${v.spec}`).join('\n'),
    );
  });
});

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
