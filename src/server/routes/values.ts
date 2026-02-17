/**
 * 价值管理路由
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { CreateValueSchema, UpdateValueSchema } from '../schemas/api-schemas.js';
import { parsePagination, paginate } from '../plugins/pagination.js';

export function registerValueRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* POST /api/v1/values — 创建价值 */
  app.post('/api/v1/values', async (request) => {
    const body = CreateValueSchema.parse(request.body);
    const value = os.core.addValue(body.label, body.weight, body.timeDiscount, body.emotionAmplifier);
    return { data: value };
  });

  /* GET /api/v1/values — 获取所有价值（统一分页响应） */
  app.get('/api/v1/values', async (request) => {
    const query = request.query as Record<string, unknown>;
    const all = os.core.values.getAll();
    const items = [...all.values()];
    const params = parsePagination(query);
    return paginate(items, params);
  });

  /* PATCH /api/v1/values/:id — 更新价值参数（通过 UpdateGate 路由） */
  app.patch<{ Params: { id: string } }>('/api/v1/values/:id', async (request, reply) => {
    const { id } = request.params;
    const body = UpdateValueSchema.parse(request.body);

    const current = os.core.values.getAll().get(id);
    if (!current) {
      throw new NotFoundError(`价值 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
    }

    const delta = body.weight !== undefined ? body.weight - current.weight : 0;
    const patch = { weight: body.weight, timeDiscount: body.timeDiscount, emotionAmplifier: body.emotionAmplifier };

    const result = os.updateGate.tryApply(
      'L1',
      'user_confirmation',
      id,
      String(current.weight),
      JSON.stringify(patch),
      delta,
      '用户更新价值参数',
      () => { os.core.updateValueParams(id, patch); },
    );

    if (result.applied) {
      const updated = os.core.values.getAll().get(id);
      if (!updated) throw new NotFoundError(`价值 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      return { data: updated };
    }
    return reply.status(202).send({ data: result.pendingUpdate, message: '变更需要确认' });
  });
}
