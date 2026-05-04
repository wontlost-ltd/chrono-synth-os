/**
 * 对话路由（P1-C）
 *
 * POST /api/v1/persona-core/:personaId/conversations/messages         — 同步发送消息
 * GET  /api/v1/persona-core/:personaId/conversations/sessions/:sid    — 列出会话
 * GET  /api/v1/persona-core/:personaId/conversations/messages/stream  — SSE 流式（MVP：非流式 LLM 分块吐出）
 *
 * 鉴权：apikey 拒绝；调用者必须是 personaId 的 owner。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../../types/auth.js';
import type { ConversationService } from '../../conversation/conversation-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ConversationMessageRequestSchema } from '../schemas/api-schemas.js';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ErrorCode,
} from '../../errors/index.js';
import { PersonaNotFoundForConversationError } from '../../conversation/conversation-service.js';

interface RouteServices {
  conversation: ConversationService;
  personaCore: PersonaCoreService;
}

const SSE_TOKEN_CHUNK_SIZE = 32;
const SSE_TOKEN_INTERVAL_MS = 25;

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

export function registerConversationRoutes(app: FastifyInstance, services: RouteServices): void {
  const { conversation, personaCore } = services;

  /* POST /:personaId/conversations/messages */
  app.post<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/conversations/messages',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = requireJwtUser(request);
      const personaId = request.params.personaId;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);

      const body = ConversationMessageRequestSchema.parse(request.body);
      try {
        const response = await conversation.submit({
          tenantId: request.tenantId,
          personaId,
          ownerUserId: user.sub,
          sessionId: body.sessionId,
          messageId: body.messageId,
          externalUserId: body.externalUserId,
          content: body.content,
          history: body.history,
          metadata: body.metadata,
        });
        return reply.status(200).send({ data: response });
      } catch (err) {
        if (err instanceof PersonaNotFoundForConversationError) {
          return reply.code(404).send({
            error: { code: 'NOT_FOUND', message: err.message },
          });
        }
        throw err;
      }
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

  /* GET /:personaId/conversations/messages/stream (SSE)
   *
   * MVP 实现：调用方 query 参数提供 sessionId/messageId/externalUserId/content，
   * 服务端阻塞调用 conversation.submit，再按 chunk 推送 token 事件。
   * 真正的流式（fetch streaming）将在 ChatOptions.stream 上线后接入。
   */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/persona-core/:personaId/conversations/messages/stream',
    async (request, reply) => {
      const user = requireJwtUser(request);
      const personaId = request.params.personaId;
      assertPersonaOwnership(personaCore, request.tenantId, user.sub, personaId);

      const query = request.query as Record<string, string | undefined>;
      const sessionId = query.sessionId;
      const messageId = query.messageId;
      const externalUserId = query.externalUserId;
      const content = query.content;
      if (!sessionId || !messageId || !externalUserId || !content) {
        throw new ValidationError(
          'SSE 流式请求需提供 sessionId / messageId / externalUserId / content 查询参数',
          ErrorCode.VALIDATION_REQUIRED,
        );
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      try {
        const response = await conversation.submit({
          tenantId: request.tenantId,
          personaId,
          ownerUserId: user.sub,
          sessionId,
          messageId,
          externalUserId,
          content,
        });
        await streamTokens(reply, response.response);
        writeSseEvent(reply, 'done', response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof PersonaNotFoundForConversationError ? 'NOT_FOUND' : 'INTERNAL';
        writeSseEvent(reply, 'error', { code, message });
      } finally {
        reply.raw.end();
      }

      return reply;
    },
  );
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
