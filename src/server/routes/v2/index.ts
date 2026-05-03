import type { FastifyInstance } from 'fastify';
import type { UnitOfWorkFactory } from '@chrono/kernel';
import type { IDatabase } from '../../../storage/database.js';
import type { AppConfig } from '../../../config/schema.js';
import type { DualWriteFlushWorker } from '../../../workers/dual-write-flush-worker.js';
import type { JwtPayload } from '../../../types/auth.js';
import { countPendingConflicts } from '../../../privacy/conflict-inbox-store.js';
import { personaCoreDualWrite } from '../../../data-plane/persona-core-dual-write.js';

export function registerV2Routes(
  app: FastifyInstance,
  db: IDatabase,
  config: AppConfig,
  uowFactory: UnitOfWorkFactory,
  flushWorker: DualWriteFlushWorker,
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

    done();
  });
}
