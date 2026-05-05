/**
 * 岗位人格模板管理路由（P1-A，仅 admin）
 *
 * GET    /api/v1/admin/persona-templates              — 列出（内置 + 自定义）
 * GET    /api/v1/admin/persona-templates/:id          — 单个详情
 * POST   /api/v1/admin/persona-templates              — 创建自定义模板
 * PATCH  /api/v1/admin/persona-templates/:id          — 更新自定义（拒绝内置）
 * DELETE /api/v1/admin/persona-templates/:id          — 删除自定义（拒绝内置）
 * POST   /api/v1/admin/persona-templates/:id/instantiate — 实例化为 persona_core
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { JwtPayload } from '../../types/auth.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import {
  PersonaTemplateService,
  PersonaTemplateNotFoundError,
  BuiltInTemplateImmutableError,
} from '../../enterprise/persona-template-service.js';
import { extractTemplateVariables } from '../../enterprise/persona-template-catalog.js';
import {
  CreatePersonaTemplateSchema,
  PatchPersonaTemplateSchema,
  InstantiatePersonaTemplateSchema,
} from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';
import { NotFoundError, ValidationError, ErrorCode } from '../../errors/index.js';

export function registerAdminTemplateRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  const tx = os.getDatabase();
  const personaCoreService = new PersonaCoreService(tx);
  const templateService = new PersonaTemplateService(tx, personaCoreService);

  /* 启动期：刷新内置模板内容（升级时无需迁移） */
  templateService.syncBuiltins();

  /* GET /api/v1/admin/persona-templates */
  app.get('/api/v1/admin/persona-templates', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const templates = templateService.list(request.tenantId);
    return { data: templates };
  });

  /* GET /api/v1/admin/persona-templates/:id */
  app.get<{ Params: { id: string } }>('/api/v1/admin/persona-templates/:id', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const tpl = templateService.get(request.tenantId, request.params.id);
    if (!tpl) throw new NotFoundError(`模板 ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_TEMPLATE);
    return { data: tpl };
  });

  /* GET /api/v1/admin/persona-templates/:id/variables — 列出模板需要填充的占位符 */
  app.get<{ Params: { id: string } }>('/api/v1/admin/persona-templates/:id/variables', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const tpl = templateService.get(request.tenantId, request.params.id);
    if (!tpl) throw new NotFoundError(`模板 ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_TEMPLATE);
    const variables = extractTemplateVariables(tpl);
    return { data: { templateId: tpl.id, variables } };
  });

  /* POST /api/v1/admin/persona-templates */
  app.post('/api/v1/admin/persona-templates', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = CreatePersonaTemplateSchema.parse(request.body);
    const tpl = templateService.create(request.tenantId, body);
    return reply.status(201).send({ data: tpl });
  });

  /* PATCH /api/v1/admin/persona-templates/:id */
  app.patch<{ Params: { id: string } }>('/api/v1/admin/persona-templates/:id', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = PatchPersonaTemplateSchema.parse(request.body);
    try {
      const tpl = templateService.update(request.tenantId, request.params.id, body);
      return { data: tpl };
    } catch (err) {
      if (err instanceof PersonaTemplateNotFoundError) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      if (err instanceof BuiltInTemplateImmutableError) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: err.message } });
      }
      throw err;
    }
  });

  /* DELETE /api/v1/admin/persona-templates/:id */
  app.delete<{ Params: { id: string } }>('/api/v1/admin/persona-templates/:id', {
    preHandler: requireRole('admin'),
  }, async (request, reply) => {
    try {
      templateService.delete(request.tenantId, request.params.id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof PersonaTemplateNotFoundError) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      if (err instanceof BuiltInTemplateImmutableError) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: err.message } });
      }
      throw err;
    }
  });

  /* POST /api/v1/admin/persona-templates/:id/instantiate */
  app.post<{ Params: { id: string } }>('/api/v1/admin/persona-templates/:id/instantiate', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = InstantiatePersonaTemplateSchema.parse(request.body);
    const user = request.user as JwtPayload | undefined;
    const ownerUserId = body.ownerUserId ?? user?.sub;
    if (!ownerUserId) {
      throw new ValidationError('无法确定 ownerUserId（请提供 body.ownerUserId 或携带 JWT）', ErrorCode.VALIDATION_FORMAT);
    }

    try {
      const result = templateService.instantiate({
        tenantId: request.tenantId,
        ownerUserId,
        templateId: request.params.id,
        displayName: body.displayName,
        overrideValues: body.overrideValues,
        overrideNarrative: body.overrideNarrative,
        templateVariables: body.templateVariables,
        initialKnowledge: body.initialKnowledge,
      });
      return reply.status(201).send({
        data: {
          persona: result.persona,
          templateId: result.templateId,
          instantiatedFromCategory: result.instantiatedFromCategory,
        },
      });
    } catch (err) {
      if (err instanceof PersonaTemplateNotFoundError) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      throw err;
    }
  });
}
