/**
 * 知识批量导入路由（P1-B）
 *
 * POST /api/v1/persona-core/:personaId/bulk-knowledge-imports         — 提交批量导入
 * GET  /api/v1/persona-core/:personaId/bulk-knowledge-imports         — 列出该 persona 的最近 job
 * GET  /api/v1/persona-core/:personaId/bulk-knowledge-imports/:jobId  — 查询单个 job 状态
 *
 * 权限：仅允许 personaId 的 owner 通过 JWT 调用（apikey 拒绝）。
 */

import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../../types/auth.js';
import type { BulkImportService } from '../../knowledge/bulk-import-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { BulkKnowledgeImportSchema } from '../schemas/api-schemas.js';
import { AuthorizationError, NotFoundError, ErrorCode } from '../../errors/index.js';

interface RouteServices {
  bulkImport: BulkImportService;
  personaCore: PersonaCoreService;
}

function requireJwtUser(request: { user?: JwtPayload }): JwtPayload {
  const user = request.user;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError(
      'Bulk knowledge import 仅支持用户 JWT 访问',
      ErrorCode.AUTH_INSUFFICIENT_ROLE,
    );
  }
  return user;
}

export function registerBulkKnowledgeImportRoutes(
  app: FastifyInstance,
  services: RouteServices,
): void {
  const { bulkImport, personaCore } = services;
  const store = bulkImport.getStore();

  /* POST /:personaId/bulk-knowledge-imports */
  app.post<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/bulk-knowledge-imports',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const personaId = request.params.personaId;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);

      const body = BulkKnowledgeImportSchema.parse(request.body);
      const result = await bulkImport.submit({
        tenantId: request.tenantId,
        personaId,
        ownerUserId: user.sub,
        sources: body.sources,
        deduplicateStrategy: body.deduplicateStrategy,
      });

      const status = result.mode === 'sync' ? 200 : 202;
      const job = store.get(request.tenantId, result.jobId);
      return reply.status(status).send({
        data: {
          jobId: result.jobId,
          mode: result.mode,
          totalItems: result.totalItems,
          state: result.state,
          job,
        },
      });
    },
  );

  /* GET /:personaId/bulk-knowledge-imports */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/bulk-knowledge-imports',
    async (request) => {
      const user = requireJwtUser(request);
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, request.params.personaId);
      const jobs = store.listByPersona(request.tenantId, request.params.personaId, 20);
      return { data: jobs };
    },
  );

  /* GET /:personaId/bulk-knowledge-imports/:jobId */
  app.get<{ Params: { personaId: string; jobId: string } }>(
    '/api/v1/persona-core/:personaId/bulk-knowledge-imports/:jobId',
    async (request, reply) => {
      const user = requireJwtUser(request);
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, request.params.personaId);
      const job = store.get(request.tenantId, request.params.jobId);
      if (!job || job.personaId !== request.params.personaId) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `job ${request.params.jobId} 不存在或不属于该 persona` },
        });
      }
      return { data: job };
    },
  );
}

function assertPersonaOwnership(
  personaCore: PersonaCoreService,
  tenantId: string,
  ownerUserId: string,
  personaId: string,
): void {
  const detail = personaCore.getPersonaDetail(tenantId, ownerUserId, personaId);
  if (!detail) {
    throw new NotFoundError(
      `persona ${personaId} 不存在或调用者非 owner`,
      ErrorCode.NOT_FOUND_PERSONA,
    );
  }
}
