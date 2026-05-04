/**
 * 对话路由（P1-C 生产级）
 *
 * 端点：
 *   POST   /api/v1/persona-core/:personaId/conversations/messages         同步发送
 *   POST   /api/v1/persona-core/:personaId/conversations/messages/stream  SSE 流式（POST 接受完整 body）
 *   GET    /api/v1/persona-core/:personaId/conversations/sessions/:sid    列出会话
 *   DELETE /api/v1/persona-core/:personaId/conversations                  GDPR 删除全部
 *
 * 鉴权：JWT only（apikey 拒绝）；调用方必须是 personaId 的 owner。
 *
 * 速率隔离：
 *   - 同步消息 60/min/(persona+externalUser)
 *   - SSE 流式 30/min/(persona+externalUser)
 *   - DELETE 全租户级 5/hour
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../../types/auth.js';
import type {
  ConversationService,
  SubmitMessageInput,
} from '../../conversation/conversation-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ConversationMessageRequestSchema } from '../schemas/api-schemas.js';
import {
  AuthorizationError,
  NotFoundError,
  ErrorCode,
} from '../../errors/index.js';
import { PersonaNotFoundForConversationError } from '../../conversation/conversation-service.js';

interface RouteServices {
  conversation: ConversationService;
  personaCore: PersonaCoreService;
}

const SSE_TOKEN_CHUNK_SIZE = 32;
const SSE_TOKEN_INTERVAL_MS = 25;
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

function requireJwtUser(request: FastifyRequest): JwtPayload {
  const user = request.user as JwtPayload | undefined;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError(
      'Persona conversation 仅支持用户 JWT 访问',
      ErrorCode.AUTH_INSUFFICIENT_ROLE,
    );
  }
  return user;
}

function assertPersonaOwnership(
  personaCore: PersonaCoreService,
  tenantId: string,
  ownerUserId: string,
  personaId: string,
): void {
  const detail = personaCore.getPersonaDetail(tenantId, ownerUserId, personaId);
  if (!detail) {
    throw new NotFoundError(
      `persona ${personaId} 不存在或调用者非 owner`,
      ErrorCode.NOT_FOUND_PERSONA,
    );
  }
}

/* fastify-rate-limit keyGenerator 在 hook 阶段执行；此时 schema 还未解析，
 * 我们从 request.body / request.params 读取 personaId+externalUserId 作为 key */
function perPersonaUserKey(request: FastifyRequest): string {
  const params = request.params as { personaId?: string };
  const body = (request.body ?? {}) as { externalUserId?: string };
  const persona = params.personaId ?? 'unknown';
  const eu = body.externalUserId ?? 'unknown';
  const tenant = request.tenantId ?? 'default';
  return `${tenant}:${persona}:${eu}`;
}

export function registerConversationRoutes(app: FastifyInstance, services: RouteServices): void {
  const { conversation, personaCore } = services;

  /* POST /:personaId/conversations/messages */
  app.post<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/conversations/messages',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: perPersonaUserKey,
        },
      },
    },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const personaId = request.params.personaId;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);

      const body = ConversationMessageRequestSchema.parse(request.body);
      const submitInput = buildSubmitInput(body, user, personaId, request.tenantId);
      try {
        const response = await conversation.submit(submitInput);
        const status = response.guardAction === 'needs_confirmation' ? 202 : 200;
        return reply.status(status).send({ data: response });
      } catch (err) {
        if (err instanceof PersonaNotFoundForConversationError) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
        }
        throw err;
      }
    },
  );

  /* POST /:personaId/conversations/messages/stream
   * 完整 body POST 输出 SSE；保留 GET 兼容旧调用方但只取 query 参数 */
  app.post<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/conversations/messages/stream',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: perPersonaUserKey,
        },
      },
    },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const personaId = request.params.personaId;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);

      const body = ConversationMessageRequestSchema.parse(request.body);
      const submitInput = buildSubmitInput(body, user, personaId, request.tenantId);
      await runSseStream(reply, conversation, submitInput);
      return reply;
    },
  );

  /* GET /:personaId/conversations/sessions/:sessionId */
  app.get<{ Params: { personaId: string; sessionId: string } }>(
    '/api/v1/persona-core/:personaId/conversations/sessions/:sessionId',
    async (request) => {
      const user = requireJwtUser(request);
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, request.params.personaId);
      return {
        data: conversation.listSession({
          tenantId: request.tenantId,
          personaId: request.params.personaId,
          sessionId: request.params.sessionId,
        }),
      };
    },
  );

  /* DELETE /:personaId/conversations  GDPR 删除接口 */
  app.delete<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/conversations',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, request.params.personaId);
      const deleted = conversation.deleteAllByPersona(request.tenantId, request.params.personaId);
      return reply.code(200).send({ data: { deleted } });
    },
  );
}

function buildSubmitInput(
  body: ReturnType<typeof ConversationMessageRequestSchema.parse>,
  user: JwtPayload,
  personaId: string,
  tenantId: string,
): SubmitMessageInput {
  return {
    tenantId,
    personaId,
    ownerUserId: user.sub,
    sessionId: body.sessionId,
    messageId: body.messageId,
    externalUserId: body.externalUserId,
    content: body.content,
    history: body.history,
    metadata: body.metadata,
    confirmationToken: body.confirmationToken,
    retentionClass: body.retentionClass,
  };
}

async function runSseStream(
  reply: FastifyReply,
  conversation: ConversationService,
  input: SubmitMessageInput,
): Promise<void> {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const heartbeat = setInterval(() => {
    try { reply.raw.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); }
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    const response = await conversation.submit(input);
    /* 即使是 needs_confirmation 也走流式：前端需要拿到 confirmationToken */
    await streamTokens(reply, response.response);
    writeSseEvent(reply, 'done', response);
  } catch (err) {
    const code = err instanceof PersonaNotFoundForConversationError ? 'NOT_FOUND' : 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    writeSseEvent(reply, 'error', { code, message });
  } finally {
    clearInterval(heartbeat);
    reply.raw.end();
  }
}

async function streamTokens(reply: FastifyReply, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += SSE_TOKEN_CHUNK_SIZE) {
    const delta = text.slice(i, i + SSE_TOKEN_CHUNK_SIZE);
    writeSseEvent(reply, 'token', { delta });
    await new Promise((resolve) => setTimeout(resolve, SSE_TOKEN_INTERVAL_MS));
  }
}

function writeSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
