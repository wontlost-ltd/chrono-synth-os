/**
 * 叙事管理路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { UpdateNarrativeSchema } from '../schemas/api-schemas.js';

export function registerNarrativeRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* PUT /api/v1/narrative — 更新叙事 */
  app.put('/api/v1/narrative', async (request) => {
    const body = UpdateNarrativeSchema.parse(request.body);
    const tenantOS = getOS(request);
    const previous = tenantOS.core.narrative.get();
    tenantOS.core.updateNarrative(body.content);
    return { data: { content: body.content, previous } };
  });

  /* GET /api/v1/narrative — 获取叙事 */
  app.get('/api/v1/narrative', async (request) => {
    const tenantOS = getOS(request);
    const content = tenantOS.core.narrative.get();
    return { data: { content } };
  });
}
