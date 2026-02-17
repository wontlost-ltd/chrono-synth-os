/**
 * 审计日志插件
 * 记录所有状态变更操作（POST/PUT/PATCH/DELETE）到 audit_log 表
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IDatabase } from '../../storage/database.js';

/** 只审计写操作 */
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 不审计的路径 */
const EXCLUDED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

export interface AuditEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  request_id: string;
  status_code: number;
  latency_ms: number;
  api_key_hash: string | null;
}

/** 计算 API Key 的 SHA-256 前 16 位十六进制（用于审计追溯，不可逆） */
function hashApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

export function registerAuditLog(app: FastifyInstance, db: IDatabase | undefined): void {
  if (!db) return;

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    const routePath = request.routeOptions?.url ?? request.url.split('?')[0];
    if (!AUDITED_METHODS.has(request.method) || EXCLUDED_PATHS.has(routePath)) {
      return done();
    }

    const start = (request as unknown as Record<string, number>).__startTime;
    const latency = start !== undefined ? performance.now() - start : 0;
    const requestId = (reply.getHeader('X-Request-Id') as string) || 'unknown';

    try {
      /* 支持 header 和 query 两种 API Key 传递方式 */
      const apiKey = (request.headers['x-api-key'] as string | undefined)
        ?? (request.query as Record<string, string>)?.apiKey;
      const apiKeyHash = hashApiKey(apiKey);
      db.prepare<void>(
        'INSERT INTO audit_log (id, timestamp, method, path, request_id, status_code, latency_ms, api_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        crypto.randomUUID(),
        Date.now(),
        request.method,
        routePath,
        requestId,
        reply.statusCode,
        Math.round(latency * 100) / 100,
        apiKeyHash,
      );
    } catch {
      /* 审计写入失败不应中断请求 */
    }

    done();
  });
}

/** 查询审计日志（最近 N 条） */
export function queryAuditLog(db: IDatabase, limit = 100): AuditEntry[] {
  return db.prepare<AuditEntry>(
    'SELECT id, timestamp, method, path, request_id, status_code, latency_ms, api_key_hash FROM audit_log ORDER BY timestamp DESC LIMIT ?',
  ).all(limit);
}
