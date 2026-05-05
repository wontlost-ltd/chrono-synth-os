/**
 * 工具权限 / 代理授权管理路由（admin only）
 *
 * 路由：
 *   POST   /api/v1/admin/tool-permissions             — 授予权限
 *   GET    /api/v1/admin/tool-permissions             — 列出 tenant 所有权限
 *   GET    /api/v1/admin/personas/:personaId/tool-permissions — persona 权限
 *   DELETE /api/v1/admin/tool-permissions/:id         — 撤销
 *   POST   /api/v1/admin/tool-permissions/revoke-by-key — 通过 revocation key 撤销
 *
 *   POST   /api/v1/admin/agency-authorizations        — 创建授权书
 *   GET    /api/v1/admin/agency-authorizations        — 列出（按 persona / principal）
 *   GET    /api/v1/admin/agency-authorizations/:id    — 详情
 *   POST   /api/v1/admin/agency-authorizations/:id/suspend
 *   POST   /api/v1/admin/agency-authorizations/:id/resume
 *   DELETE /api/v1/admin/agency-authorizations/:id    — 撤销
 *
 *   GET    /api/v1/admin/personas/:personaId/tool-invocations — 调用历史
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';
import { requireRole } from '../plugins/rbac.js';
import { NotFoundError, ValidationError, ErrorCode } from '../../errors/index.js';
import {
  GrantToolPermissionSchema,
  RevokeToolPermissionByKeySchema,
  RevokeReasonSchema,
  CreateAgencyAuthorizationSchema,
} from '../schemas/api-schemas.js';

export function registerAdminToolsRoutes(app: FastifyInstance, db: IDatabase): void {
  const permService = new ToolPermissionService(db);
  const authService = new AgencyAuthorizationService(db);

  /* ── 工具权限 ──────────────────────────────────────────────────── */

  app.post('/api/v1/admin/tool-permissions', {
    preHandler: requireRole('admin'),
  }, async (request, reply) => {
    const body = GrantToolPermissionSchema.parse(request.body);
    const result = permService.grant({
      tenantId: request.tenantId,
      personaId: body.personaId,
      toolId: body.toolId,
      scope: body.scope,
      constraints: body.constraints,
      grantedBy: request.user?.sub ?? 'system',
      expiresAt: body.expiresAt ?? null,
    });
    return reply.status(201).send({ data: result });
  });

  app.get('/api/v1/admin/tool-permissions', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    return { data: permService.listByTenant(request.tenantId) };
  });

  app.get<{ Params: { personaId: string } }>(
    '/api/v1/admin/personas/:personaId/tool-permissions',
    { preHandler: requireRole('admin') },
    async (request) => {
      return {
        data: permService.listByPersona(request.tenantId, request.params.personaId),
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/tool-permissions/:id',
    { preHandler: requireRole('admin') },
    async (request) => {
      const body = RevokeReasonSchema.parse(request.body);
      const ok = permService.revoke(request.params.id, body.reason);
      if (!ok) {
        throw new NotFoundError('权限不存在或已撤销', ErrorCode.NOT_FOUND_VALUE);
      }
      return { data: { revoked: true } };
    },
  );

  app.post('/api/v1/admin/tool-permissions/revoke-by-key', async (request) => {
    /* 注意：此端点不要求 admin role，持有 revocation_key 即可撤销（紧急情况下） */
    const body = RevokeToolPermissionByKeySchema.parse(request.body);
    const ok = permService.revokeByKey(body.revocationKey, body.reason);
    if (!ok) {
      throw new NotFoundError('revocation_key 无效或权限已撤销', ErrorCode.NOT_FOUND_VALUE);
    }
    return { data: { revoked: true } };
  });

  /* ── 代理授权书 ────────────────────────────────────────────────── */

  app.post('/api/v1/admin/agency-authorizations', {
    preHandler: requireRole('admin'),
  }, async (request, reply) => {
    const body = CreateAgencyAuthorizationSchema.parse(request.body);
    const result = authService.create({
      tenantId: request.tenantId,
      personaId: body.personaId,
      principalUserId: body.principalUserId,
      scope: body.scope,
      scopeDescription: body.scopeDescription,
      allowedTools: body.allowedTools,
      deniedTools: body.deniedTools,
      expiresAt: body.expiresAt ?? null,
    });
    return reply.status(201).send({ data: result });
  });

  app.get<{ Querystring: { personaId?: string; principalUserId?: string } }>(
    '/api/v1/admin/agency-authorizations',
    { preHandler: requireRole('admin') },
    async (request) => {
      const { personaId, principalUserId } = request.query;
      if (personaId) {
        return { data: authService.listByPersona(request.tenantId, personaId) };
      }
      if (principalUserId) {
        return { data: authService.listByPrincipal(request.tenantId, principalUserId) };
      }
      throw new ValidationError('personaId 或 principalUserId 必须提供其一', ErrorCode.VALIDATION_REQUIRED);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/agency-authorizations/:id',
    { preHandler: requireRole('admin') },
    async (request) => {
      const auth = authService.getById(request.tenantId, request.params.id);
      if (!auth) throw new NotFoundError('授权书不存在', ErrorCode.NOT_FOUND_VALUE);
      return { data: auth };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/agency-authorizations/:id/suspend',
    { preHandler: requireRole('admin') },
    async (request) => {
      const ok = authService.suspend(request.tenantId, request.params.id);
      if (!ok) throw new NotFoundError('授权书不存在或非 active 状态', ErrorCode.NOT_FOUND_VALUE);
      return { data: { suspended: true } };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/agency-authorizations/:id/resume',
    { preHandler: requireRole('admin') },
    async (request) => {
      const ok = authService.resume(request.tenantId, request.params.id);
      if (!ok) throw new NotFoundError('授权书不存在或非 suspended 状态', ErrorCode.NOT_FOUND_VALUE);
      return { data: { resumed: true } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/agency-authorizations/:id',
    { preHandler: requireRole('admin') },
    async (request) => {
      const body = RevokeReasonSchema.parse(request.body);
      const ok = authService.revoke(request.tenantId, request.params.id, body.reason);
      if (!ok) throw new NotFoundError('授权书不存在或已撤销', ErrorCode.NOT_FOUND_VALUE);
      return { data: { revoked: true } };
    },
  );

  /* ── 调用历史 ──────────────────────────────────────────────────── */

  app.get<{ Params: { personaId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/v1/admin/personas/:personaId/tool-invocations',
    { preHandler: requireRole('admin') },
    async (request) => {
      const limit = Math.max(1, Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200));
      const offset = Math.max(0, parseInt(request.query.offset ?? '0', 10) || 0);
      return {
        data: permService.listInvocations(request.tenantId, request.params.personaId, limit, offset),
      };
    },
  );
}
