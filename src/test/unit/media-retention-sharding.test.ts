/**
 * MediaRetentionWorker 多-shard 分片探针（分片 Phase 0 · Plan 2 · Task 1 —— GDPR fan-out + 健康状态机）。
 *
 * runMediaRetention 只扫「当前 tx」的过期媒体引用；多 shard 部署下若 worker 只跑一个库，其余 shard 的
 * 过期媒体永不物理删——GDPR Art.17 擦除闭环在非-home shard 上静默断裂。本探针用 FakeMultiShardResolver
 * 注 2 个独立物理 db，锚定 4 条命脉：
 *  ① fan-out：两 shard 的过期引用都被擦（totalErased=之和、totalFailed=0、shardErrors 空）；
 *  ② shard 抛错隔离 + 健康：坏 shard（throwingDb queryMany 抛）记 shardErrors、好 shard 仍擦、metric++、
 *     logger.error、isHealthy=false；
 *  ③ failed>0 路径：eraser 对某 shard 对象擦除抛（runMediaRetention 内部捕获返 failed>0，不进 shard catch）
 *     → totalFailed>0、metric++、logger.error、isHealthy=false；
 *  ④ 恢复：可切换 eraser 桩先 fail 后好 → 下一轮该 shard failed=0 → shardFailures 删该 shard、timer 已 start
 *     → isHealthy=true。
 *
 * 单库下 dbForTenant/coordinatorDb/allShardDbs 是同一 db，「非-home shard 漏擦」测不出来——多 shard 布置
 * 是唯一能让「只跑 home」与「fan-out 全 shard」产生可观测差异的手段。
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { MediaRefStore, type ObjectStorageEraser } from '../../perception/media/media-ref-store.js';
import { MediaRetentionWorker, mediaRetentionMetrics } from '../../perception/media/media-retention-worker.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { throwingDb } from '../support/throwing-db.js';
import { SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 perception_media_refs 表的内存 db（迁移入口——一个 db=一个 shard）。 */
function mediaDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 在给定 shard db 上登记一个「已过期」媒体引用（delete_after ≤ 后续注入的 now）。 */
function seedExpired(db: IDatabase, tenantId: string, id: string, objectKey: string): void {
  const store = new MediaRefStore(db, tenantId);
  store.register({ id, objectKey, sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 1 }, 1000);
}

/** 记录被擦除 object_key 的 eraser（幂等成功）。 */
function recordingEraser(): ObjectStorageEraser & { erased: string[] } {
  const erased: string[] = [];
  return { erased, erase: async (k) => { erased.push(k); } };
}

/**
 * 可切换 eraser 桩：`failKeys` 里的 object_key 擦除抛错（模拟对象存储 IO 故障 → runMediaRetention 内部
 * 捕获计 failed，保留引用行）；其余成功。用来测 failed>0 路径与恢复（改 failKeys 集合即"修好"）。
 */
function toggleEraser(): ObjectStorageEraser & { failKeys: Set<string>; erased: string[] } {
  const failKeys = new Set<string>();
  const erased: string[] = [];
  return {
    failKeys,
    erased,
    erase: async (k) => {
      if (failKeys.has(k)) throw new Error(`object storage IO error: ${k}`);
      erased.push(k);
    },
  };
}

/** 每个 test 前重置模块级 metric（唯一所有者是模块级 state，跨 test 会累积）。 */
function resetMetrics(): void {
  mediaRetentionMetrics.shardEraseFailures = 0;
  mediaRetentionMetrics.degraded = 0;
}

