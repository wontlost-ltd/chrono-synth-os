/**
 * MediaRetentionWorker 单测（ADR-0051 Phase 3 / Edge-P5 周期触发接线）。
 *
 * 锁定接线契约：worker.flushOnce 委托 runMediaRetention（按 delete_after ≤ now 清过期引用、触发
 * 对象存储 erase、删引用行）；start/stop 生命周期；no-op 擦除器下仍完成「删引用行」闭环（GDPR 关键）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { MediaRefStore, type ObjectStorageEraser } from '../../perception/media/media-ref-store.js';
import { MediaRetentionWorker, LoggingNoopObjectStorageEraser } from '../../perception/media/media-retention-worker.js';
import { SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/index.js';

function recordingEraser(): ObjectStorageEraser & { erased: string[] } {
  const erased: string[] = [];
  return { erased, erase: async (k) => { erased.push(k); } };
}

const TENANT = 'tenant_a';

describe('MediaRetentionWorker（媒体 retention 周期接线）', () => {
  let db: IDatabase;
  beforeEach(() => { db = createMemoryDatabase(); runDslSqliteMigrations(db); });

  it('flushOnce 只清过期（delete_after ≤ now）引用并触发 erase；未过期/永久保留', async () => {
    const store = new MediaRefStore(db, TENANT);
    store.register({ id: 'expired', objectKey: 'k-exp', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 5000 }, 1000);
    store.register({ id: 'future', objectKey: 'k-fut', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 99999 }, 1000);
    store.register({ id: 'permanent', objectKey: 'k-perm', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: null }, 1000);

    const eraser = recordingEraser();
    /* now 注入 10000：expired(5000) 过期，future(99999)/permanent(null) 不动。 */
    const worker = new MediaRetentionWorker(db, eraser, new SilentLogger(), () => 10000);
    const result = await worker.flushOnce();

    assert.equal(result.erased, 1, '仅过期引用被清');
    assert.equal(result.failed, 0);
    assert.deepEqual(eraser.erased, ['k-exp'], '只对过期对象调 erase');
    /* 过期引用行已删，未过期保留。 */
    assert.equal(store.getObjectKey('expired'), undefined, '过期引用行已删');
    assert.equal(store.getObjectKey('future'), 'k-fut', '未过期引用保留');
    assert.equal(store.getObjectKey('permanent'), 'k-perm', '永久引用保留');
  });

  it('no-op 擦除器下仍完成「删引用行」闭环（GDPR 关键：对象侧 no-op，行仍回收）', async () => {
    const store = new MediaRefStore(db, TENANT);
    store.register({ id: 'gone', objectKey: 'k', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 1 }, 1000);

    const worker = new MediaRetentionWorker(db, new LoggingNoopObjectStorageEraser(new SilentLogger()), new SilentLogger(), () => 10000);
    const result = await worker.flushOnce();

    assert.equal(result.erased, 1);
    assert.equal(store.getObjectKey('gone'), undefined, 'no-op 擦除器下引用行仍被删（闭环成立）');
  });

  it('start/stop 生命周期：start 后 healthy，stop 后不再 healthy；重复 start 幂等', async () => {
    const worker = new MediaRetentionWorker(db, recordingEraser(), new SilentLogger(), () => 0);
    assert.equal(worker.isHealthy(), false, '未启动不 healthy');
    worker.start();
    assert.equal(worker.isHealthy(), true, '启动后 healthy');
    worker.start(); // 幂等：不重复建 timer
    assert.equal(worker.isHealthy(), true);
    await worker.stop();
    assert.equal(worker.isHealthy(), false, 'stop 后不 healthy');
  });
});
