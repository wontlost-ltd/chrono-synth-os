/**
 * 分身路由
 * GET    /api/v1/avatars              — 列出当前身份所有分身
 * POST   /api/v1/avatars              — 创建分身（含配额检查）
 * GET    /api/v1/avatars/:id          — 获取分身详情
 * PATCH  /api/v1/avatars/:id          — 更新分身
 * DELETE /api/v1/avatars/:id          — 软删除分身
 * GET    /api/v1/avatars/:id/projection — 获取投影后的人格状态
 * GET    /api/v1/avatars/:id/snapshot — 跨设备快照（projection + autorun + drift + devices）
 * POST   /api/v1/avatars/:id/handoff  — 生成跨设备切换令牌
 * POST   /api/v1/avatars/:id/resume   — 消费切换令牌，恢复会话
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../../storage/database.js';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { JwtPayload } from '../../types/auth.js';
import type { AvatarSnapshot, HandoffToken } from '../../types/avatar-session.js';
import { IdentityService } from '../../identity/identity-service.js';
import { AvatarService } from '../../identity/avatar-service.js';
import { AvatarSnapshotService } from '../../identity/avatar-snapshot-service.js';
import { computeProjection } from '../../identity/avatar-projection-engine.js';
import { compilePersonaState } from '../../intelligence/persona-state.js';
import { getPlanLimits } from '../../billing/plans.js';
import { NotFoundError, QuotaExceededError, ErrorCode } from '../../errors/index.js';
import { CreateAvatarSchema, UpdateAvatarSchema } from '../schemas/api-schemas.js';
import { currentGlobalSeq } from '../plugins/websocket.js';

export function registerAvatarRoutes(app: FastifyInstance, db: IDatabase, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  const identityService = new IdentityService(db);
  const avatarService = new AvatarService(db);
  const snapshotService = new AvatarSnapshotService(db, app.log);

  function getTenantOS(tenantId: string): ChronoSynthOS {
    if (tenantFactory && tenantId && tenantId !== 'default') return tenantFactory.getTenantOS(tenantId);
    return os;
  }

  function requireIdentity(user: JwtPayload) {
    const identity = identityService.getByUser(user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    return identity;
  }

  function requireOwnedAvatar(user: JwtPayload, avatarId: string) {
    const identity = requireIdentity(user);
    const avatar = avatarService.getByIdForIdentity(avatarId, identity.id);
    if (!avatar) throw new NotFoundError(`分身 ${avatarId} 不存在`, ErrorCode.NOT_FOUND_AVATAR);
    return { identity, avatar };
  }

  /** 将内部 Avatar 转换为前端 DTO（补充 status / ISO 时间） */
  function toAvatarDto(a: NonNullable<ReturnType<typeof avatarService.getById>>) {
    return {
      ...a,
      status: a.isActive ? 'active' : 'offline',
      createdAt: new Date(Number(a.createdAt)).toISOString(),
      updatedAt: new Date(Number(a.updatedAt)).toISOString(),
    };
  }

  /* GET /api/v1/avatars */
  app.get('/api/v1/avatars', async (request) => {
    const user = request.user as JwtPayload;
    const identity = requireIdentity(user);
    const avatars = avatarService.listByIdentity(identity.id);
    return { data: avatars.map(toAvatarDto) };
  });

  /* POST /api/v1/avatars */
  app.post('/api/v1/avatars', async (request, reply) => {
    const user = request.user as JwtPayload;
    const identity = requireIdentity(user);
    const body = CreateAvatarSchema.parse(request.body);

    /* 配额检查 */
    const limits = getPlanLimits(user.planId ?? 'free');
    if (limits.maxAvatars >= 0) {
      const count = avatarService.countActive(identity.id);
      if (count >= limits.maxAvatars) {
        throw new QuotaExceededError(
          `分身配额已满（${limits.maxAvatars}），请升级计划`,
          ErrorCode.QUOTA_EXCEEDED,
        );
      }
    }

    const avatar = avatarService.create(identity.id, body);
    return reply.status(201).send({ data: toAvatarDto(avatar) });
  });

  /* GET /api/v1/avatars/:id */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id', async (request) => {
    const user = request.user as JwtPayload;
    const { avatar } = requireOwnedAvatar(user, request.params.id);
    return { data: toAvatarDto(avatar) };
  });

  /* PATCH /api/v1/avatars/:id */
  app.patch<{ Params: { id: string } }>('/api/v1/avatars/:id', async (request) => {
    const user = request.user as JwtPayload;
    const { identity } = requireOwnedAvatar(user, request.params.id);
    const body = UpdateAvatarSchema.parse(request.body);
    const avatar = avatarService.updateForIdentity(request.params.id, identity.id, body);
    if (!avatar) throw new NotFoundError(`分身 ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_AVATAR);
    return { data: avatar };
  });

  /* DELETE /api/v1/avatars/:id */
  app.delete<{ Params: { id: string } }>('/api/v1/avatars/:id', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { identity } = requireOwnedAvatar(user, request.params.id);
    const deleted = avatarService.softDeleteForIdentity(request.params.id, identity.id);
    if (!deleted) throw new NotFoundError(`分身 ${request.params.id} 不存在或为默认分身`, ErrorCode.NOT_FOUND_AVATAR);
    return reply.status(204).send();
  });

  /* 投影计算共用逻辑 */
  async function handleProjection(request: { user: unknown; tenantId?: string }, id: string) {
    const user = request.user as JwtPayload;
    const { avatar } = requireOwnedAvatar(user, id);

    const tenantOS = getTenantOS(user.tenantId);
    const baseState = compilePersonaState(tenantOS.core);
    const projected = computeProjection(baseState, avatar);

    return {
      data: {
        avatarId: id,
        avatarLabel: avatar.label,
        avatarKind: avatar.kind,
        L0: projected.L0,
        L1: Object.fromEntries(projected.L1),
        L2: projected.L2,
        L3: {
          beliefs: Object.fromEntries(projected.L3.beliefs),
          biasWeights: Object.fromEntries(projected.L3.biasWeights),
          attributionStyle: projected.L3.attributionStyle,
          growthMindset: projected.L3.growthMindset,
        },
        L4: {
          narrative: projected.L4.narrative,
          memoryCount: projected.L4.memories.size,
          edgeCount: projected.L4.edges.length,
        },
      },
    };
  }

  /* GET /api/v1/avatars/:id/projection */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/projection', async (request) => {
    return handleProjection(request, request.params.id);
  });

  /* POST /api/v1/avatars/:id/project — 前端投影触发 */
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/project', async (request) => {
    return handleProjection(request, request.params.id);
  });

  /* GET /api/v1/avatars/:id/snapshot — 跨设备快照 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/snapshot', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params;
    const { avatar } = requireOwnedAvatar(user, id);

    const tenantOS = getTenantOS(user.tenantId);
    const baseState = compilePersonaState(tenantOS.core);
    const projected = computeProjection(baseState, avatar);

    const autorun = snapshotService.getAutorunState(user.tenantId, id);
    const drift = snapshotService.getDriftState(user.tenantId, id);
    const installedDevices = snapshotService.getInstalledDevices(id);

    const snapshot: AvatarSnapshot = {
      avatarId: id,
      seq: currentGlobalSeq(),
      projection: {
        L0: projected.L0,
        L1: Object.fromEntries(projected.L1),
        L2: { ...projected.L2 },
        L3: {
          beliefs: Object.fromEntries(projected.L3.beliefs),
          biasWeights: Object.fromEntries(projected.L3.biasWeights),
          attributionStyle: projected.L3.attributionStyle,
          growthMindset: projected.L3.growthMindset,
        },
        L4: {
          narrative: projected.L4.narrative,
          memoryCount: projected.L4.memories.size,
        },
      },
      autorun,
      drift,
      installedDevices,
    };

    return { data: snapshot };
  });

  /* ── 跨设备 Handoff ── */

  /** 内存中的 handoff token 存储（短生命周期，5 分钟过期） */
  const handoffTokens = new Map<string, HandoffToken>();
  const HANDOFF_TTL_MS = 5 * 60 * 1000;

  /* POST /api/v1/avatars/:id/handoff — 生成跨设备切换令牌 */
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/handoff', async (request, reply) => {
    const { id } = request.params;
    const user = request.user as JwtPayload;
    requireOwnedAvatar(user, id);

    const body = request.body as { deviceId?: string } | undefined;
    const fromDeviceId = body?.deviceId ?? 'unknown';

    const token: HandoffToken = {
      token: randomUUID(),
      avatarId: id,
      fromDeviceId,
      lastSeq: currentGlobalSeq(),
      expiresAt: Date.now() + HANDOFF_TTL_MS,
    };

    handoffTokens.set(token.token, token);

    /* 清理过期 token */
    const now = Date.now();
    for (const [key, val] of handoffTokens) {
      if (val.expiresAt < now) handoffTokens.delete(key);
    }

    return reply.status(201).send({ data: token });
  });

  /* POST /api/v1/avatars/:id/resume — 消费切换令牌 */
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/resume', async (request) => {
    const { id } = request.params;
    const user = request.user as JwtPayload;
    requireOwnedAvatar(user, id);
    const body = request.body as { token?: string } | undefined;
    if (!body?.token) throw new NotFoundError('缺少 handoff token', ErrorCode.VALIDATION_REQUIRED);

    const handoff = handoffTokens.get(body.token);
    if (!handoff || handoff.avatarId !== id) {
      throw new NotFoundError('handoff token 无效或已过期', ErrorCode.NOT_FOUND_AVATAR);
    }
    if (handoff.expiresAt < Date.now()) {
      handoffTokens.delete(body.token);
      throw new NotFoundError('handoff token 已过期', ErrorCode.NOT_FOUND_AVATAR);
    }

    /* 消费 token（一次性使用） */
    handoffTokens.delete(body.token);

    return {
      data: {
        avatarId: id,
        fromDeviceId: handoff.fromDeviceId,
        resumeFromSeq: handoff.lastSeq,
        currentSeq: currentGlobalSeq(),
      },
    };
  });
}
