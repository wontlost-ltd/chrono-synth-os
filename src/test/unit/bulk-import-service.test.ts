/**
 * 单元测试：BulkImportService（P1-B）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { TaskQueue } from '../../queue/task-queue.js';
import { UrlContentFetcher } from '../../knowledge/url-content-fetcher.js';
import {
  BulkImportService,
  BulkImportQueueDisabledError,
  autoFingerprint,
  type BulkImportSource,
} from '../../knowledge/bulk-import-service.js';

const TEST_USER_ID = 'user_bulk_import_owner';
const TEST_TENANT_ID = 'tenant_bulk_import';

describe('BulkImportService', () => {
  let os: ChronoSynthOS;
  let personaCoreService: PersonaCoreService;
  let service: BulkImportService;
  let taskQueue: TaskQueue;
  let personaId: string;

  function makeSources(count: number, prefix = 'doc'): BulkImportSource[] {
    return Array.from({ length: count }, (_, i) => ({
      kind: 'text' as const,
      content: `${prefix} body ${i}`,
      title: `${prefix} ${i}`,
    }));
  }

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const db = os.getDatabase();

    db.prepare<void>(
      `INSERT OR IGNORE INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, 'pw', 'admin', ?, 1000, 1000)`,
    ).run(TEST_USER_ID, `${TEST_USER_ID}@test.com`, TEST_TENANT_ID);

    personaCoreService = new PersonaCoreService(directUnitOfWork(db));
    const persona = personaCoreService.createPersona({
      tenantId: TEST_TENANT_ID,
      ownerUserId: TEST_USER_ID,
      displayName: 'Bulk Test Persona',
    });
    personaId = persona.id;

    taskQueue = new TaskQueue(db);
    service = new BulkImportService(
      directUnitOfWork(db),
      personaCoreService,
      taskQueue,
      new UrlContentFetcher({ skipDnsResolve: true }),
      new SilentLogger(),
    );
  });

  afterEach(() => os.close());

  it('submit ≤20 sources → mode=sync, state=completed, importedCount = N', async () => {
    const result = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sources: makeSources(5),
      deduplicateStrategy: 'skip',
    });
    assert.equal(result.mode, 'sync');
    assert.equal(result.totalItems, 5);
    assert.equal(result.state, 'completed');

    const job = service.getStore().get(TEST_TENANT_ID, result.jobId);
    assert.ok(job);
    assert.equal(job.importedCount, 5);
    assert.equal(job.failedCount, 0);
    assert.equal(job.skippedCount, 0);
  });

  it('submit >20 sources → mode=async, state=queued', async () => {
    const result = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sources: makeSources(25),
      deduplicateStrategy: 'skip',
    });
    assert.equal(result.mode, 'async');
    assert.equal(result.state, 'queued');

    const job = service.getStore().get(TEST_TENANT_ID, result.jobId);
    assert.ok(job);
    assert.equal(job.totalItems, 25);
    assert.equal(job.state, 'queued');
  });

  it('去重 skip 策略：相同 fingerprint 重复提交计入 skipped_count', async () => {
    const dup: BulkImportSource = { kind: 'text', content: 'dup body', title: 'dup' };

    const r1 = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sources: [dup],
      deduplicateStrategy: 'skip',
    });
    assert.equal(service.getStore().get(TEST_TENANT_ID, r1.jobId)?.importedCount, 1);

    const r2 = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sources: [dup, dup],
      deduplicateStrategy: 'skip',
    });
    const job2 = service.getStore().get(TEST_TENANT_ID, r2.jobId);
    assert.ok(job2);
    assert.equal(job2.importedCount, 0);
    assert.equal(job2.skippedCount, 2);
  });

  it('去重 overwrite 策略：相同 fingerprint 触发删除+重写', async () => {
    const original: BulkImportSource = { kind: 'text', content: 'first version', title: 'item' };
    await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sources: [original],
      deduplicateStrategy: 'skip',
    });

    /* 同 title+content 截前 4096 字符 → 同 fingerprint */
    const replacement: BulkImportSource = {
      kind: 'text',
      content: 'first version',
      title: 'item',
      fingerprint: autoFingerprint('first version', 'item'),
    };

    const r2 = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sources: [replacement],
      deduplicateStrategy: 'overwrite',
    });
    const job2 = service.getStore().get(TEST_TENANT_ID, r2.jobId);
    assert.ok(job2);
    assert.equal(job2.importedCount, 1);
    assert.equal(job2.skippedCount, 0);

    /* 数据库内仍只有一行（旧的被删除，新的写入） */
    const count = os.getDatabase().prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM persona_knowledge_items
        WHERE tenant_id = ? AND persona_id = ? AND fingerprint = ?`,
    ).get(TEST_TENANT_ID, personaId, replacement.fingerprint!);
    assert.equal(count?.n, 1);
  });

  it('单条失败计入 failures，不中断 batch', async () => {
    const sources: BulkImportSource[] = [
      { kind: 'text', content: 'good 1', title: 'a' },
      { kind: 'url', content: 'http://localhost:1/secret', title: 'bad' }, // SSRF rejected
      { kind: 'text', content: 'good 2', title: 'b' },
    ];

    const result = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sources,
      deduplicateStrategy: 'skip',
    });
    const job = service.getStore().get(TEST_TENANT_ID, result.jobId);
    assert.ok(job);
    assert.equal(job.state, 'completed');
    assert.equal(job.importedCount, 2);
    assert.equal(job.failedCount, 1);
    assert.equal(job.failures.length, 1);
    assert.equal(job.failures[0].index, 1);
    assert.match(job.failures[0].reason, /restricted range|SSRF/);
  });

  it('taskQueue 缺失时 >20 条抛 BulkImportQueueDisabledError', async () => {
    const noQueueService = new BulkImportService(
      directUnitOfWork(os.getDatabase()),
      personaCoreService,
      undefined,
      new UrlContentFetcher({ skipDnsResolve: true }),
      new SilentLogger(),
    );
    await assert.rejects(
      () => noQueueService.submit({
        tenantId: TEST_TENANT_ID,
        personaId,
        ownerUserId: TEST_USER_ID,
        sources: makeSources(21),
        deduplicateStrategy: 'skip',
      }),
      BulkImportQueueDisabledError,
    );
  });

  it('autoFingerprint 对相同 title+content 前缀返回相同值', () => {
    const a = autoFingerprint('hello world', 'doc');
    const b = autoFingerprint('hello world', 'doc');
    const c = autoFingerprint('hello world', 'other');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{16}$/);
  });
});
