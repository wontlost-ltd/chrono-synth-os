/**
 * 演化和调控操作路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { RunRegulationSchema } from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';

export function registerOperationRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* POST /api/v1/operations/evolution/run — 运行演化周期（仅 admin） */
  app.post('/api/v1/operations/evolution/run', { preHandler: requireRole('admin') }, async (request) => {
    const tenantOS = getOS(request);
    const result = tenantOS.runEvolutionCycle();
    return { data: result };
  });

  /* POST /api/v1/operations/regulation/run — 运行调控周期（仅 admin） */
  app.post('/api/v1/operations/regulation/run', { preHandler: requireRole('admin') }, async (request) => {
    const body = RunRegulationSchema.parse(request.body ?? {});
    const tenantOS = getOS(request);
    tenantOS.runRegulationCycle(body?.strategy);
    return { data: { status: 'completed', strategy: body?.strategy ?? 'equal' } };
  });
}
