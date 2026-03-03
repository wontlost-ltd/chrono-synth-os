/**
 * 审计日志插件
 * 记录所有状态变更操作（POST/PUT/PATCH/DELETE）到 audit_log 表
 * 增强：用户身份 + 操作语义 + 请求来源
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';

/** 只审计写操作 */
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 不审计的路径 */
const EXCLUDED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/** 路径到操作类型的映射 */
const ACTION_TYPE_MAP: Array<{ pattern: RegExp; action: string }> = [
  { pattern: /\/auth\/(login|register)/, action: 'auth' },
  { pattern: /\/billing\//, action: 'billing' },
  { pattern: /\/decisions\/.*\/simulate/, action: 'simulation' },
  { pattern: /\/decisions\//, action: 'decision' },
  { pattern: /\/simulations\/life/, action: 'life_simulation' },
  { pattern: /\/operations\/evolution/, action: 'evolution' },
  { pattern: /\/operations\/regulation/, action: 'regulation' },
  { pattern: /\/admin\/config/, action: 'admin_config' },
  { pattern: /\/privacy\//, action: 'privacy' },
  { pattern: /\/avatars\/.*\/autorun/, action: 'avatar_autorun' },
  { pattern: /\/avatars\/.*\/drift/, action: 'avatar_drift' },
  { pattern: /\/knowledge-sources\//, action: 'knowledge_source' },
  { pattern: /\/memories\//, action: 'memory' },
  { pattern: /\/values\//, action: 'values' },
  { pattern: /\/onboarding\//, action: 'onboarding' },
];

function resolveActionType(path: string): string {
  for (const { pattern, action } of ACTION_TYPE_MAP) {
    if (pattern.test(path)) return action;
  }
  return 'other';
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  request_id: string;
  status_code: number;
  latency_ms: number;
  api_key_hash: string | null;
  user_id: string | null;
  user_email: string | null;
  action_type: string;
}

/** 计算 API Key 的 SHA-256 前 16 位十六进制（用于审计追溯，不可逆） */
function hashApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

export function registerAuditLog(app: FastifyInstance, db: IDatabase | undefined): void {
  if (!db) return;

  /* 确保新增列存在（兼容升级迁移） */
  try {
    db.prepare<void>(`ALTER TABLE audit_log ADD COLUMN user_id TEXT`).run();
  } catch { /* 列已存在 */ }
  try {
    db.prepare<void>(`ALTER TABLE audit_log ADD COLUMN user_email TEXT`).run();
  } catch { /* 列已存在 */ }
  try {
    db.prepare<void>(`ALTER TABLE audit_log ADD COLUMN action_type TEXT DEFAULT 'other'`).run();
  } catch { /* 列已存在 */ }

  /* 记录请求开始时间，用于计算延迟 */
  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    (request as unknown as Record<string, number>).__startTime = performance.now();
    done();
  });

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
      const tenantId = request.tenantId ?? 'default';

      /* 提取 JWT 用户身份 */
      const user = request.user as JwtPayload | undefined;
      const userId = user?.sub ?? null;
      /* JwtPayload 不包含 email，从请求装饰器获取（如有） */
      const userEmail = (request as unknown as { userEmail?: string }).userEmail ?? null;
      const actionType = resolveActionType(routePath);

      db.prepare<void>(
        `INSERT INTO audit_log (id, timestamp, method, path, request_id, status_code, latency_ms, api_key_hash, tenant_id, user_id, user_email, action_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        Date.now(),
        request.method,
        routePath,
        requestId,
        reply.statusCode,
        Math.round(latency * 100) / 100,
        apiKeyHash,
        tenantId,
        userId,
        userEmail,
        actionType,
      );
    } catch {
      /* 审计写入失败不应中断请求 */
    }

    done();
  });
}

/** 查询审计日志（按租户过滤，分页） */
export function queryAuditLog(db: IDatabase, limit = 100, tenantId?: string, offset = 0): AuditEntry[] {
  const tid = tenantId ?? 'default';
  return db.prepare<AuditEntry>(
    'SELECT id, timestamp, method, path, request_id, status_code, latency_ms, api_key_hash, user_id, user_email, action_type FROM audit_log WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
  ).all(tid, limit, offset);
}
