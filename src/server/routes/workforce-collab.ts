/**
 * 数字员工组织协作接线（B 链 + M7 战略辅助）——把已建成但未接线的 4 个组织协作 service 接进生产 HTTP。
 *
 * 关闭「engine built, steering unconnected」：EscalationService（升级链）/ HandoffService（任务交接）/
 * AgentCommunicationService（结构化协作消息）/ StrategyAdvisoryService（战略辅助展开）此前只有 class+测试+表，
 * 无任何路由——组织无法在生产中升级阻塞任务、协商交接、结构化协作、生成战略备选。本路由补齐。
 *
 * 鉴权与不变量（对齐 workforce-actions）：
 *   - 全部 preHandler requireRole('admin')——组织级操作是治理级动作（人类经控制台驱动数字员工）；
 *   - 写路由限流 WRITE_RATE；
 *   - worker 身份来自 body（fromWorkerId/toWorkerId 等，service 内校验其属组织 + 汇报关系），非登录用户——
 *     人类是**操作者**，数字员工是**动作主体**（与 workforce-actions 一致）；
 *   - 域错误经 as4xx 统一映射（非法状态/关系 → 400/409-ish state；不存在 → 404）；
 *   - 零-LLM：4 service 全确定性状态机/评分，路由层不引入任何推理。
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { Clock } from '../../utils/clock.js';
import { StateError, ChronoError, ErrorCode } from '../../errors/index.js';
import { requireRole } from '../plugins/rbac.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { EscalationService, InvalidEscalationError } from '../../workforce/escalation-service.js';
import { HandoffService, InvalidHandoffError } from '../../workforce/handoff-service.js';
import { AgentCommunicationService, InvalidCollaborationError } from '../../workforce/agent-communication-service.js';
import { StrategyAdvisoryService } from '../../workforce/strategy-advisory-service.js';
import {
  WorkforceEscalationRaiseBodySchema,
  WorkforceEscalationResolveBodySchema,
  WorkforceEscalationReescalateBodySchema,
  WorkforceEscalationCancelBodySchema,
  WorkforceHandoffProposeBodySchema,
  WorkforceHandoffRespondBodySchema,
  WorkforceThreadOpenBodySchema,
  WorkforceMessageSendBodySchema,
  WorkforceStrategyAdviseBodySchema,
} from '../schemas/api-schemas.js';

const WRITE_RATE = { rateLimit: { max: 30, timeWindow: '1 minute' } } as const;

/** 域错误 → HTTP：ChronoError 透传；协作/升级/交接非法 → state（400/409 语义）。 */
function as4xx(err: unknown): never {
  if (err instanceof ChronoError) throw err;
  if (err instanceof InvalidEscalationError) throw new StateError(err.message, ErrorCode.STATE_INVALID_TRANSITION);
  if (err instanceof InvalidHandoffError) throw new StateError(err.message, ErrorCode.STATE_INVALID_TRANSITION);
  if (err instanceof InvalidCollaborationError) throw new StateError(err.message, ErrorCode.STATE_INVALID_TRANSITION);
  throw err;
}

