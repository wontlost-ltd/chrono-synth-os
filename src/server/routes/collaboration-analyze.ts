/**
 * POST /api/v1/collaboration/analyze —— 多数字人协同分析端点（spec §5.4）。
 *
 * 运行时零-LLM：分析全程走 CollaborativeAnalysisService 的确定性三段基元（检索/决策/组织），
 * 端点只负责鉴权门 + body 校验委托 + 单键信封，业务校验/降级/fail-closed 全在 service。
 *
 * 鉴权：复用 companion「仅个人用户会话」访问门（拒 API-key / service 主体），避免机器主体越权拉取
 * 他人 persona 的学习积累。租户/身份从鉴权上下文取（request.tenantId / request.user.sub）。
 *
 * 错误映射走全局 error handler：service 抛 NotFoundError → 404（未知/跨 owner persona，不泄露存在性）、
 * ValidationError → 400；fastify body schema 校验失败自动 400。
 *
 * 注：文件与导出命名带 -analyze/-Analyze 后缀，避免与既有 collaboration.ts（模拟分享路由）的
 * registerCollaborationRoutes 冲突——这是本仓库真实惯例，与计划里的裸名不同。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CollaborativeAnalysisService } from '../../collaboration/collaborative-analysis-service.js';
import { AuthorizationError, ErrorCode } from '../../errors/index.js';
import type { JwtPayload } from '../../types/auth.js';

/** 复用 companion 访问门（照 companion/chat.ts:118）：拒 API-key（apikey:* sub）/ service 角色主体。 */
function assertUserSession(request: FastifyRequest): void {
  const user = request.user as JwtPayload | undefined;
  if (user?.sub?.startsWith('apikey:') || user?.role === 'service') {
    throw new AuthorizationError(
      '协同分析仅支持个人用户会话，不支持 API Key / service 主体访问',
      ErrorCode.AUTH_INSUFFICIENT_ROLE,
    );
  }
}

/** 请求体 schema：question 非空字符串、personaIds 非空字符串数组、alternatives 可选字符串数组。 */
const bodySchema = {
  type: 'object',
  required: ['question', 'personaIds'],
  properties: {
    question: { type: 'string', minLength: 1 },
    personaIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    alternatives: { type: 'array', items: { type: 'string' } },
  },
} as const;

interface AnalyzeBody {
  readonly question: string;
  readonly personaIds: readonly string[];
  readonly alternatives?: readonly string[];
}

export function registerCollaborationAnalyzeRoutes(
  app: FastifyInstance,
  service: CollaborativeAnalysisService,
): void {
  app.post(
    '/api/v1/collaboration/analyze',
    { schema: { body: bodySchema } },
    async (request, reply) => {
      assertUserSession(request);
      const { question, alternatives, personaIds } = request.body as AnalyzeBody;
      const tenantId = request.tenantId;
      const ownerUserId = (request.user as JwtPayload).sub;
      const report = service.analyze(tenantId, ownerUserId, personaIds, { question, alternatives });
      /* 单键 {data} 信封（前端自动解包，与全仓 route 惯例一致）。 */
      return reply.send({ data: report });
    },
  );
}
