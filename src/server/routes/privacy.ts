/**
 * 隐私与信任控制路由 (GDPR / 数据可移植性)
 * 路由层只做请求解析和响应序列化，业务逻辑委托 PrivacyService
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { PaginationQuerySchema } from '../schemas/api-schemas.js';
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
}