export function registerWorkforceCollabRoutes(app: FastifyInstance, db: IDatabase, clock: Clock): void {
  const now = (): number => clock.now();
  const storeFor = (request: FastifyRequest): OrgWorkforceStore => new OrgWorkforceStore(db, request.tenantId);
  const guarded = { preHandler: requireRole('admin'), config: WRITE_RATE };
  const readGuard = { preHandler: requireRole('admin') };

  /* ── B3 升级链 ─────────────────────────────────────────────────── */
  const escFor = (request: FastifyRequest): EscalationService =>
    new EscalationService(storeFor(request), now, randomUUID, request.tenantId);

  /* 列某任务的升级记录。 */
  app.get<{ Params: { orgId: string; taskId: string } }>(
    '/api/v1/workforce/orgs/:orgId/tasks/:taskId/escalations', readGuard,
    async (request) => ({ data: storeFor(request).listEscalationsByTask(request.params.orgId, request.params.taskId) }),
  );

  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/escalations/raise', guarded, async (request, reply) => {
    const body = WorkforceEscalationRaiseBodySchema.parse(request.body);
    try {
      const esc = escFor(request).raise({ orgId: request.params.orgId, taskId: body.taskId, fromWorkerId: body.fromWorkerId, reason: body.reason, correlationId: body.correlationId ?? null });
      return reply.status(201).send({ data: esc });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; escalationId: string } }>('/api/v1/workforce/orgs/:orgId/escalations/:escalationId/resolve', guarded, async (request, reply) => {
    const body = WorkforceEscalationResolveBodySchema.parse(request.body);
    try {
      escFor(request).resolve(request.params.orgId, request.params.escalationId, body.resolvingWorkerId, body.resolution);
      return reply.status(200).send({ data: { resolved: true } });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; escalationId: string } }>('/api/v1/workforce/orgs/:orgId/escalations/:escalationId/reescalate', guarded, async (request, reply) => {
    const body = WorkforceEscalationReescalateBodySchema.parse(request.body);
    try {
      const esc = escFor(request).reescalate(request.params.orgId, request.params.escalationId, body.byWorkerId, body.reason);
      return reply.status(201).send({ data: esc });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; escalationId: string } }>('/api/v1/workforce/orgs/:orgId/escalations/:escalationId/cancel', guarded, async (request, reply) => {
    const body = WorkforceEscalationCancelBodySchema.parse(request.body);
    try {
      escFor(request).cancel(request.params.orgId, request.params.escalationId, body.byWorkerId);
      return reply.status(200).send({ data: { cancelled: true } });
    } catch (err) { as4xx(err); }
  });

  /* ── B2 任务交接 ───────────────────────────────────────────────── */
  const handoffFor = (request: FastifyRequest): HandoffService =>
    new HandoffService(storeFor(request), now, randomUUID, request.tenantId);

  app.get<{ Params: { orgId: string; taskId: string } }>(
    '/api/v1/workforce/orgs/:orgId/tasks/:taskId/handoffs', readGuard,
    async (request) => ({ data: storeFor(request).listHandoffsByTask(request.params.orgId, request.params.taskId) }),
  );

  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/handoffs/propose', guarded, async (request, reply) => {
    const body = WorkforceHandoffProposeBodySchema.parse(request.body);
    try {
      const h = handoffFor(request).propose({ orgId: request.params.orgId, taskId: body.taskId, fromWorkerId: body.fromWorkerId, toWorkerId: body.toWorkerId, reason: body.reason });
      return reply.status(201).send({ data: h });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; handoffId: string } }>('/api/v1/workforce/orgs/:orgId/handoffs/:handoffId/accept', guarded, async (request, reply) => {
    const body = WorkforceHandoffRespondBodySchema.parse(request.body);
    try {
      handoffFor(request).accept(request.params.orgId, request.params.handoffId, body.byWorkerId);
      return reply.status(200).send({ data: { accepted: true } });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; handoffId: string } }>('/api/v1/workforce/orgs/:orgId/handoffs/:handoffId/reject', guarded, async (request, reply) => {
    const body = WorkforceHandoffRespondBodySchema.parse(request.body);
    try {
      handoffFor(request).reject(request.params.orgId, request.params.handoffId, body.byWorkerId);
      return reply.status(200).send({ data: { rejected: true } });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; handoffId: string } }>('/api/v1/workforce/orgs/:orgId/handoffs/:handoffId/cancel', guarded, async (request, reply) => {
    const body = WorkforceHandoffRespondBodySchema.parse(request.body);
    try {
      handoffFor(request).cancel(request.params.orgId, request.params.handoffId, body.byWorkerId);
      return reply.status(200).send({ data: { cancelled: true } });
    } catch (err) { as4xx(err); }
  });

  /* ── B1 结构化协作消息 ─────────────────────────────────────────── */
  const commFor = (request: FastifyRequest): AgentCommunicationService =>
    new AgentCommunicationService(storeFor(request), now, randomUUID, request.tenantId);

  app.get<{ Params: { orgId: string } }>(
    '/api/v1/workforce/orgs/:orgId/threads', readGuard,
    async (request) => ({ data: storeFor(request).listThreads(request.params.orgId) }),
  );

  app.get<{ Params: { orgId: string; threadId: string } }>(
    '/api/v1/workforce/orgs/:orgId/threads/:threadId/messages', readGuard,
    async (request) => ({ data: storeFor(request).listMessages(request.params.orgId, request.params.threadId) }),
  );

  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/threads', guarded, async (request, reply) => {
    const body = WorkforceThreadOpenBodySchema.parse(request.body);
    try {
      const thread = commFor(request).openThread({ orgId: request.params.orgId, threadType: body.threadType, createdByWorkerId: body.createdByWorkerId, goalId: body.goalId ?? null, taskId: body.taskId ?? null });
      return reply.status(201).send({ data: thread });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; threadId: string } }>('/api/v1/workforce/orgs/:orgId/threads/:threadId/messages', guarded, async (request, reply) => {
    const body = WorkforceMessageSendBodySchema.parse(request.body);
    try {
      const msg = commFor(request).sendMessage({ orgId: request.params.orgId, threadId: request.params.threadId, fromWorkerId: body.fromWorkerId, toWorkerId: body.toWorkerId ?? null, messageType: body.messageType, content: body.content, correlationId: body.correlationId ?? null });
      return reply.status(201).send({ data: msg });
    } catch (err) { as4xx(err); }
  });

  app.post<{ Params: { orgId: string; threadId: string } }>('/api/v1/workforce/orgs/:orgId/threads/:threadId/close', guarded, async (request, reply) => {
    try {
      commFor(request).closeThread(request.params.orgId, request.params.threadId);
      return reply.status(200).send({ data: { closed: true } });
    } catch (err) { as4xx(err); }
  });

  /* ── M7 战略辅助（确定性展开人类战略输入为多视角备选；非自动 CEO，requiresHumanApproval）─── */
  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/strategy/advise', guarded, async (request, reply) => {
    const body = WorkforceStrategyAdviseBodySchema.parse(request.body);
    const advisory = new StrategyAdvisoryService().advise({
      objective: body.objective,
      budgetCap: body.budgetCap,
      riskTolerance: body.riskTolerance,
      initiatives: body.initiatives,
    });
    return reply.status(200).send({ data: advisory });
  });
}
