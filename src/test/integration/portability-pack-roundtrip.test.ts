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
import { PortabilityPackManifestV1Schema, ImportDryRunReportV1Schema } from '@chrono/contracts';
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

    const manifest = PortabilityPackManifestV1Schema.parse(JSON.parse(row.pack_json));
    assert.ok(manifest.payloads.length > 0);
    assert.ok(manifest.integrity.manifestChecksum.length > 0);

    const dryRun = ImportDryRunReportV1Schema.parse(service.dryRunImport(tenantId, row.pack_json));
    assert.ok(dryRun.canCommit || dryRun.blockers.length > 0);
  });
});
