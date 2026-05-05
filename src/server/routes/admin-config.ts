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
import { PersonaDriftAnalyzer, resolveDriftThresholds } from '../../safety/persona-drift-analyzer.js';
import { DriftAlertService } from '../../safety/drift-alert-service.js';
import { ConsoleLogger } from '../../utils/logger.js';

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

  const driftThresholdFallback = {
    warning: config.safety.drift.warningThreshold,
    critical: config.safety.drift.criticalThreshold,
  };

  const driftAlertLogger = new ConsoleLogger('warn');
  const driftAlertOptions = {
    webhookUrl: config.safety.alerts.webhookUrl,
    webhookTimeoutMs: config.safety.alerts.webhookTimeoutMs,
    webhookSecret: config.safety.alerts.webhookSecret,
  };

  /* POST /api/v1/admin/safety/drift-report — 立即生成并返回漂移报告（仅 admin） */
  app.post('/api/v1/admin/safety/drift-report', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const thresholds = resolveDriftThresholds(db, driftThresholdFallback);
    const analyzer = new PersonaDriftAnalyzer(db, thresholds);
    const report = analyzer.analyze(request.tenantId);
    const alerts = new DriftAlertService({ tx: db, logger: driftAlertLogger, options: driftAlertOptions });
    const alertResult = await alerts.process(report);
    return { data: { ...report, alertEmitted: alertResult.alertEmitted, auditId: alertResult.auditId } };
  });

  /* GET /api/v1/admin/safety/drift-report — 获取最近一次漂移报告（仅 admin） */
  app.get('/api/v1/admin/safety/drift-report', {
    preHandler: requireRole('admin'),
  }, async (request, reply) => {
    const analyzer = new PersonaDriftAnalyzer(db, driftThresholdFallback);
    const report = analyzer.getLatest(request.tenantId);
    if (!report) return reply.code(404).send({ error: 'No drift report found. Run POST first.' });
    return { data: report };
  });

  /* GET /api/v1/admin/safety/status — 聚合安全指标（按 tenantId 过滤） */
  app.get('/api/v1/admin/safety/status', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const tenantId = request.tenantId;

    // 记忆置信度统计：按 tenant_id 过滤（v030 已添加 tenant_id 列）
    const memTotals = db.prepare<{ total: number; unverified: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN unverified = 1 THEN 1 ELSE 0 END) AS unverified
         FROM memory_nodes
        WHERE tenant_id = ?`,
    ).get(tenantId) ?? { total: 0, unverified: 0 };

    let bySourceKind: Record<string, number> = {};
    try {
      const kindRows = db.prepare<{ source_kind: string; count: number }>(
        `SELECT source_kind, COUNT(*) AS count
           FROM memory_nodes
          WHERE tenant_id = ?
          GROUP BY source_kind`,
      ).all(tenantId);
      bySourceKind = Object.fromEntries(kindRows.map((r) => [r.source_kind, r.count]));
    } catch { /* 列不存在时跳过 */ }

    const total = memTotals.total ?? 0;
    const unverifiedCount = memTotals.unverified ?? 0;

    // 最近漂移报告
    const analyzer = new PersonaDriftAnalyzer(db);
    const lastReport = analyzer.getLatest(tenantId);

    // 最近 10 条告警
    const recentAlerts = db.prepare<{
      id: string;
      analyzed_at: number;
      alert_level: string;
      overall_drift_score: number;
    }>(
      `SELECT id, analyzed_at, alert_level, overall_drift_score
         FROM drift_analysis_log
        WHERE tenant_id = ? AND alert_level != 'ok'
        ORDER BY analyzed_at DESC
        LIMIT 10`,
    ).all(tenantId).map((r) => ({
      reportId: r.id,
      analyzedAt: r.analyzed_at,
      alertLevel: r.alert_level,
      overallDriftScore: r.overall_drift_score,
    }));

    // 安全评分（0–100，越高越安全）
    const unverifiedRatio = total > 0 ? unverifiedCount / total : 0;
    const driftScore = lastReport?.overallDriftScore ?? 0;
    const criticalIn24h = recentAlerts.filter(
      (a) => a.alertLevel === 'critical' && a.analyzedAt > Date.now() - 86_400_000,
    ).length;
    const safetyScore = Math.max(
      0,
      Math.round(100 - unverifiedRatio * 30 - driftScore * 50 - Math.min(criticalIn24h, 2) * 10),
    );

    return {
      data: {
        memoryConfidence: {
          totalCount: total,
          unverifiedCount,
          unverifiedRatio: Math.round(unverifiedRatio * 1000) / 1000,
          bySourceKind,
        },
        personaDrift: {
          lastReport,
          recentAlerts,
        },
        safetyScore,
      },
    };
  });
}
