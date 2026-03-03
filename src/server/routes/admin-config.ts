/**
 * 管理配置路由
 * GET  /api/v1/admin/config       — 获取配置项列表
 * PATCH /api/v1/admin/config      — 批量更新配置
 * GET  /api/v1/admin/config/audit — 查询审计日志
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import { ConfigService } from '../../config/config-service.js';
import { requireRole } from '../plugins/rbac.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';
import type { JwtPayload } from '../../types/auth.js';

export function registerAdminConfigRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  const redis = (app as unknown as { redis?: { publish(channel: string, message: string): Promise<void> } }).redis;
  const configService = new ConfigService(db, config, redis);

  /* GET /api/v1/admin/config — 按角色获取配置 */
  app.get('/api/v1/admin/config', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const user = request.user as JwtPayload | undefined;
    const role = user?.role ?? 'admin';
    const items = configService.getConfigItems(role);
    const effective = configService.getEffectiveConfig(role);
    return { data: { items, effective } };
  });

  /* PATCH /api/v1/admin/config — 批量更新配置（限流: 10 次/分钟） */
  app.patch('/api/v1/admin/config', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('请求体必须为对象', ErrorCode.VALIDATION_FORMAT);
    }

    const user = request.user as JwtPayload | undefined;
    const changedBy = user?.sub ?? 'admin';

    const result = await configService.applyPatch(body, changedBy);
    return {
      data: {
        updated: result.updated,
        requiresRestart: result.requiresRestart,
      },
    };
  });

  /* GET /api/v1/admin/config/audit — 审计日志 */
  app.get('/api/v1/admin/config/audit', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(query.offset ?? '0', 10) || 0;
    const audit = configService.getAudit(limit, offset);
    return { data: audit };
  });
}
