/**
 * Agent 待确认列表路由（F3）
 *
 * 端点：
 *   GET    /api/v1/agent/confirmations/pending           — 当前用户待确认调用
 *   GET    /api/v1/agent/confirmations/:tokenId          — 单条详情（不返回 input 内容）
 *   POST   /api/v1/agent/confirmations/:tokenId/approve  — 重发工具调用并附 confirmationToken
 *   POST   /api/v1/agent/confirmations/:tokenId/reject   — 拒绝（updateStatus → denied_permission）
 *
 * 设计取舍：
 *   - 数据库不持久化原始 arguments（避免 PII）；approve 时必须由客户端重新提交 arguments
 *   - tokenId 是 confirmation_token_id（cct_xxx），与 tool_invocations.confirmation_token_id 字段一致
 *   - 限制每用户最多返回 50 条 pending；超出建议清理
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoMcpServer } from '../../mcp/chrono-mcp-server.js';
import type { ToolPermissionService } from '../../agent/tool-permission-service.js';
import type { UserOauthTokenResolverFactory } from '../agent-oauth-resolver.js';
import { ValidationError, NotFoundError, AuthenticationError, ErrorCode } from '../../errors/index.js';
import type { JwtPayload } from '../../types/auth.js';
import {
  AgentConfirmationsPendingQuerySchema,
  AgentConfirmationsApproveBodySchema,
  AgentConfirmationsRejectBodySchema,
} from '../schemas/api-schemas.js';

export interface RegisterAgentConfirmationsDeps {
  readonly mcpServer: ChronoMcpServer;
  readonly permissions: ToolPermissionService;
  readonly oauthResolverFactory: UserOauthTokenResolverFactory | null;
}

export function registerAgentConfirmationsRoutes(
  app: FastifyInstance,
  deps: RegisterAgentConfirmationsDeps,
): void {
  const rateLimit = {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: 60_000,
        keyGenerator: (request: { ip: string }) => request.ip,
      },
    },
  };

  app.get<{ Querystring: { limit?: number } }>(
    '/api/v1/agent/confirmations/pending',
    rateLimit,
    async (request) => {
      const user = requireUser(request);
      const q = AgentConfirmationsPendingQuerySchema.parse(request.query);
      const items = deps.permissions.listPendingByUser(request.tenantId, user.sub, q.limit);
      return { data: items.map(toListItem) };
    },
  );

  app.get<{ Params: { tokenId: string } }>(
    '/api/v1/agent/confirmations/:tokenId',
    rateLimit,
    async (request) => {
      const user = requireUser(request);
      const inv = deps.permissions.getByConfirmationToken(request.tenantId, request.params.tokenId);
      if (!inv || inv.invokerUserId !== user.sub) {
        throw new NotFoundError('待确认调用不存在或不属于当前用户', ErrorCode.NOT_FOUND_VALUE);
      }
      return { data: toListItem(inv) };
    },
  );

  app.post<{ Params: { tokenId: string }; Body: unknown }>(
    '/api/v1/agent/confirmations/:tokenId/approve',
    rateLimit,
    async (request, reply) => {
      const user = requireUser(request);
      const body = AgentConfirmationsApproveBodySchema.parse(request.body);
      const inv = deps.permissions.getByConfirmationToken(request.tenantId, request.params.tokenId);
      if (!inv || inv.invokerUserId !== user.sub) {
        throw new NotFoundError('待确认调用不存在或不属于当前用户', ErrorCode.NOT_FOUND_VALUE);
      }
      if (inv.status !== 'pending_confirmation') {
        throw new ValidationError(
          `调用状态非 pending_confirmation: ${inv.status}`,
          ErrorCode.STATE_INVALID_TRANSITION,
        );
      }

      /* 重发 tools/call，附 confirmationToken；MCP 内层会消费 token + 真正执行工具 */
      const oauthResolver = deps.oauthResolverFactory
        ? deps.oauthResolverFactory(request.tenantId, user.sub)
        : undefined;
      const response = await deps.mcpServer.handle(
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'tools/call',
          params: {
            name: inv.toolId,
            arguments: body.arguments,
            confirmationToken: request.params.tokenId,
          },
        },
        {
          tenantId: request.tenantId,
          personaId: inv.personaId,
          invokerId: user.sub,
          invokerUserId: user.sub,
          invokerType: user.role === 'admin' ? 'admin' : 'mcp',
          oauthResolver,
        },
      );
      return reply.send({ data: response });
    },
  );

  app.post<{ Params: { tokenId: string } }>(
    '/api/v1/agent/confirmations/:tokenId/reject',
    rateLimit,
    async (request, reply) => {
      const user = requireUser(request);
      const body = AgentConfirmationsRejectBodySchema.parse(request.body ?? {});
      const inv = deps.permissions.getByConfirmationToken(request.tenantId, request.params.tokenId);
      if (!inv || inv.invokerUserId !== user.sub) {
        throw new NotFoundError('待确认调用不存在或不属于当前用户', ErrorCode.NOT_FOUND_VALUE);
      }
      if (inv.status !== 'pending_confirmation') {
        throw new ValidationError(
          `调用状态非 pending_confirmation: ${inv.status}`,
          ErrorCode.STATE_INVALID_TRANSITION,
        );
      }
      deps.permissions.updateInvocationStatus({
        id: inv.id,
        status: 'denied_permission',
        outputSizeBytes: 0,
        errorMessage: `user_rejected: ${body.reason}`,
        costCents: 0,
        durationMs: 0,
      });
      return reply.send({ data: { rejected: true } });
    },
  );
}

function requireUser(request: { user?: unknown }): JwtPayload {
  const u = request.user as JwtPayload | undefined;
  if (!u?.sub) {
    throw new AuthenticationError('需要 JWT 认证', ErrorCode.AUTH_INVALID_TOKEN);
  }
  return u;
}

function toListItem(inv: import('@chrono/kernel').ToolInvocation) {
  return {
    invocationId: inv.id,
    toolId: inv.toolId,
    personaId: inv.personaId,
    invokerType: inv.invokerType,
    confirmationTokenId: inv.confirmationTokenId,
    invokedAt: inv.invokedAt,
    inputHash: inv.inputHash,
    status: inv.status,
  };
}
