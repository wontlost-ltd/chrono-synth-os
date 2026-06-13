/**
 * 感知媒体引用 + retention + GDPR（ADR-0052 Edge-P5）：原始媒体绝不进库；引用元数据落库；
 * retention 按 delete_after 清理 + 触发对象存储 erase；GDPR 导出脱敏不含 object_key + 擦除删行。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { MediaRefStore, runMediaRetention, type ObjectStorageEraser } from '../../perception/media/media-ref-store.js';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/index.js';

/** 记录擦除调用的 mock eraser。 */
function recordingEraser(): ObjectStorageEraser & { erased: string[] } {
  const erased: string[] = [];
  return { erased, erase: async (k) => { erased.push(k); } };
}

const TENANT = 'tenant_a';

describe('感知媒体引用存储（ADR-0052 Edge-P5）', () => {
  let db: IDatabase;
  beforeEach(() => { db = createMemoryDatabase(); runDslSqliteMigrations(db); });

  it('register：只存引用元数据，原始媒体绝不进库', () => {
    const store = new MediaRefStore(db, TENANT);
    store.register({ id: 'm1', objectKey: 's3://bucket/abc', sha256: 'deadbeef', mime: 'audio/wav', sizeBytes: 1024, durationMs: 45000 }, 1000);
    /* 直查库：无任何原始媒体列，只有引用元数据。 */
    const cols = db.prepare<{ name: string }>('PRAGMA table_info(perception_media_refs)').all().map((c) => c.name);
    assert.ok(!cols.some((c) => /raw|blob|data|content|media_bytes/i.test(c)), '不得有原始媒体列');
    assert.ok(cols.includes('object_key') && cols.includes('sha256'), '应有引用元数据列');
    assert.equal(store.listMetadata().length, 1);
  });

  it('listMetadata 脱敏：不含 object_key', () => {
    const store = new MediaRefStore(db, TENANT);
    store.register({ id: 'm1', objectKey: 's3://secret/key', sha256: 'h', mime: 'video/mp4', sizeBytes: 1, durationMs: 1 }, 1000);
    const meta = store.listMetadata()[0];
    assert.ok(!('objectKey' in meta) && !('object_key' in meta), 'listMetadata 不得含 object_key');
    assert.equal(meta.sha256, 'h');
  });

  it('租户隔离：A 的引用，B 取不到', () => {
    new MediaRefStore(db, 'A').register({ id: 'm1', objectKey: 'k', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1 }, 1000);
    assert.equal(new MediaRefStore(db, 'B').listMetadata().length, 0);
    assert.equal(new MediaRefStore(db, 'B').getObjectKey('m1'), undefined);
  });

  it('erase：先删对象存储对象，再删 DB 引用行', async () => {
    const store = new MediaRefStore(db, TENANT);
    store.register({ id: 'm1', objectKey: 's3://bucket/abc', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1 }, 1000);
    const eraser = recordingEraser();
    assert.equal(await store.erase('m1', eraser), true);
    assert.deepEqual(eraser.erased, ['s3://bucket/abc'], '对象存储 erase 被调用');
    assert.equal(store.listMetadata().length, 0, 'DB 引用行已删');
  });

  it('erase：对象存储删失败 → 不删 DB 行（避免孤儿对象）', async () => {
    const store = new MediaRefStore(db, TENANT);
    store.register({ id: 'm1', objectKey: 'k', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1 }, 1000);
    const failing: ObjectStorageEraser = { erase: async () => { throw new Error('s3 down'); } };
    await assert.rejects(() => store.erase('m1', failing));
    assert.equal(store.listMetadata().length, 1, '对象删失败 → DB 行保留（下次重试）');
  });
});

describe('媒体 retention worker（ADR-0052 Edge-P5）', () => {
  let db: IDatabase;
  beforeEach(() => { db = createMemoryDatabase(); runDslSqliteMigrations(db); });

  it('清理过期（delete_after ≤ now）引用 + 触发对象存储 erase；未过期保留', async () => {
    const store = new MediaRefStore(db, 'A');
    store.register({ id: 'expired', objectKey: 'k-exp', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 5000 }, 1000);
    store.register({ id: 'future', objectKey: 'k-fut', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 99999 }, 1000);
    store.register({ id: 'permanent', objectKey: 'k-perm', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: null }, 1000);

    const eraser = recordingEraser();
    const result = await runMediaRetention(db, eraser, 10000);   /* now=10000 */
    assert.equal(result.erased, 1, '仅过期的被清理');
    assert.deepEqual(eraser.erased, ['k-exp']);
    /* 未过期 + 永久保留仍在。 */
    assert.equal(new MediaRefStore(db, 'A').listMetadata().length, 2);
  });

  it('单个对象删失败隔离：不阻断其他过期清理', async () => {
    const store = new MediaRefStore(db, 'A');
    store.register({ id: 'm1', objectKey: 'bad', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 1 }, 1000);
    store.register({ id: 'm2', objectKey: 'good', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1, deleteAfter: 1 }, 1000);
    const eraser: ObjectStorageEraser = { erase: async (k) => { if (k === 'bad') throw new Error('fail'); } };
    const result = await runMediaRetention(db, eraser, 10000);
    assert.equal(result.erased, 1);
    assert.equal(result.failed, 1);
    /* bad 行保留（重试），good 行删除。 */
    const remaining = new MediaRefStore(db, 'A').listMetadata();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'm1');
  });
});

describe('媒体引用 GDPR（ADR-0052 Edge-P5）', () => {
  let os: ChronoSynthOS | undefined;
  afterEach(() => { os?.close(); os = undefined; });

  it('导出脱敏不含 object_key；擦除删引用行', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    os = new ChronoSynthOS({ db, skipMigrations: true, clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    new MediaRefStore(db, 'default').register({ id: 'm1', objectKey: 's3://VERYSECRET/loc', sha256: 'h', mime: 'audio/wav', sizeBytes: 1, durationMs: 1 }, 1000);

    const privacy = new PrivacyService(os, undefined);
    const tables = privacy.exportData('default').content.tables as Record<string, Array<Record<string, unknown>>>;
    const rows = tables.perception_media_refs;
    assert.ok(rows?.length === 1, '应导出引用元数据');
    assert.ok(!('object_key' in rows[0]), 'object_key 不得出现在导出（能定位媒体）');
    assert.ok(!JSON.stringify(rows).includes('VERYSECRET'), '导出不得泄露 object_key');

    privacy.eraseData('default');
    assert.equal(
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM perception_media_refs WHERE tenant_id = ?').get('default')?.c, 0,
      '引用行应随擦除删除',
    );
  });
});
