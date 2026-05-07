/**
 * Analytics 批量埋点端点（P1.7.2 后端）
 *
 * 配合 chrono-synth-web `src/lib/analytics.ts` 的 buffered tracker：客户端
 * 在 tick / 阈值 / visibilitychange=hidden 时触发批量 POST。本路由把事件
 * 直接落地到 events_user_journey（v069 migration），不做实时聚合，由
 * 离线作业按 tenant_id 滚动 rollup。
 *
 * 设计取舍：
 *  - 单事务批量 INSERT，避免 N 次 round trip（最大 200/批，由 schema 强制）。
 *  - properties 仅接受标量值（schema 层校验），过滤嵌套对象，防止 PII 泄漏。
 *  - 客户端时间戳 (client_ts) 不可信但保留，便于排查时差；服务端写入
 *    ingested_at 作为权威时间。
 *  - 失败行不会让整批失败（per-row try/catch），只记录失败计数；这是埋点
 *    层的合理权衡——丢一行胜过丢一整批。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../../storage/database.js';
import { AnalyticsBatchSchema } from '../schemas/api-schemas.js';

function getUserId(request: FastifyRequest): string | null {
  const user = request.user;
  return user?.sub ?? null;
}

export function registerAnalyticsRoutes(app: FastifyInstance, db: IDatabase | undefined): void {
  /* POST /api/v1/analytics/events
   * 批量写入用户旅程事件。无 db 时降级为接受请求但不持久化（dev / readonly）。
   * 路由本身不做严格 rate-limit（埋点本就稀疏），但全局 rate-limit 仍生效。 */
  app.post('/api/v1/analytics/events', async (request, reply) => {
    const parsed = AnalyticsBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'INVALID_ANALYTICS_PAYLOAD',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }

    const { events, sessionId } = parsed.data;
    const tenantId = request.tenantId ?? 'default';
    const userId = getUserId(request);
    const now = Date.now();

    let written = 0;
    let failed = 0;

    if (db) {
      const stmt = db.prepare<void>(
        `INSERT INTO events_user_journey
           (id, tenant_id, user_id, session_id, name, properties_json, client_ts, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const ev of events) {
        try {
          stmt.run(
            randomUUID(),
            tenantId,
            userId,
            sessionId ?? null,
            ev.name,
            JSON.stringify(ev.properties ?? {}),
            ev.ts ?? now,
            now,
          );
          written += 1;
        } catch (err) {
          failed += 1;
          request.log.warn({ err, name: ev.name }, 'analytics event write failed');
        }
      }
    }

    /* 客户端用 sendBeacon / keepalive 发送，body 最长 64 KB；不需要 201。
     * 用 202 Accepted 更准确：写入已排队/完成，客户端不必关心后续聚合。 */
    return reply.status(202).send({
      data: { received: events.length, written, failed },
    });
  });
}
