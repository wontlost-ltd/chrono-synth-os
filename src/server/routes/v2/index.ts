import type { FastifyInstance } from 'fastify';
import type { UnitOfWorkFactory } from '@chrono/kernel';
import type { IDatabase } from '../../../storage/database.js';
import type { AppConfig } from '../../../config/schema.js';

export function registerV2Routes(
  app: FastifyInstance,
  db: IDatabase,
  config: AppConfig,
  uowFactory: UnitOfWorkFactory,
): void {
  void db;
  void config;
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

    done();
  });
}
