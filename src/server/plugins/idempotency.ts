import { createHash, randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  idemQueryExisting,
  idemCmdCleanupExpired, idemCmdInsert, idemCmdComplete, idemCmdDelete,
} from '@chrono/kernel';
import type { IdemRow } from '@chrono/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';
import { ErrorCode, StateError, ValidationError } from '../../errors/index.js';

const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const IDEMPOTENCY_HEADER = 'idempotency-key';
const REPLAY_HEADER = 'x-idempotent-replayed';

interface IdempotencyContext {
  id: string;
}

function getHeaderValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name] ?? request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortForStableStringify(input[key]);
    }
    return output;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function buildScopeKey(request: FastifyRequest): string {
  const routePath = request.routeOptions?.url ?? request.url.split('?')[0];
  const userSub = typeof request.user === 'object' && request.user && 'sub' in request.user
    ? String((request.user as { sub?: string }).sub ?? '')
    : '';
  return `${routePath}:${userSub || request.tenantId || 'anonymous'}`;
}

function buildRequestHash(request: FastifyRequest, tenantId: string, scopeKey: string): string {
  const routePath = request.routeOptions?.url ?? request.url.split('?')[0];
  return createHash('sha256').update(stableStringify({
    tenantId,
    scopeKey,
    method: request.method,
    routePath,
    query: request.query ?? null,
    body: request.body ?? null,
  })).digest('hex');
}

function serializeReplayHeaders(reply: FastifyReply): string | null {
  const contentType = reply.getHeader('content-type');
  const setCookie = reply.getHeader('set-cookie');
  const payload: Record<string, unknown> = {};

  if (typeof contentType === 'string' && contentType) {
    payload['content-type'] = contentType;
  }
  if (typeof setCookie === 'string' && setCookie) {
    payload['set-cookie'] = setCookie;
  } else if (Array.isArray(setCookie) && setCookie.length > 0) {
    payload['set-cookie'] = setCookie.filter((item): item is string => typeof item === 'string');
  }

  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
}

function applyReplayHeaders(reply: FastifyReply, headersJson: string | null): void {
  if (!headersJson) return;
  const headers = JSON.parse(headersJson) as Record<string, unknown>;
  const contentType = headers['content-type'];
  if (typeof contentType === 'string') {
    reply.header('content-type', contentType);
  }
  const setCookie = headers['set-cookie'];
  if (typeof setCookie === 'string' && setCookie) {
    reply.header('set-cookie', setCookie);
  } else if (Array.isArray(setCookie) && setCookie.length > 0) {
    reply.header('set-cookie', setCookie);
  }
}

function canStoreResponse(reply: FastifyReply): boolean {
  return reply.statusCode >= 200 && reply.statusCode < 300;
}

function normalizePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return JSON.stringify(payload);
}

function replayResponse(reply: FastifyReply, row: IdemRow): void {
  reply.header(REPLAY_HEADER, 'true');
  applyReplayHeaders(reply, row.response_headers_json);
  reply.code(row.response_status ?? 200);
  if ((row.response_content_type ?? '').includes('application/json') && row.response_body) {
    reply.send(JSON.parse(row.response_body));
    return;
  }
  reply.send(row.response_body ?? '');
}

export function registerIdempotency(app: FastifyInstance, db: IDatabase | undefined, config: AppConfig): void {
  if (!db || !config.idempotency.enabled) return;

  registerCoreSelfExecutors();
  const tx: SyncWriteUnitOfWork = directUnitOfWork(db);

  app.addHook('preHandler', (request, reply, done) => {
    if (!IDEMPOTENT_METHODS.has(request.method)) return done();

    const idempotencyKey = getHeaderValue(request, IDEMPOTENCY_HEADER)?.trim();
    if (!idempotencyKey) return done();
    if (idempotencyKey.length > 255) {
      done(new ValidationError('Idempotency-Key 过长', ErrorCode.VALIDATION_FORMAT));
      return;
    }

    const tenantId = request.tenantId ?? 'default';
    const scopeKey = buildScopeKey(request);
    const requestHash = buildRequestHash(request, tenantId, scopeKey);
    const now = Date.now();

    try {
      tx.execute(idemCmdCleanupExpired(now));
    } catch {
      /* 清理失败不阻断请求 */
    }

    const existing = tx.queryOne(idemQueryExisting({ tenantId, scopeKey, idempotencyKey, now }));

    if (existing) {
      if (existing.request_hash !== requestHash) {
        done(new StateError('同一个 Idempotency-Key 不能用于不同请求', ErrorCode.STATE_ALREADY_EXISTS));
        return;
      }
      if (existing.state === 'completed' && existing.response_status !== null) {
        replayResponse(reply, existing);
        done();
        return;
      }
      done(new StateError('相同 Idempotency-Key 的请求正在处理中', ErrorCode.STATE_ALREADY_EXISTS));
      return;
    }

    const id = randomUUID();
    const claimed = tx.execute(idemCmdInsert({
      id,
      tenantId,
      scopeKey,
      idempotencyKey,
      requestHash,
      requestMethod: request.method,
      requestPath: request.routeOptions?.url ?? request.url.split('?')[0],
      now,
      expiresAt: now + config.idempotency.ttlMs,
    }));

    if (claimed.rowsAffected === 0) {
      // 并发请求已抢先声明同一 key，重新查询并按现有行逻辑处理
      const concurrent = tx.queryOne(idemQueryExisting({ tenantId, scopeKey, idempotencyKey, now }));
      if (concurrent) {
        if (concurrent.request_hash !== requestHash) {
          done(new StateError('同一个 Idempotency-Key 不能用于不同请求', ErrorCode.STATE_ALREADY_EXISTS));
          return;
        }
        if (concurrent.state === 'completed' && concurrent.response_status !== null) {
          replayResponse(reply, concurrent);
          done();
          return;
        }
      }
      done(new StateError('相同 Idempotency-Key 的请求正在处理中', ErrorCode.STATE_ALREADY_EXISTS));
      return;
    }

    (request as FastifyRequest & { idempotencyContext?: IdempotencyContext }).idempotencyContext = { id };
    reply.header(REPLAY_HEADER, 'false');
    done();
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    const context = (request as FastifyRequest & { idempotencyContext?: IdempotencyContext }).idempotencyContext;
    if (!context) {
      done(null, payload);
      return;
    }

    try {
      if (canStoreResponse(reply)) {
        const contentType = typeof reply.getHeader('content-type') === 'string'
          ? String(reply.getHeader('content-type'))
          : null;
        tx.execute(idemCmdComplete({
          id: context.id,
          responseStatus: reply.statusCode,
          responseContentType: contentType,
          responseHeadersJson: serializeReplayHeaders(reply),
          responseBody: normalizePayload(payload),
        }));
      } else {
        tx.execute(idemCmdDelete(context.id));
      }
    } catch {
      /* 中间件异常不应破坏主流程 */
    }

    done(null, payload);
  });
}
