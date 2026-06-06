/**
 * 自主挣钱治理路由（ADR-0048）。
 *
 *   POST /api/v1/persona-core/:personaId/earning/cycle  触发一次挣钱周期
 *   GET  /api/v1/persona-core/:personaId/earning/feed    工作动态（任务+状态）
 *   GET  /api/v1/persona-core/:personaId/earning/wallet   工资钱包视图（余额+流水）
 *
 * 仅 persona owner（用户 JWT）可访问。提现等 debit 不在此路由——按 ADR-0048 D2
 * 必须人类确认，走独立的（已存在的）wallet payout 路径。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PersonaEarningService } from '../../intelligence/persona-earning-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, NotFoundError, ErrorCode } from '../../errors/index.js';
import { EarningCycleBodySchema } from '../schemas/api-schemas.js';

interface EarningRouteServices {
  earning: PersonaEarningService;
  personaCore: PersonaCoreService;
}

function requireJwtUser(request: FastifyRequest): JwtPayload {
  const user = request.user as JwtPayload | undefined;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError('Persona earning 仅支持用户 JWT 访问', ErrorCode.AUTH_INSUFFICIENT_ROLE);
  }
  return user;
}

function assertOwner(personaCore: PersonaCoreService, tenantId: string, ownerUserId: string, personaId: string): void {
  if (!personaCore.getPersonaDetail(tenantId, ownerUserId, personaId)) {
    throw new NotFoundError(`persona ${personaId} 不存在或调用者非 owner`, ErrorCode.NOT_FOUND_PERSONA);
  }
}

function perPersonaKey(request: FastifyRequest): string {
  const params = request.params as { personaId?: string };
  return `${request.tenantId ?? 'default'}:earn:${params.personaId ?? 'unknown'}`;
}

export function registerEarningRoutes(app: FastifyInstance, services: EarningRouteServices): void {
  const { earning, personaCore } = services;

  /* 触发挣钱周期（限流：自主劳动是经济行为，防风暴） */
  app.post<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/earning/cycle',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute', keyGenerator: perPersonaKey } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const body = EarningCycleBodySchema.parse(request.body ?? {});
      const result = await earning.runEarningCycle({
        tenantId: request.tenantId,
        personaId,
        ownerUserId: user.sub,
        maxTasksPerCycle: body.maxTasksPerCycle,
      });
      return reply.status(200).send({ data: result });
    },
  );

  /* 工作动态：该 persona 相关的市场任务 + 状态（work feed 数据源） */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/earning/feed',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      const detail = personaCore.getPersonaDetail(request.tenantId, user.sub, personaId);
      if (!detail) {
        throw new NotFoundError(`persona ${personaId} 不存在或调用者非 owner`, ErrorCode.NOT_FOUND_PERSONA);
      }
      const tasks = (detail.marketplaceTasks ?? []).map((t) => ({
        id: t.id, title: t.title, category: t.category, reward: t.reward,
        currency: t.currency, status: t.status, qualityScore: t.qualityScore,
        acceptedAt: t.acceptedAt, completedAt: t.completedAt,
      }));
      return reply.status(200).send({ data: { tasks, total: tasks.length } });
    },
  );

  /* 工资钱包视图（只读：余额 + 流水）。提现入口不在此（D2 必人工确认） */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/earning/wallet',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      const wallet = personaCore.getWallet(request.tenantId, user.sub, personaId);
      if (!wallet) {
        throw new NotFoundError(`persona ${personaId} 钱包不存在或调用者非 owner`, ErrorCode.NOT_FOUND_PERSONA);
      }
      return reply.status(200).send({
        data: {
          walletId: wallet.id,
          balance: wallet.balance,
          tokenBalance: wallet.tokenBalance,
          currency: wallet.currency,
          /* 明确告知：自主流程只增不减；提现须人类确认 */
          withdrawalPolicy: 'human_confirmation_required',
        },
      });
    },
  );
}
