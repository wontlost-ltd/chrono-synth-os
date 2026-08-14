/**
 * DualWriteFlushWorker 多-shard 分片探针（分片 Phase 0 · Plan 2 · Task 2 —— outbox fan-out + ledger 亲和性）。
 *
 * persona_core_ledger_outbox 是 per-shard 表：每个 shard 各自积压待落 ledger 的事件。旧 worker 只对一个
 * 中心 db 构造一个 SqliteEventLedger 并 flush 一次——多 shard 部署下：
 *   ① 非-home shard 的 outbox 永不被 drain（事件永远卡在 outbox，ledger 缺失）；
 *   ② 若强行复用同一个中心 ledger 去 flush 别的 shard 的 outbox，会把 A shard 的 outbox 行写进
 *      **中心 ledger 库**——跨 shard 串写（数据落错 shard，违分片铁律）。
 *
 * 本 task 的唯一核心正确性：**flush 循环内、每个 shard 现构造 `new SqliteEventLedger(shardDb)`**，令
 * 「outbox 源库」与「ledger 目标库」恒为同一个 shardDb——绝不跨 shard 串写。用 FakeMultiShardResolver 注
 * 2 个独立物理 db，锚定 3 条命脉：
 *   ① ledger 无串写（核心锚）：s0 的 outbox 只落 s0 的 event_ledger、s1 只落 s1；s1 ledger 不含 s0 事件、
 *      反之亦然；totalFlushed=两 shard 之和。
 *   ② fan-out：两 shard 的 outbox 都被 drain（只跑 home 则非-home shard 会漏——聚合计数证真 fan-out）。
 *   ③ per-shard 隔离：坏 shard（throwingDb prepare 抛）记 shardErrors、好 shard 仍 flush（不整体崩）。
 *
 * 单库下 dbForTenant/coordinatorDb/allShardDbs 是同一 db，「跨 shard 串写」与「非-home 漏 drain」都测不
 * 出来——多 shard 布置是唯一能让「复用中心 ledger」与「循环内构造 per-shard ledger」产生可观测差异的手段。
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { personaCoreDualWrite } from '../../data-plane/persona-core-dual-write.js';
import { DualWriteFlushWorker } from '../../workers/dual-write-flush-worker.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { throwingDb } from '../support/throwing-db.js';
import { SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 persona_core_ledger_outbox + event_ledger 表的内存 db（迁移入口——一个 db=一个 shard）。 */
function shardDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 在给定 shard db 上积压一条待落 ledger 的 outbox 事件（enqueue 到该 shard 的 persona_core_ledger_outbox）。 */
function seedOutbox(db: IDatabase, tenantId: string, streamId: string, commandId: string): void {
  personaCoreDualWrite.enqueuePersonaEvent(
    db,
    tenantId,
    streamId,
    'persona.created',
    commandId,
    JSON.stringify({ stream: streamId }),
  );
}

/** 读某 shard db 的 event_ledger 里所有 stream_id（用来断言事件落对/没落错 shard）。 */
function ledgerStreamIds(db: IDatabase): string[] {
  return db
    .prepare<{ stream_id: string }>('SELECT stream_id FROM event_ledger ORDER BY stream_id ASC')
    .all()
    .map((r) => r.stream_id);
}

/** 读某 shard db 的 persona_core_ledger_outbox 剩余行数（flush 成功即删）。 */
function outboxCount(db: IDatabase): number {
  return db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_core_ledger_outbox').get()!.c;
}

