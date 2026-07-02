import type { FastifyInstance } from 'fastify';
import type { UnitOfWorkFactory } from '@chrono/kernel';
import type { IDatabase } from '../../../storage/database.js';
import type { AppConfig } from '../../../config/schema.js';
import type { DualWriteFlushWorker } from '../../../workers/dual-write-flush-worker.js';
import type { JwtPayload } from '../../../types/auth.js';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import { countPendingConflicts } from '../../../privacy/conflict-inbox-store.js';
import { personaCoreDualWrite } from '../../../data-plane/persona-core-dual-write.js';
import { PrivacyService } from '../../../privacy/privacy-service.js';
import { DryRunImportBodySchema, CommitImportBodySchema } from '../../schemas/api-schemas.js';
import { requireRole } from '../../plugins/rbac.js';
import { recordPrivacyAudit } from '../../../audit/privacy-audit.js';

export function registerV2Routes(
  app: FastifyInstance,
  db: IDatabase,
  config: AppConfig,
  uowFactory: UnitOfWorkFactory,
  flushWorker: DualWriteFlushWorker,
  os?: ChronoSynthOS,
  tenantFactory?: TenantOSFactory,
): void {
  void uowFactory;

  app.register((v2, _opts, done) => {
    v2.addHook('onSend', async (_request, reply) => {
      reply.header('X-API-Version', '2');
      reply.header('X-API-Min-Supported', '1');
    });

    v2.get('/api/v2/health', async () => ({
      status: 'ok',
      apiVersion: 2,
      minSupportedVersion: 1,
    }));

    v2.get('/api/v2/version', async () => ({
      current: 2,
      supported: [1, 2],
      deprecationNotice: null,
    }));

    /* GET /api/v2/sync/state — current RuntimeSyncStateV2 snapshot for this tenant */
    v2.get('/api/v2/sync/state', async (request) => {
      const user = request.user as JwtPayload | undefined;
      const tenantId = request.tenantId ?? user?.tenantId ?? 'default';

      const pendingPushCount = personaCoreDualWrite.countPendingOutbox(db, tenantId);
      const conflictCount = countPendingConflicts(db, tenantId);

      let state: string;
      if (conflictCount > 0) {
        state = 'conflict_inbox';
      } else if (pendingPushCount > 0) {
        state = 'online_dirty';
      } else {
        state = 'online_synced';
      }

      return {
        schemaVersion: 2,
        state,
        tenantId,
        runtimeId: config.region,
        networkOnline: true,
        authValid: user !== undefined,
        remoteReachable: true,
        localWritable: true,
        pendingPushCount,
        pendingPullCount: 0,
        conflictCount,
        activeRunId: null,
        lastSyncedLedgerVersion: null,
        localHighWatermark: 0,
        lastErrorCode: null,
      };
    });

    /* POST /api/v2/sync/pull — flush outbox then report sync result */
    v2.post('/api/v2/sync/pull', async (request) => {
      const user = request.user as JwtPayload | undefined;
      const tenantId = request.tenantId ?? user?.tenantId ?? 'default';

      const { flushed, failed } = await flushWorker.flush();

      const conflictCount = countPendingConflicts(db, tenantId);
      const pendingPushCount = personaCoreDualWrite.countPendingOutbox(db, tenantId);

      return {
        synced: flushed,
        failed,
        conflicts: conflictCount,
        pendingPushCount,
      };
    });

    /* Portability routes — only registered when ChronoSynthOS is available */
    if (os) {
      const privacyService = new PrivacyService(os, tenantFactory, config);

      /* POST /api/v2/portability/export — start async export job */
      v2.post('/api/v2/portability/export', {
        preHandler: requireRole('admin'),
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      }, async (request) => {
        const status = privacyService.startExportJob(request.tenantId);
        /* F5：v2 export 与 v1 同级留业务审计。 */
        if (os) recordPrivacyAudit(os.getDatabase(), request, 'privacy.export.started', status.exportId, { exportId: status.exportId, state: status.state });
        return { data: status };
      });

      /* GET /api/v2/portability/export/:exportId — poll export job status */
      v2.get<{ Params: { exportId: string } }>('/api/v2/portability/export/:exportId', {
        preHandler: requireRole('admin'),
      }, async (request, reply) => {
        const status = privacyService.getExportJobStatus(request.tenantId, request.params.exportId);
        if (!status) return reply.code(404).send({ error: 'Export job not found' });
        return { data: status };
      });

      /* POST /api/v2/portability/import — dry-run then commit in one round-trip */
      v2.post('/api/v2/portability/import', {
        preHandler: requireRole('admin'),
        config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
      }, async (request, reply) => {
        const body = CommitImportBodySchema.safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'Invalid request body', details: body.error.issues });
        }
        try {
          const result = privacyService.commitImport(
            request.tenantId,
            body.data.manifestJson,
            body.data.commitToken,
          );
          /* F5：v2 portability import 与 v1 同级留业务审计——同类「真实写入租户数据」不能绕过审计链。 */
          if (os) {
            recordPrivacyAudit(os.getDatabase(), request, 'privacy.import.committed', result.importId, {
              importId: result.importId, importedCount: result.importedCount,
              skippedCount: result.skippedCount, failedCount: result.failedCount,
            });
          }
          return { data: result };
        } catch (err) {
          if (err instanceof Error && err.message.includes('invalid or expired')) {
            if (os) recordPrivacyAudit(os.getDatabase(), request, 'privacy.import.failed', request.tenantId, { reason: 'invalid or expired commit token' });
            return reply.code(403).send({ error: err.message });
          }
          throw err;
        }
      });

      /* POST /api/v2/portability/import/dry-run — validate manifest without committing */
      v2.post('/api/v2/portability/import/dry-run', {
        preHandler: requireRole('admin'),
      }, async (request, reply) => {
        const body = DryRunImportBodySchema.safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'Invalid request body', details: body.error.issues });
        }
        const report = privacyService.dryRunImport(request.tenantId, body.data.manifestJson);
        return { data: report };
      });
    }

    done();
  });
}
