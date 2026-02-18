/**
 * 人格管理路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { PersonaVersion, SimulationResult } from '../../types/index.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { ForkPersonaSchema, SimulatePersonaSchema, UpdatePersonaStatusSchema } from '../schemas/api-schemas.js';
import { parsePagination, paginate } from '../plugins/pagination.js';

/** 将 PersonaVersion 中的 Map 转为普通对象（JSON 可序列化） */
function serializePersona(p: PersonaVersion): Record<string, unknown> {
  return {
    ...p,
    values: Object.fromEntries(p.values),
    results: p.results.map(serializeResult),
  };
}

function serializeResult(r: SimulationResult): Record<string, unknown> {
  return {
    ...r,
    valueAdjustments: Object.fromEntries(r.valueAdjustments),
  };
}

export function registerPersonaRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* POST /api/v1/personas/fork — 从核心价值分叉 */
  app.post('/api/v1/personas/fork', async (request, reply) => {
    const body = ForkPersonaSchema.parse(request.body);
    const tenantOS = getOS(request);
    const coreValues = new Map<string, number>();
    for (const [id, v] of tenantOS.core.values.getAll()) {
      coreValues.set(id, v.weight);
    }
    const persona = tenantOS.accelerated.forkPersona(body.label, coreValues, body.resourceQuota);
    return reply.status(201).send({ data: serializePersona(persona) });
  });

  /* POST /api/v1/personas/simulate — 运行模拟 */
  app.post('/api/v1/personas/simulate', async (request) => {
    const body = SimulatePersonaSchema.parse(request.body);
    const tenantOS = getOS(request);
    const persona = tenantOS.accelerated.personas.getById(body.personaId);
    if (!persona) {
      throw new NotFoundError(`人格 ${body.personaId} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    const scenario = {
      id: body.scenario.id,
      description: body.scenario.description,
      params: new Map(Object.entries(body.scenario.params)),
    };
    const result = tenantOS.accelerated.runSimulation(body.personaId, scenario);
    return { data: serializeResult(result) };
  });

  /* PATCH /api/v1/personas/:id/status — 更新人格状态 */
  app.patch<{ Params: { id: string } }>('/api/v1/personas/:id/status', async (request) => {
    const { id } = request.params;
    const body = UpdatePersonaStatusSchema.parse(request.body);
    const tenantOS = getOS(request);
    const persona = tenantOS.accelerated.personas.getById(id);
    if (!persona) {
      throw new NotFoundError(`人格 ${id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    const ok = tenantOS.accelerated.personas.setStatus(id, body.status);
    if (ok) {
      tenantOS.bus.emit('persona:status-changed', { personaId: id, oldStatus: persona.status, newStatus: body.status, tenantId: request.tenantId });
    }
    return { data: { id, status: body.status, updated: ok } };
  });

  /* GET /api/v1/personas — 获取所有人格（支持分页） */
  app.get<{ Querystring: Record<string, unknown> }>('/api/v1/personas', async (request) => {
    const tenantOS = getOS(request);
    const all = tenantOS.accelerated.getAllPersonas().map(serializePersona);
    const params = parsePagination(request.query);
    return paginate(all, params);
  });

  /* GET /api/v1/personas/:id — 获取单个人格 */
  app.get<{ Params: { id: string } }>('/api/v1/personas/:id', async (request) => {
    const { id } = request.params;
    const tenantOS = getOS(request);
    const persona = tenantOS.accelerated.personas.getById(id);
    if (!persona) {
      throw new NotFoundError(`人格 ${id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializePersona(persona) };
  });
}
