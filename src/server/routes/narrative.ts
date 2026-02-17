/**
 * 叙事管理路由
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { UpdateNarrativeSchema } from '../schemas/api-schemas.js';

export function registerNarrativeRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* PUT /api/v1/narrative — 更新叙事 */
  app.put('/api/v1/narrative', async (request) => {
    const body = UpdateNarrativeSchema.parse(request.body);
    const previous = os.core.narrative.get();
    os.core.updateNarrative(body.content);
    return { data: { content: body.content, previous } };
  });

  /* GET /api/v1/narrative — 获取叙事 */
  app.get('/api/v1/narrative', async () => {
    const content = os.core.narrative.get();
    return { data: { content } };
  });
}
