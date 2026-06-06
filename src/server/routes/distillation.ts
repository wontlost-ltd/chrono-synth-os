/**
 * 蒸馏治理路由（ADR-0047 D3）
 *
 *   GET  /api/v1/persona-core/:personaId/distillation/candidates   列出待审批候选（含 provenance）
 *   GET  /api/v1/persona-core/:personaId/distillation/artifacts    列出全部工件（审计/历史）
 *   POST /api/v1/persona-core/:personaId/distillation/:artifactId/approve  审批 → 编译进内核
 *   POST /api/v1/persona-core/:personaId/distillation/:artifactId/reject   拒绝
 *
 * 这是分析里要求的 "UpdateGate review API"：让数字人的自我修改可解释（evidence/
 * confidence/payload 全暴露）、可审批、可拒绝。仅 persona owner（用户 JWT）可访问。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DistillationService } from '../../intelligence/distillation-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, NotFoundError, ErrorCode } from '../../errors/index.js';
import { DistillationRejectBodySchema } from '../schemas/api-schemas.js';
import type { DistilledArtifact } from '@chrono/kernel';

interface DistillationRouteServices {
  distillation: DistillationService;
  personaCore: PersonaCoreService;
}

function requireJwtUser(request: FastifyRequest): JwtPayload {
  const user = request.user as JwtPayload | undefined;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError(
      'Persona distillation 仅支持用户 JWT 访问',
      ErrorCode.AUTH_INSUFFICIENT_ROLE,
    );
  }
  return user;
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

/** 对外视图：暴露 provenance，便于审查界面解释"为什么提议这个改动" */
function toView(a: DistilledArtifact): Record<string, unknown> {
  return {
    id: a.id,
    kind: a.kind,
    source: a.source,
    status: a.status,
    confidence: a.confidence,
    payload: a.payload,
    evidence: a.evidence,
    createdAt: a.createdAt,
    compiledAt: a.compiledAt ?? null,
  };
}

export function registerDistillationRoutes(app: FastifyInstance, services: DistillationRouteServices): void {
  const { distillation, personaCore } = services;

  /* GET 候选列表（待审批） */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/distillation/candidates',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);
      const items = distillation.listCandidates(personaId).map(toView);
      return reply.status(200).send({ data: { items, total: items.length } });
    },
  );

  /* GET 全部工件（审计历史） */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/distillation/artifacts',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);
      const items = distillation.listByPersona(personaId).map(toView);
      return reply.status(200).send({ data: { items, total: items.length } });
    },
  );

  /* POST 审批 → 编译进内核 */
  app.post<{ Params: { personaId: string; artifactId: string } }>(
    '/api/v1/persona-core/:personaId/distillation/:artifactId/approve',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId, artifactId } = request.params;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);
      const result = distillation.approve(personaId, artifactId);
      if (!result.ok) {
        const status = result.reason === 'artifact not found' ? 404 : 409;
        return reply.status(status).send({ error: { code: 'DISTILL_APPROVE_FAILED', message: result.reason } });
      }
      return reply.status(200).send({ data: toView(result.artifact) });
    },
  );

  /* POST 拒绝 */
  app.post<{ Params: { personaId: string; artifactId: string } }>(
    '/api/v1/persona-core/:personaId/distillation/:artifactId/reject',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId, artifactId } = request.params;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);
      const body = DistillationRejectBodySchema.parse(request.body);
      const result = distillation.reject(artifactId, body.reason);
      if (!result.ok) {
        const status = result.reason === 'artifact not found' ? 404 : 409;
        return reply.status(status).send({ error: { code: 'DISTILL_REJECT_FAILED', message: result.reason } });
      }
      return reply.status(200).send({ data: toView(result.artifact) });
    },
  );
}
