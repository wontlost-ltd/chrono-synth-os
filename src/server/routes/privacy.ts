/**
 * 隐私与信任控制路由 (GDPR / 数据可移植性)
 * 路由层只做请求解析和响应序列化，业务逻辑委托 PrivacyService
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { PaginationQuerySchema, DryRunImportBodySchema } from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';

export function registerPrivacyRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory?: TenantOSFactory,
  config?: AppConfig,
): void {
  const service = new PrivacyService(os, tenantFactory, config);

  /* POST /api/v1/privacy/export — 完整租户数据导出（仅 admin，限流: 3 次/分钟） */
  app.post('/api/v1/privacy/export', { preHandler: requireRole('admin'), config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request) => {
    return { data: service.exportData(request.tenantId) };
  });

  /* DELETE /api/v1/privacy/data — GDPR Right to Erasure（仅 admin，限流: 1 次/分钟） */
  app.delete('/api/v1/privacy/data', { preHandler: requireRole('admin'), config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async (request) => {
    return { data: service.eraseData(request.tenantId) };
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

    // 优先重定向到预签名 URL
    if (row.download_url) {
      return reply.code(302).redirect(row.download_url);
    }

    // 回退：直接返回内联 JSON（向后兼容旧记录）
    if (row.pack_json) {
      return reply
        .header('Content-Type', 'application/json')
        .send(row.pack_json);
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
}
