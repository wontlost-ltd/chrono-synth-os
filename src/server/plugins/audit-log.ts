import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';
import { ensureAuditLogColumns, recordRequestAuditLog } from '../../audit/audit-log-store.js';

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

export function registerAuditLog(app: FastifyInstance, db: IDatabase | undefined): void {
  if (!db) return;

  const tx = db;
  ensureAuditLogColumns(tx);

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
      const tenantId = request.tenantId ?? 'default';

      /* 提取 JWT 用户身份 */
      const user = request.user as JwtPayload | undefined;
      const userId = user?.sub ?? null;
      /* JwtPayload 不包含 email，从请求装饰器获取（如有） */
      const userEmail = (request as unknown as { userEmail?: string }).userEmail ?? null;
      const actionType = resolveActionType(routePath);
      const actorType = apiKey ? 'api_key' : userId ? 'user' : null;

      recordRequestAuditLog(tx, {
        tenantId,
        requestId,
        method: request.method,
        path: routePath,
        statusCode: reply.statusCode,
        latencyMs: latency,
        apiKey,
        userId,
        userEmail,
        actorType,
        actorId: apiKey ? userId ?? 'apikey' : userId,
        actionType,
      });
    } catch {
      /* 审计写入失败不应中断请求 */
    }

    done();
  });
}