describe('MediaRetentionWorker 分片探针（GDPR fan-out + 健康状态机）', () => {
  let s0: IDatabase;
  let s1: IDatabase;

  beforeEach(() => {
    s0 = mediaDb();
    s1 = mediaDb();
    resetMetrics();
  });

  it('① fan-out 擦除两 shard：totalErased=之和、totalFailed=0、shardErrors 空；两 shard 过期引用行都删', async () => {
    seedExpired(s0, 'tenant_a', 'a1', 'k-a1');
    seedExpired(s1, 'tenant_b', 'b1', 'k-b1');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const eraser = recordingEraser();
    const worker = new MediaRetentionWorker(resolver, eraser, new SilentLogger(), () => 10000);

    const result = await worker.flushOnce();

    assert.equal(result.totalErased, 2, '两 shard 过期引用之和');
    assert.equal(result.totalFailed, 0);
    assert.equal(result.shardErrors.length, 0);
    /* 擦除器对两 shard 的对象都调（证真 fan-out，非只 home shard）。 */
    assert.deepEqual([...eraser.erased].sort(), ['k-a1', 'k-b1']);
    /* 两 shard 的过期引用行都被删（GDPR 物理删闭环，非只 s0）。 */
    assert.equal(new MediaRefStore(s0, 'tenant_a').getObjectKey('a1'), undefined, 's0 过期引用已删');
    assert.equal(new MediaRefStore(s1, 'tenant_b').getObjectKey('b1'), undefined, 's1 过期引用已删（只跑 home 则会漏）');
  });

  it('② shard 抛错隔离 + 健康：坏 shard（queryMany 抛）记 shardErrors、好 shard 仍擦、metric++、logger.error、isHealthy=false', async () => {
    seedExpired(s0, 'tenant_a', 'a1', 'k-a1');
    const bad = throwingDb({ on: 'queryMany' }); /* runMediaRetention 首调 tx.queryMany(expired) → 抛 → 进 shard catch */
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: bad },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const eraser = recordingEraser();
    const logger = new SilentLogger();
    const worker = new MediaRetentionWorker(resolver, eraser, logger, () => 10000);

    const result = await worker.flushOnce();

    /* 坏 shard 记 shardErrors（shard#1，keyer 按首见顺序：s0=shard#0、bad=shard#1）。 */
    assert.equal(result.shardErrors.length, 1);
    assert.equal(result.shardErrors[0]!.shardKey, 'shard#1');
    assert.match(result.shardErrors[0]!.error, /boom/);
    /* 好 shard 仍擦（隔离：坏 shard 不拖累好 shard）。 */
    assert.equal(result.totalErased, 1, 's0 仍擦');
    assert.deepEqual(eraser.erased, ['k-a1']);
    /* metric++（可告警，防坏 shard 静默漏擦）。 */
    assert.equal(mediaRetentionMetrics.shardEraseFailures, 1);
    /* logger.error（非 info）——强制告警。 */
    assert.ok(logger.entries.some((e) => e.level === 'error'), '坏 shard 记 error 级日志');
    /* isHealthy=false（shardFailures 非空）——但 timer 未 start 也会 false，此处主证 shardFailures 记了。 */
    assert.equal(worker.isHealthy(), false);
  });

  it('③ failed>0 路径：eraser 对某 shard 对象擦除抛（runMediaRetention 内部捕获返 failed>0，不进 shard catch）→ totalFailed>0、metric++、logger.error、isHealthy=false', async () => {
    seedExpired(s0, 'tenant_a', 'a1', 'k-a1');
    seedExpired(s1, 'tenant_b', 'b1', 'k-b1');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const eraser = toggleEraser();
    eraser.failKeys.add('k-b1'); /* s1 的对象擦除抛 → runMediaRetention 内部捕获返 {erased:0, failed:1}（保留引用行） */
    const logger = new SilentLogger();
    const worker = new MediaRetentionWorker(resolver, eraser, logger, () => 10000);

    const result = await worker.flushOnce();

    /* s0 擦成功、s1 failed（内部捕获，不进 shard catch → shardErrors 仍空）。 */
    assert.equal(result.totalErased, 1, 's0 擦成功');
    assert.equal(result.totalFailed, 1, 's1 对象擦除失败计 failed');
    assert.equal(result.shardErrors.length, 0, 'failed>0 不是 shard 整体抛，shardErrors 空');
    /* s1 引用行保留（fail-closed，无孤儿）。 */
    assert.equal(new MediaRefStore(s1, 'tenant_b').getObjectKey('b1'), 'k-b1', 's1 引用行保留可重试');
    /* metric++ + logger.error + isHealthy=false（failed>0 也算 shard 失败）。 */
    assert.equal(mediaRetentionMetrics.shardEraseFailures, 1);
    assert.ok(logger.entries.some((e) => e.level === 'error'));
    assert.equal(worker.isHealthy(), false);
  });

  it('④ 恢复：可切换桩先 fail 后好 → 下一轮该 shard failed=0 → shardFailures 删该 shard、timer 已 start → isHealthy=true', async () => {
    seedExpired(s0, 'tenant_a', 'a1', 'k-a1');
    seedExpired(s1, 'tenant_b', 'b1', 'k-b1');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const eraser = toggleEraser();
    eraser.failKeys.add('k-b1'); /* 第一轮：s1 失败 */
    const worker = new MediaRetentionWorker(resolver, eraser, new SilentLogger(), () => 10000);
    worker.start(); /* timer 起（isHealthy 需 timer + shardFailures 空） */

    const first = await worker.flushOnce();
    assert.equal(first.totalFailed, 1, '第一轮 s1 失败');
    assert.equal(worker.isHealthy(), false, '第一轮后 shardFailures 非空 → 不健康');

    /* 修好：s1 的对象擦除不再抛。引用行第一轮被保留，仍过期，下一轮重试。 */
    eraser.failKeys.delete('k-b1');
    const second = await worker.flushOnce();

    assert.equal(second.totalFailed, 0, '第二轮 s1 修好后无失败');
    assert.equal(second.totalErased, 1, 's1 保留的引用行被重试擦除');
    assert.equal(second.shardErrors.length, 0);
    /* shardFailures 删该 shard + timer 仍 start → isHealthy 恢复 true。 */
    assert.equal(worker.isHealthy(), true, '恢复后健康');
    assert.equal(mediaRetentionMetrics.degraded, 0, 'degraded gauge 归零');

    await worker.stop();
  });
});
