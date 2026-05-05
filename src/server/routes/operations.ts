/**
 * 演化和调控操作路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../../config/schema.js';
import { RunRegulationSchema } from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';
import { PersonaDriftAnalyzer, resolveDriftThresholds } from '../../safety/persona-drift-analyzer.js';
import { recordBusinessAuditLog } from '../../audit/audit-log-store.js';

export function registerOperationRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory, config?: AppConfig): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* POST /api/v1/operations/evolution/run — 运行演化周期（仅 admin，限流: 5 次/分钟） */
  app.post('/api/v1/operations/evolution/run', { preHandler: requireRole('admin'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const tenantOS = getOS(request);
    const result = tenantOS.runEvolutionCycle();

    // 演化完成后自动触发漂移分析，失败不影响演化结果
    try {
      const fallback = config?.safety
        ? { warning: config.safety.drift.warningThreshold, critical: config.safety.drift.criticalThreshold }
        : undefined;
      const thresholds = resolveDriftThresholds(tenantOS.getDatabase(), fallback);
      const analyzer = new PersonaDriftAnalyzer(tenantOS.getDatabase(), thresholds);
      const driftReport = analyzer.analyze(request.tenantId);
      if (driftReport.alertLevel !== 'ok') {
        recordBusinessAuditLog(tenantOS.getDatabase(), {
          tenantId: request.tenantId,
          actorType: 'system',
          actorId: 'drift-monitor',
          actionType: `persona.drift.${driftReport.alertLevel}`,
          targetType: 'drift_report',
          targetId: driftReport.reportId,
          payload: {
            alertLevel: driftReport.alertLevel,
            overallDriftScore: driftReport.overallDriftScore,
            affectedValues: driftReport.valueDrifts.filter((d) => d.alertLevel !== 'ok').length,
          },
        });
      }
    } catch { /* 漂移分析失败不影响演化结果 */ }

    return { data: result };
  });

  /* POST /api/v1/operations/regulation/run — 运行调控周期（仅 admin，限流: 5 次/分钟） */
  app.post('/api/v1/operations/regulation/run', { preHandler: requireRole('admin'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const body = RunRegulationSchema.parse(request.body ?? {});
    const tenantOS = getOS(request);
    tenantOS.runRegulationCycle(body?.strategy);
    return { data: { status: 'completed', strategy: body?.strategy ?? 'equal' } };
  });
}
