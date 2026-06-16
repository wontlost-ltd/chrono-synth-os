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
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, NotFoundError, ValidationError, ErrorCode } from '../../errors/index.js';
import { EarningCycleBodySchema } from '../schemas/api-schemas.js';
import {
  resolvePersonaEarningPolicy,
  PersonaGovernanceStore,
  sanitizeGovernanceOverride,
} from '../../storage/persona-governance-store.js';

interface EarningRouteServices {
  earning: PersonaEarningService;
  personaCore: PersonaCoreService;
  /** 解析 per-persona 治理策略覆盖用（缺省 → 始终 DEFAULT_EARNING_POLICY，向后兼容）。 */
  db?: IDatabase;
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

function perPersonaGovKey(request: FastifyRequest): string {
  const params = request.params as { personaId?: string };
  return `${request.tenantId ?? 'default'}:gov:${params.personaId ?? 'unknown'}`;
}

export function registerEarningRoutes(app: FastifyInstance, services: EarningRouteServices): void {
  const { earning, personaCore, db } = services;

  /* 触发挣钱周期（限流：自主劳动是经济行为，防风暴） */
  app.post<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/earning/cycle',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute', keyGenerator: perPersonaKey } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const body = EarningCycleBodySchema.parse(request.body ?? {});
      /* per-persona 治理策略：有覆盖用之，无则 DEFAULT_EARNING_POLICY（resolve 内回退，向后兼容）。 */
      const policy = db ? resolvePersonaEarningPolicy(db, request.tenantId, personaId) : undefined;
      const result = await earning.runEarningCycle({
        tenantId: request.tenantId,
        personaId,
        ownerUserId: user.sub,
        maxTasksPerCycle: body.maxTasksPerCycle,
        policy,
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

  /* 工资钱包视图（只读：余额 + token + 提现政策）。提现入口不在此（D2 必人工确认）。
   * 明细流水走既有 listWalletTransactions 路径。 */
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

  /* ── per-persona 治理策略配置（ADR-0048 治理可配化）。owner-only，与 earning 同款鉴权。 ── */

  function requireDb(): IDatabase {
    if (!db) throw new ValidationError('治理策略配置不可用（未注入 db）', ErrorCode.VALIDATION_FORMAT);
    return db;
  }

  /* GET：返回该 persona 的「有效策略」+「owner 覆盖」。无覆盖 → override=null，effective=DEFAULT。 */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/governance/policy',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const database = requireDb();
      const store = new PersonaGovernanceStore(database, request.tenantId);
      const override = store.getOverride(personaId) ?? null;
      const effective = resolvePersonaEarningPolicy(database, request.tenantId, personaId);
      /* meta：供控制台显示「谁何时改的」（无覆盖时 null）。 */
      const row = store.getRow(personaId);
      const meta = row ? { updatedBy: row.updated_by, updatedAt: row.updated_at } : null;
      return reply.status(200).send({ data: { override, effective, meta } });
    },
  );

  /* PUT：设置该 persona 的策略覆盖（sanitize 白名单校验；非法 → 400 ValidationError）。
   * 整体替换语义（非 patch）——传入即为完整覆盖对象；categoryRoutes 是完整路由表。
   * 限流：写端点，per-persona 温和限流防控制台误连点/脚本风暴（owner-only 影响面已小，但写就限）。 */
  app.put<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/governance/policy',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: perPersonaGovKey } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const database = requireDb();
      const store = new PersonaGovernanceStore(database, request.tenantId);
      /* 先在 route 层 sanitize——只把**校验错**转 400（窄 catch）。DB upsert 放在 catch 外，
       * 基础设施错误（连接/约束/执行器）保持 500，不被误报成「400 策略非法」（Codex 复审 Medium）。 */
      let clean;
      try {
        clean = sanitizeGovernanceOverride(request.body ?? {});
      } catch (err) {
        throw new ValidationError(
          `治理策略非法: ${err instanceof Error ? err.message : String(err)}`,
          ErrorCode.VALIDATION_FORMAT,
        );
      }
      /* 乐观并发：If-Match 头携带客户端读到的版本（= GET meta.updatedAt）。给定则做 CAS——
       * 版本不符（别人已改）→ 409 冲突，防后写盲覆盖前写。不带头 = last-write-wins（向后兼容）。 */
      const ifMatchRaw = request.headers['if-match'];
      const expectedUpdatedAt = typeof ifMatchRaw === 'string' && ifMatchRaw.trim() !== '' ? Number(ifMatchRaw) : undefined;
      if (expectedUpdatedAt !== undefined && !Number.isFinite(expectedUpdatedAt)) {
        throw new ValidationError('If-Match 必须是数值版本（GET meta.updatedAt）', ErrorCode.VALIDATION_FORMAT);
      }
      const ok = store.upsert(personaId, clean, user.sub, Date.now(), expectedUpdatedAt);
      if (!ok) {
        return reply.status(409).send({
          error: 'governance policy version mismatch',
          message: '该策略已被其他会话修改，请重新读取后再保存（GET 拿最新版本）',
        });
      }
      const override = store.getOverride(personaId) ?? null;
      const effective = resolvePersonaEarningPolicy(database, request.tenantId, personaId);
      const row = store.getRow(personaId);
      const meta = row ? { updatedBy: row.updated_by, updatedAt: row.updated_at } : null;
      return reply.status(200).send({ data: { override, effective, meta } });
    },
  );

  /* DELETE：清除该 persona 的策略覆盖（恢复 DEFAULT）。 */
  app.delete<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/governance/policy',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const { personaId } = request.params;
      assertOwner(personaCore, request.tenantId, user.sub, personaId);
      const database = requireDb();
      new PersonaGovernanceStore(database, request.tenantId).delete(personaId);
      /* 删除后无 row → meta=null（与 GET 无覆盖一致）。 */
      return reply.status(200).send({
        data: { override: null, effective: resolvePersonaEarningPolicy(database, request.tenantId, personaId), meta: null },
      });
    },
  );
}
