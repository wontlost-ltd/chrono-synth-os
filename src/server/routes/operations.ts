/**
 * 演化和调控操作路由
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { RunRegulationSchema } from '../schemas/api-schemas.js';

export function registerOperationRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* POST /api/v1/operations/evolution/run — 运行演化周期 */
  app.post('/api/v1/operations/evolution/run', async () => {
    const result = os.runEvolutionCycle();
    return { data: result };
  });

  /* POST /api/v1/operations/regulation/run — 运行调控周期 */
  app.post('/api/v1/operations/regulation/run', async (request) => {
    const body = RunRegulationSchema.parse(request.body ?? {});
    os.runRegulationCycle(body?.strategy);
    return { data: { status: 'completed', strategy: body?.strategy ?? 'equal' } };
  });
}
