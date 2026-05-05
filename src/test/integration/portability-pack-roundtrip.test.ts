import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { loadConfig } from '../../config/schema.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { LocalObjectStorageClient } from '../../privacy/object-storage-client.js';
import { getExportJob } from '../../privacy/export-job-store.js';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { PortabilityPackManifestV1Schema, ImportDryRunReportV1Schema, ImportCommitResultV1Schema } from '@chrono/contracts';
import type { IDatabase } from '../../storage/database.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Portability Pack GA roundtrip', () => {
  let tmpDir: string | undefined;
  let db: IDatabase | undefined;
  let os: ChronoSynthOS | undefined;

  afterEach(async () => {
    os?.close();
    db = undefined;
    os = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('exports a portability pack and validates import dry-run', async () => {
    db = createMemoryDatabase();
    runMigrations(db);
    tmpDir = await mkdtemp(join(tmpdir(), 'chrono-portability-pack-'));

    os = new ChronoSynthOS({
      db,
      skipMigrations: true,
      clock: new TestClock(1_700_000_000_000),
      logger: new SilentLogger(),
    });
    os.start();

    const config = loadConfig({
      websocket: { enabled: false },
      objectStorage: { provider: 'local', localPath: tmpDir, presignTtlSeconds: 60 },
    });
    const service = new PrivacyService(os, undefined, config, new LocalObjectStorageClient(tmpDir));
    const tenantId = 'default';

    const started = service.startExportJob(tenantId);
    let status = service.getExportJobStatus(tenantId, started.exportId);
    const deadline = Date.now() + 3_000;
    while (status?.state !== 'completed' && Date.now() < deadline) {
      await sleep(100);
      status = service.getExportJobStatus(tenantId, started.exportId);
    }

    assert.equal(status?.state, 'completed');
    const row = getExportJob(db, started.exportId);
    assert.ok(row?.pack_json, 'completed export job should persist pack_json');

    // pack_json 现为捆绑格式 { manifest, payloads }，从中提取 manifest
    const bundled = JSON.parse(row.pack_json) as { manifest: unknown; payloads: Record<string, unknown[]> };
    assert.ok(bundled.manifest, 'bundled pack_json must contain manifest');
    assert.ok(typeof bundled.payloads === 'object', 'bundled pack_json must contain payloads');
    const manifest = PortabilityPackManifestV1Schema.parse(bundled.manifest);
    assert.ok(manifest.payloads.length > 0);
    assert.ok(manifest.integrity.manifestChecksum.length > 0);

    const dryRun = ImportDryRunReportV1Schema.parse(service.dryRunImport(tenantId, row.pack_json));
    assert.ok(dryRun.canCommit || dryRun.blockers.length > 0);
  });

  it('commitImport 单行失败时计入 failedCount 并保留失败详情', async () => {
    db = createMemoryDatabase();
    runMigrations(db);
    tmpDir = await mkdtemp(join(tmpdir(), 'chrono-portability-failures-'));

    os = new ChronoSynthOS({
      db,
      skipMigrations: true,
      clock: new TestClock(1_700_000_000_000),
      logger: new SilentLogger(),
    });
    os.start();

    const config = loadConfig({
      websocket: { enabled: false },
      objectStorage: { provider: 'local', localPath: tmpDir, presignTtlSeconds: 60 },
    });
    const service = new PrivacyService(os, undefined, config, new LocalObjectStorageClient(tmpDir));
    const tenantId = 'default';

    // 准备一行合法记录
    db.prepare<void>(
      `INSERT INTO quota_limits (tenant_id, resource, max_per_window, window_ms)
       VALUES (?, 'test:fail-resource', 100, 60000)`,
    ).run(tenantId);

    // 导出
    const started = service.startExportJob(tenantId);
    let status = service.getExportJobStatus(tenantId, started.exportId);
    const deadline = Date.now() + 3_000;
    while (status?.state !== 'completed' && Date.now() < deadline) {
      await sleep(100);
      status = service.getExportJobStatus(tenantId, started.exportId);
    }
    assert.equal(status?.state, 'completed');
    const row = getExportJob(db, started.exportId);
    assert.ok(row?.pack_json);

    // 篡改 bundled payload 的某行：插入一个不存在的列以触发 SQL 错误
    const bundled = JSON.parse(row.pack_json) as { manifest: unknown; payloads: Record<string, unknown[]> };
    const quotaRows = bundled.payloads.quota_limits as Array<Record<string, unknown>> | undefined;
    if (quotaRows && quotaRows.length > 0) {
      quotaRows.push({ nonexistent_column_xyz: 'will-fail', another_bad: 42 });
    }
    const tamperedPackJson = JSON.stringify(bundled);

    // dry-run 仍然基于 manifest 校验通过，commitImport 内部对每行错误降级
    const dryRun = ImportDryRunReportV1Schema.parse(service.dryRunImport(tenantId, tamperedPackJson));
    assert.ok(dryRun.canCommit);
    assert.ok(dryRun.commitToken);

    const result = ImportCommitResultV1Schema.parse(
      service.commitImport(tenantId, tamperedPackJson, dryRun.commitToken),
    );
    assert.ok(result.failedCount >= 1, `failedCount should be >= 1, got ${result.failedCount}`);
    assert.ok(result.failures.length >= 1, 'failures array should contain at least 1 entry');
    assert.equal(result.failures[0].logicalName, 'quota_limits');
    assert.ok(typeof result.failures[0].rowIndex === 'number');
    assert.ok(result.failures[0].reason.length > 0);
  });

  it('commitImport 写入行并返回 importedCount > 0', async () => {
    db = createMemoryDatabase();
    runMigrations(db);
    tmpDir = await mkdtemp(join(tmpdir(), 'chrono-portability-commit-'));

    os = new ChronoSynthOS({
      db,
      skipMigrations: true,
      clock: new TestClock(1_700_000_000_000),
      logger: new SilentLogger(),
    });
    os.start();

    const config = loadConfig({
      websocket: { enabled: false },
      objectStorage: { provider: 'local', localPath: tmpDir, presignTtlSeconds: 60 },
    });
    const service = new PrivacyService(os, undefined, config, new LocalObjectStorageClient(tmpDir));
    const tenantId = 'default';

    // 先往 quota_limits 插入一行，确保 export 时有数据
    db.prepare<void>(
      `INSERT INTO quota_limits (tenant_id, resource, max_per_window, window_ms)
       VALUES (?, 'test:resource', 100, 60000)`,
    ).run(tenantId);

    // 导出
    const started = service.startExportJob(tenantId);
    const deadline = Date.now() + 3_000;
    let status = service.getExportJobStatus(tenantId, started.exportId);
    while (status?.state !== 'completed' && Date.now() < deadline) {
      await sleep(100);
      status = service.getExportJobStatus(tenantId, started.exportId);
    }
    assert.equal(status?.state, 'completed');

    const row = getExportJob(db, started.exportId);
    assert.ok(row?.pack_json);

    // dry-run 拿到 commitToken
    const dryRun = ImportDryRunReportV1Schema.parse(service.dryRunImport(tenantId, row.pack_json));
    assert.ok(dryRun.canCommit, `dry-run should canCommit, blockers: ${JSON.stringify(dryRun.blockers)}`);
    assert.ok(dryRun.commitToken, 'dry-run must return commitToken when canCommit=true');

    // 删掉原始行，确认 commitImport 能重新写入
    db.prepare<void>(`DELETE FROM quota_limits WHERE tenant_id = ? AND resource = 'test:resource'`).run(tenantId);
    const countBefore = (db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM quota_limits WHERE tenant_id = ? AND resource = 'test:resource'`).get(tenantId))?.n ?? 0;
    assert.equal(countBefore, 0, 'row should be deleted before commit');

    // 执行 commitImport
    const result = ImportCommitResultV1Schema.parse(
      service.commitImport(tenantId, row.pack_json, dryRun.commitToken),
    );
    assert.ok(result.importedCount > 0, `importedCount should be > 0, got ${result.importedCount}`);

    // 验证行已重新写入
    const countAfter = (db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM quota_limits WHERE tenant_id = ? AND resource = 'test:resource'`).get(tenantId))?.n ?? 0;
    assert.equal(countAfter, 1, 'commitImport should restore deleted row');
  });

  it('commitImport 版本感知合并：本地 updated_at 较新时拒绝覆盖', async () => {
    db = createMemoryDatabase();
    runMigrations(db);
    tmpDir = await mkdtemp(join(tmpdir(), 'chrono-portability-merge-'));

    os = new ChronoSynthOS({
      db,
      skipMigrations: true,
      clock: new TestClock(1_700_000_000_000),
      logger: new SilentLogger(),
    });
    os.start();
    const config = loadConfig({
      websocket: { enabled: false },
      objectStorage: { provider: 'local', localPath: tmpDir, presignTtlSeconds: 60 },
    });
    const service = new PrivacyService(os, undefined, config, new LocalObjectStorageClient(tmpDir));
    const tenantId = 'default';

    /* core_values 有 updated_at + 单列 PK，触发版本感知 upsert 路径 */
    db.prepare<void>(
      `INSERT INTO core_values (id, label, weight, updated_at, tenant_id, time_discount, emotion_amplifier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('patience', 'Patience-OLD', 0.5, 1_700_000_000_000, tenantId, 0.5, 1.0);

    /* 导出一份 pack，里面 patience 行的 updated_at = 1_700_000_000_000 */
    const started = service.startExportJob(tenantId);
    const deadline = Date.now() + 3_000;
    let status = service.getExportJobStatus(tenantId, started.exportId);
    while (status?.state !== 'completed' && Date.now() < deadline) {
      await sleep(100);
      status = service.getExportJobStatus(tenantId, started.exportId);
    }
    assert.equal(status?.state, 'completed');
    const row = getExportJob(db, started.exportId);
    assert.ok(row?.pack_json);

    /* 在 commitImport 之前，把本地行的 updated_at 推进到比 pack 更新 + 改 label 为 NEW */
    db.prepare<void>(
      `UPDATE core_values SET label = 'Patience-NEW', updated_at = ? WHERE id = ?`,
    ).run(1_800_000_000_000, 'patience');

    const dryRun = ImportDryRunReportV1Schema.parse(service.dryRunImport(tenantId, row.pack_json));
    assert.ok(dryRun.canCommit && dryRun.commitToken);

    const result = ImportCommitResultV1Schema.parse(
      service.commitImport(tenantId, row.pack_json, dryRun.commitToken),
    );
    /* 旧导入数据应被拒绝（stale），本地 NEW 保留 */
    assert.ok(result.staleSkippedCount >= 1, `expected stale skip, got ${result.staleSkippedCount}`);
    const after = db.prepare<{ label: string; updated_at: number }>(
      `SELECT label, updated_at FROM core_values WHERE id = ?`,
    ).get('patience');
    assert.equal(after?.label, 'Patience-NEW', 'newer local row must be preserved');
    assert.equal(after?.updated_at, 1_800_000_000_000);
  });

  it('commitImport 版本感知合并：本地 updated_at 较旧时正常覆盖', async () => {
    db = createMemoryDatabase();
    runMigrations(db);
    tmpDir = await mkdtemp(join(tmpdir(), 'chrono-portability-merge-newer-'));

    os = new ChronoSynthOS({
      db,
      skipMigrations: true,
      clock: new TestClock(1_700_000_000_000),
      logger: new SilentLogger(),
    });
    os.start();
    const config = loadConfig({
      websocket: { enabled: false },
      objectStorage: { provider: 'local', localPath: tmpDir, presignTtlSeconds: 60 },
    });
    const service = new PrivacyService(os, undefined, config, new LocalObjectStorageClient(tmpDir));
    const tenantId = 'default';

    /* 导出一行 updated_at=1_800_000_000_000，再回设本地为更老的值 */
    db.prepare<void>(
      `INSERT INTO core_values (id, label, weight, updated_at, tenant_id, time_discount, emotion_amplifier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('precision', 'Precision-NEW', 0.7, 1_800_000_000_000, tenantId, 0.5, 1.0);

    const started = service.startExportJob(tenantId);
    const deadline = Date.now() + 3_000;
    let status = service.getExportJobStatus(tenantId, started.exportId);
    while (status?.state !== 'completed' && Date.now() < deadline) {
      await sleep(100);
      status = service.getExportJobStatus(tenantId, started.exportId);
    }
    const row = getExportJob(db, started.exportId);
    assert.ok(row?.pack_json);

    /* 把本地降为更老版本 */
    db.prepare<void>(
      `UPDATE core_values SET label = 'Precision-OLD', updated_at = ? WHERE id = ?`,
    ).run(1_700_000_000_000, 'precision');

    const dryRun = ImportDryRunReportV1Schema.parse(service.dryRunImport(tenantId, row.pack_json));
    const result = ImportCommitResultV1Schema.parse(
      service.commitImport(tenantId, row.pack_json, dryRun.commitToken!),
    );
    assert.equal(result.staleSkippedCount, 0);
    const after = db.prepare<{ label: string; updated_at: number }>(
      `SELECT label, updated_at FROM core_values WHERE id = ?`,
    ).get('precision');
    assert.equal(after?.label, 'Precision-NEW', 'newer pack row must overwrite older local row');
    assert.equal(after?.updated_at, 1_800_000_000_000);
  });
});