describe('DualWriteFlushWorker 分片探针（outbox fan-out + ledger 亲和性防串写）', () => {
  let s0: IDatabase;
  let s1: IDatabase;

  beforeEach(() => {
    s0 = shardDb();
    s1 = shardDb();
  });

  it('① ledger 无串写（核心锚）：s0 的 outbox 只落 s0 的 ledger、s1 只落 s1；totalFlushed=两 shard 之和', async () => {
    seedOutbox(s0, 'tenant_a', 'persona:a', 'cmd-a');
    seedOutbox(s1, 'tenant_b', 'persona:b', 'cmd-b');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const worker = new DualWriteFlushWorker({ resolver, logger: new SilentLogger() });

    const result = await worker.flush();

    /* 两 shard 各 1 条，totalFlushed=之和。 */
    assert.equal(result.totalFlushed, 2, '两 shard outbox 之和');
    assert.equal(result.totalFailed, 0);
    assert.equal(result.shardErrors.length, 0);
    /* 核心锚：s0 的事件只落 s0 的 ledger（不含 s1 的 persona:b）。 */
    assert.deepEqual(ledgerStreamIds(s0), ['persona:a'], 's0 ledger 只含 s0 的事件（无 s1 串入）');
    /* 核心锚：s1 的事件只落 s1 的 ledger（不含 s0 的 persona:a）——防跨 shard 串写。 */
    assert.deepEqual(ledgerStreamIds(s1), ['persona:b'], 's1 ledger 只含 s1 的事件（无 s0 串入）');
    /* 两 shard 的 outbox 都被 drain（flush 成功即删行）。 */
    assert.equal(outboxCount(s0), 0, 's0 outbox 已 drain');
    assert.equal(outboxCount(s1), 0, 's1 outbox 已 drain');
  });

  it('② fan-out：两 shard 的 outbox 都被 drain（只跑 home 则非-home shard 会漏 — 聚合计数证真 fan-out）', async () => {
    /* s0 积 2 条、s1 积 3 条——只跑 home（s0）则 totalFlushed=2 会漏 s1 的 3。 */
    seedOutbox(s0, 'tenant_a', 'persona:a1', 'cmd-a1');
    seedOutbox(s0, 'tenant_a', 'persona:a2', 'cmd-a2');
    seedOutbox(s1, 'tenant_b', 'persona:b1', 'cmd-b1');
    seedOutbox(s1, 'tenant_b', 'persona:b2', 'cmd-b2');
    seedOutbox(s1, 'tenant_b', 'persona:b3', 'cmd-b3');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const worker = new DualWriteFlushWorker({ resolver, logger: new SilentLogger() });

    const result = await worker.flush();

    /* fan-out：2+3=5 全被 flush（非只 home 的 2）。 */
    assert.equal(result.totalFlushed, 5, '两 shard outbox 全 drain（fan-out，非只 home）');
    assert.equal(result.totalFailed, 0);
    assert.equal(outboxCount(s0), 0);
    assert.equal(outboxCount(s1), 0, 's1（非-home）也被 drain（只跑 home 则漏）');
    assert.equal(ledgerStreamIds(s1).length, 3, 's1 的 3 事件都落 s1 ledger');
  });

  it('③ per-shard 隔离：坏 shard（prepare 抛）记 shardErrors、好 shard 仍 flush（不整体崩）', async () => {
    seedOutbox(s0, 'tenant_a', 'persona:a', 'cmd-a');
    /* flushOutbox 首行 db.prepare(SELECT pending).all() → prepare 抛 → 进 shard catch。 */
    const bad = throwingDb({ on: 'prepare' });
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: bad },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const logger = new SilentLogger();
    const worker = new DualWriteFlushWorker({ resolver, logger });

    const result = await worker.flush();

    /* 坏 shard 记 shardErrors（shard#1，keyer 按首见顺序：s0=shard#0、bad=shard#1）。 */
    assert.equal(result.shardErrors.length, 1);
    assert.equal(result.shardErrors[0]!.shardKey, 'shard#1');
    assert.match(result.shardErrors[0]!.error, /boom/);
    /* shardErrors.error 是 message string（非 Error 对象）。 */
    assert.equal(typeof result.shardErrors[0]!.error, 'string');
    /* 好 shard 仍 flush（隔离：坏 shard 不拖累好 shard、不整体崩）。 */
    assert.equal(result.totalFlushed, 1, 's0 仍 flush');
    assert.deepEqual(ledgerStreamIds(s0), ['persona:a'], 's0 事件仍落 s0 ledger');
    assert.equal(outboxCount(s0), 0, 's0 outbox 已 drain');
    /* logger.error（强制告警，防坏 shard 静默漏 drain）。 */
    assert.ok(logger.entries.some((e) => e.level === 'error'), '坏 shard 记 error 级日志');
  });
});
