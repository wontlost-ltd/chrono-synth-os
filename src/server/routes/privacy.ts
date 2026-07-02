/**
 * 隐私与信任控制路由 (GDPR / 数据可移植性)
 * 路由层只做请求解析和响应序列化，业务逻辑委托 PrivacyService
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { CommitImportBodySchema, DryRunImportBodySchema, PaginationQuerySchema } from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';
import { recordPrivacyAudit } from '../../audit/privacy-audit.js';

export function registerPrivacyRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory?: TenantOSFactory,
  config?: AppConfig,
): void {
  const service = new PrivacyService(os, tenantFactory, config);

  /* 隐私业务审计（GDPR Art.12/SOC2）——委托共享 recordPrivacyAudit，v1/v2 同一实现不漂移（F5）。 */
  const auditPrivacy = (request: { tenantId: string; user?: unknown }, actionType: string, targetId: string, payload: Record<string, unknown>): void =>
    recordPrivacyAudit(os.getDatabase(), request, actionType, targetId, payload);

  /* POST /api/v1/privacy/export — 完整租户数据导出（仅 admin，限流: 3 次/分钟） */
  app.post('/api/v1/privacy/export', { preHandler: requireRole('admin'), config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request) => {
    const result = service.exportData(request.tenantId);
    auditPrivacy(request, 'privacy.export.completed', result.exportId, {
      exportId: result.exportId, format: result.format, tableCount: Object.keys(result.content.tables).length,
    });
    return { data: result };
  });

  /* DELETE /api/v1/privacy/data — GDPR Right to Erasure（仅 admin，限流: 1 次/分钟）。
   * active legal hold 期间擦除被阻断（GDPR Art.17(3)(b)）→ 返回 409 Conflict。 */
  app.delete('/api/v1/privacy/data', { preHandler: requireRole('admin'), config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async (request, reply) => {
    const result = service.eraseData(request.tenantId);
    if (result.blocked) {
      reply.code(409);
      auditPrivacy(request, 'privacy.erase.blocked', request.tenantId, {
        blockingHoldId: result.blockingHoldId, reason: result.reason,
      });
    } else {
      auditPrivacy(request, 'privacy.erase.completed', request.tenantId, {
        tablesAffected: result.tablesAffected,
        totalRowsDeleted: Object.values(result.tablesAffected).reduce((a, b) => a + b, 0),
      });
    }
    return { data: result };
  });

  /* GET /api/v1/privacy/audit-trail — 租户审计日志（分页） */
  app.get('/api/v1/privacy/audit-trail', async (request) => {
    const { page, pageSize } = PaginationQuerySchema.parse(request.query);
    const result = service.getAuditTrail(request.tenantId, page, pageSize);
    return { data: result.data, pagination: result.pagination };
  });

  /* POST /api/v1/privacy/export/start — 启动异步导出任务（仅 admin） */
  app.post('/api/v1/privacy/export/start', { preHandler: requireRole('admin'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const status = service.startExportJob(request.tenantId);
    auditPrivacy(request, 'privacy.export.started', status.exportId, { exportId: status.exportId, state: status.state });
    return { data: status };
  });

  /* GET /api/v1/privacy/export/jobs — 列出租户全部导出任务（仅 admin） */
  app.get('/api/v1/privacy/export/jobs', { preHandler: requireRole('admin') }, async (request) => {
    const jobs = service.listExportJobs(request.tenantId);
    return { data: jobs };
  });

  /* GET /api/v1/privacy/export/:exportId — 查询导出任务状态 */
  app.get('/api/v1/privacy/export/:exportId', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { exportId } = request.params as { exportId: string };
    const status = service.getExportJobStatus(request.tenantId, exportId);
    if (!status) return reply.code(404).send({ error: 'Export job not found' });
    return { data: status };
  });

  /* GET /api/v1/privacy/export/:exportId/download — 下载 pack manifest JSON */
  app.get('/api/v1/privacy/export/:exportId/download', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { exportId } = request.params as { exportId: string };
    const db = os.getDatabase();
    const row = db.prepare<{ pack_json: string | null; download_url: string | null; state: string; tenant_id: string }>(
      'SELECT pack_json, download_url, state, tenant_id FROM export_jobs WHERE id = ?',
    ).get(exportId);

    if (!row || row.tenant_id !== request.tenantId) {
      return reply.code(404).send({ error: 'Export job not found' });
    }
    if (row.state !== 'completed') {
      return reply.code(409).send({ error: 'Export not yet completed' });
    }

    /* 导出下载=个人数据流出租户，留业务审计（Art.12 知情权：谁在何时取走了导出包）。审计只在**真实交付**分支内
     * 记录——completed 但无 url 且无 pack 的异常态会走到底部 404，不应误记一次「已下载」（Codex 复审）。 */

    // 优先重定向到预签名 URL
    if (row.download_url) {
      auditPrivacy(request, 'privacy.export.downloaded', exportId, { exportId, via: 'presigned_url' });
      return reply.code(302).redirect(row.download_url);
    }

    // 回退：直接返回内联 manifest JSON（向后兼容旧记录；捆绑格式仅返回 manifest 部分）
    if (row.pack_json) {
      let manifestJson = row.pack_json;
      try {
        const parsed = JSON.parse(row.pack_json) as unknown;
        if (parsed !== null && typeof parsed === 'object' && 'manifest' in (parsed as object)) {
          manifestJson = JSON.stringify((parsed as { manifest: unknown }).manifest);
        }
      } catch { /* 保留原始内容 */ }
      auditPrivacy(request, 'privacy.export.downloaded', exportId, { exportId, via: 'inline_manifest' });
      return reply
        .header('Content-Type', 'application/json')
        .send(manifestJson);
    }

    return reply.code(404).send({ error: 'Export data not available' });
  });

  /* POST /api/v1/privacy/import/dry-run — 导入 dry-run 验证 */
  app.post('/api/v1/privacy/import/dry-run', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = DryRunImportBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: body.error.issues });
    }
    const report = service.dryRunImport(request.tenantId, body.data.manifestJson);
    return { data: report };
  });

  /* POST /api/v1/privacy/import/commit — 单次消费 token 执行真实导入（仅 admin，限流: 3次/分钟） */
  app.post('/api/v1/privacy/import/commit', { preHandler: requireRole('admin'), config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = CommitImportBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: body.error.issues });
    }
    try {
      const result = service.commitImport(request.tenantId, body.data.manifestJson, body.data.commitToken);
      /* import 写入租户数据，留业务审计（F5 debt：与 export/erase 同级的合规证据链）——payload 仅计数元数据。 */
      auditPrivacy(request, 'privacy.import.committed', result.importId, {
        importId: result.importId, importedCount: result.importedCount,
        skippedCount: result.skippedCount, failedCount: result.failedCount,
      });
      return { data: result };
    } catch (err) {
      if (err instanceof Error && err.message.includes('invalid or expired')) {
        auditPrivacy(request, 'privacy.import.failed', request.tenantId, { reason: 'invalid or expired commit token' });
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }
  });
}
