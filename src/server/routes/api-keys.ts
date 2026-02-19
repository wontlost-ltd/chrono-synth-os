/**
 * API Key 管理路由
 * POST   /api/v1/api-keys      — 创建新 API Key（返回明文，仅此一次）
 * GET    /api/v1/api-keys      — 列出当前租户的所有 API Key（不含明文）
 * DELETE /api/v1/api-keys/:id  — 吊销指定 API Key
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type { IDatabase } from '../../storage/database.js';
import { CreateApiKeySchema } from '../schemas/api-schemas.js';
import { AuthenticationError, ErrorCode } from '../../errors/index.js';

interface ApiKeyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly key_hash: string;
  readonly plan_id: string;
  readonly is_revoked: number;
  readonly created_at: number;
}

/** 生成 48 字节随机 API Key（base64url 编码，64 字符） */
function generateApiKey(): string {
  return `csk_${randomBytes(36).toString('base64url')}`;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function registerApiKeyRoutes(app: FastifyInstance, db: IDatabase): void {
  /* POST /api/v1/api-keys — 创建 */
  app.post('/api/v1/api-keys', async (request, reply) => {
    const user = (request as unknown as { user?: { sub?: string; tenantId?: string; role?: string } }).user;
    if (!user?.sub) {
      throw new AuthenticationError('需要认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    /* 仅 admin 可创建 API Key */
    if (user.role !== 'admin') {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INSUFFICIENT_ROLE',
        message: '仅管理员可创建 API Key',
      });
    }

    const body = CreateApiKeySchema.parse(request.body);
    const tenantId = user.tenantId ?? 'default';

    /* API Key 计划必须与租户当前订阅一致，防止越权 */
    const activeSub = db.prepare<{ plan_id: string }>(
      `SELECT plan_id FROM subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId);
    const tenantPlanId = activeSub?.plan_id ?? 'free';
    const planId = body.planId === 'free' ? tenantPlanId : body.planId;
    if (planId !== tenantPlanId) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'PLAN_MISMATCH',
        message: `API Key 计划必须与当前订阅一致（当前: ${tenantPlanId}）`,
      });
    }

    const apiKey = generateApiKey();
    const keyHash = hashKey(apiKey);
    const id = `ak_${randomUUID()}`;
    const now = Date.now();

    db.prepare<void>(
      'INSERT INTO api_keys (id, tenant_id, key_hash, plan_id, is_revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(id, tenantId, keyHash, planId, now);

    return reply.status(201).send({
      data: {
        id,
        tenantId,
        planId,
        apiKey, /* 明文仅在创建时返回 */
        createdAt: now,
      },
    });
  });

  /* GET /api/v1/api-keys — 列出（仅管理员） */
  app.get('/api/v1/api-keys', async (request, reply) => {
    const user = (request as unknown as { user?: { sub?: string; tenantId?: string; role?: string } }).user;
    if (!user?.sub) {
      throw new AuthenticationError('需要认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    if (user.role !== 'admin') {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INSUFFICIENT_ROLE',
        message: '仅管理员可查看 API Key 列表',
      });
    }

    const tenantId = user.tenantId ?? 'default';
    const rows = db.prepare<ApiKeyRow>(
      'SELECT id, tenant_id, plan_id, is_revoked, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
    ).all(tenantId);

    return {
      data: rows.map(r => ({
        id: r.id,
        tenantId: r.tenant_id,
        planId: r.plan_id,
        isRevoked: r.is_revoked === 1,
        createdAt: r.created_at,
      })),
    };
  });

  /* DELETE /api/v1/api-keys/:id — 吊销 */
  app.delete<{ Params: { id: string } }>('/api/v1/api-keys/:id', async (request, reply) => {
    const user = (request as unknown as { user?: { sub?: string; tenantId?: string; role?: string } }).user;
    if (!user?.sub) {
      throw new AuthenticationError('需要认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    if (user.role !== 'admin') {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INSUFFICIENT_ROLE',
        message: '仅管理员可吊销 API Key',
      });
    }

    const tenantId = user.tenantId ?? 'default';
    const { id } = request.params;

    const result = db.prepare<void>(
      'UPDATE api_keys SET is_revoked = 1 WHERE id = ? AND tenant_id = ? AND is_revoked = 0',
    ).run(id, tenantId);

    if (result.changes === 0) {
      return reply.status(404).send({
        error: 'NotFoundError',
        code: 'API_KEY_NOT_FOUND',
        message: 'API Key 不存在或已吊销',
      });
    }

    return reply.status(200).send({ data: { id, revoked: true } });
  });
}
