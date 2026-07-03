/**
 * 工具自动授权运营路由（ADR-0060 T7 生产接线，owner-only）。
 *
 * 把 T5 的 ToolAutoAuthorizationBridge + tool_authorization_requests 接入 HTTP——owner 能从管理台：
 *   POST /api/v1/persona-core/:personaId/tool-auto-auth/run                据有效 eligibility 建议自动处理授权
 *                                                                          （白名单低险→授 ToolPermission / 其余→建待审批）
 *   GET  /api/v1/persona-core/:personaId/tool-auto-auth/pending            列出待审批工具授权请求
 *   POST /api/v1/persona-core/:personaId/tool-auto-auth/requests/:id/decide  批准/拒绝一条待审批请求
 *
 * 守 ADR-0060 红线：
 *   - 只 owner（用户 JWT）可访问（assertOwner）——授权是敏感动作，非 apikey/匿名；
 *   - run 只调 ToolAutoAuthorizationBridge（红线 2/3/13：白名单低险才自动授，高险/非白名单只建待审批，不越权 grant）；
 *   - 治理白名单本身在既有 governance/policy 端点配（toolAutoAuthWhitelist 是 PersonaGovernanceOverride 字段，
 *     sanitize 已认）——本路由只做「运营」（触发/审批），不改治理配置；
 *   - decide 批准**不等于**自动授予——批准只是把待审批请求转 approved 状态留痕，真正授权仍需 owner 显式经既有
 *     admin tool-permissions grant（高险人工授权铁律，红线 3）。approve 只表达「人已看过并认可」，不旁路授权门。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { IDatabase } from '../../storage/database.js';
import type { ToolRegistry } from '../../agent/tool-registry.js';
import type { Logger } from '../../utils/logger.js';
import type { Clock } from '../../utils/clock.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, NotFoundError, StateError, ErrorCode } from '../../errors/index.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { ToolAutoAuthorizationBridge } from '../../intelligence/tool-auto-authorization-bridge.js';
import { ToolAuthorizationRequestStore } from '../../storage/tool-authorization-request-store.js';
import { DecideToolAuthorizationRequestSchema } from '../schemas/api-schemas.js';

export interface ToolAutoAuthorizationRouteDeps {
  readonly db: IDatabase;
  readonly registry: ToolRegistry;
  readonly personaCore: PersonaCoreService;
  readonly logger: Logger;
  readonly clock: Clock;
}

function requireJwtUser(request: FastifyRequest): JwtPayload {
  const user = request.user as JwtPayload | undefined;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError('工具自动授权仅支持用户 JWT 访问', ErrorCode.AUTH_INSUFFICIENT_ROLE);
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
  /* 限流键纳入已认证 user（Codex T7 复审补）：仅按 tenant+persona 时，知道 personaId 的非 owner 也能消耗该
   * persona 的 run/decide 配额（虽 owner 门控挡住实际操作，但配额本身可被打满）。加 user 隔离到调用者自身。 */
  const user = request.user as { sub?: string } | undefined;
  return `${request.tenantId ?? 'default'}:tauth:${params.personaId ?? 'unknown'}:${user?.sub ?? 'anon'}`;
}

export function registerToolAutoAuthorizationRoutes(app: FastifyInstance, deps: ToolAutoAuthorizationRouteDeps): void {
  const { db, registry, personaCore, logger, clock } = deps;

  /* 触发一次自动授权处理：据有效 eligibility 建议，白名单低险自动授 ToolPermission / 其余建待审批。
   * 限流：授予/建请求是敏感写动作，per-persona 温和限流防误连点/脚本风暴。 */
  app.post<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/tool-auto-auth/run',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute', keyGenerator: perPersonaKey } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const bridge = new ToolAutoAuthorizationBridge({
        db,
        permissions: new ToolPermissionService(db),
        registry,
        logger,
        tenantId: request.tenantId,
        now: () => clock.now(),
      });
      /* grantedBy = 发起 owner（审计谁触发的自动授权）。 */
      const result = bridge.run(personaId, user.sub);
      return reply.status(200).send({ data: result });
    },
  );

  /* 列出待审批工具授权请求（非白名单/高险 eligibility 建议进这里，等 owner 决议）。 */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/tool-auto-auth/pending',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const store = new ToolAuthorizationRequestStore(db, request.tenantId);
      return reply.status(200).send({ data: store.listPending(personaId) });
    },
  );

  /* 决议一条待审批请求（approved/rejected）。仅 pending → 目标状态（防重复决议）。
   * ⚠️ approved 只留痕「人已认可」，**不**自动授予 ToolPermission——真正授权仍需 owner 显式经 admin grant
   * （高险人工授权铁律，红线 3）。 */
  app.post<{ Params: { personaId: string; requestId: string } }>(
    '/api/v1/persona-core/:personaId/tool-auto-auth/requests/:requestId/decide',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: perPersonaKey } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId, requestId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const body = DecideToolAuthorizationRequestSchema.parse(request.body ?? {});
      const store = new ToolAuthorizationRequestStore(db, request.tenantId);
      /* 校验该请求确属此 persona（防跨 persona 用 requestId 决议——虽同租户但 owner 只该动自己 persona 的）。 */
      const belongs = store.listPending(personaId).some((r) => r.id === requestId);
      if (!belongs) {
        throw new NotFoundError('待审批请求不存在、已决议、或不属于该 persona', ErrorCode.NOT_FOUND_VALUE);
      }
      const ok = store.decide(requestId, body.decision, user.sub, clock.now());
      if (!ok) {
        /* 并发：belongs 检查与 decide 之间被别的会话决议了 → 报「状态非法转移」。 */
        throw new StateError('请求已被决议（pending → 已终态），请刷新列表', ErrorCode.STATE_INVALID_TRANSITION);
      }
      return reply.status(200).send({ data: { requestId, decision: body.decision } });
    },
  );
}
