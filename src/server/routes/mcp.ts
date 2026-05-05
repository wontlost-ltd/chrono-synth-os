/**
 * MCP HTTP 传输层
 *
 * 端点：
 *   POST /api/v1/mcp                    — JSON-RPC 单次调用
 *   GET  /api/v1/mcp/capabilities       — 能力发现（公开，便于客户端先探测）
 *
 * 鉴权：依赖 fastify JWT 插件（由 server/plugins/auth.ts 提供）。
 * 调用上下文：
 *   - tenantId：从 request.tenantId（已由 multi-tenant 中间件解析）
 *   - personaId：从请求 body 的 `personaId` 字段（每次调用必须显式声明）
 *   - invokerId：JWT.sub
 *
 * 安全性：
 *   - 速率限制：每 token 100 calls/min（fastify-rate-limit）
 *   - body 大小：默认 fastify limit（1MB）已经足够，工具结果不放在 body
 *   - persona 所有权：JWT.sub 必须是 persona.owner_user_id（pipeline 的 agency authorization 校验）
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoMcpServer, McpCallContext } from '../../mcp/chrono-mcp-server.js';
import type { JsonRpcRequest } from '@chrono/kernel';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  JSONRPC_ERROR_INVALID_REQUEST,
  MCP_ERROR_UNAUTHORIZED,
} from '@chrono/kernel';
import type { JwtPayload } from '../../types/auth.js';

const MCP_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 100,
      timeWindow: 60_000,
    },
  },
} as const;

interface McpRequestBody {
  personaId?: string;
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
}

export function registerMcpRoutes(app: FastifyInstance, mcpServer: ChronoMcpServer): void {
  /* GET /api/v1/mcp/capabilities — 能力发现（无需鉴权，便于客户端探测） */
  app.get('/api/v1/mcp/capabilities', async () => {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { ...MCP_SERVER_INFO },
      transport: 'http+jsonrpc',
      authentication: {
        type: 'bearer',
        scheme: 'jwt',
      },
    };
  });

  /* POST /api/v1/mcp — JSON-RPC 单次调用 */
  app.post('/api/v1/mcp', MCP_RATE_LIMIT, async (request, reply) => {
    const body = request.body as McpRequestBody | undefined;

    /* JSON-RPC 信封校验 */
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string'
        || (body.id !== undefined && typeof body.id !== 'string' && typeof body.id !== 'number')) {
      reply.status(400);
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC_ERROR_INVALID_REQUEST, message: '无效的 JSON-RPC 信封' },
      };
    }

    /* 鉴权 */
    const user = request.user as JwtPayload | undefined;
    if (!user || !user.sub) {
      reply.status(401);
      return {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: MCP_ERROR_UNAUTHORIZED, message: '需要 Bearer 认证' },
      };
    }

    /* personaId 必须从 body 提取，且仅允许 tools/call 时强制；其他方法 personaId 不强制 */
    const personaId = typeof body.personaId === 'string' && body.personaId.length > 0
      ? body.personaId
      : '';

    const requiresPersona = body.method === 'tools/call';
    if (requiresPersona && !personaId) {
      reply.status(400);
      return {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: JSONRPC_ERROR_INVALID_REQUEST, message: 'tools/call 必须提供 personaId 字段' },
      };
    }

    const ctx: McpCallContext = {
      tenantId: request.tenantId,
      personaId: personaId || 'unbound',
      invokerId: user.sub,
      invokerType: user.role === 'admin' ? 'admin' : 'mcp',
    };

    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: body.id ?? 0,
      method: body.method,
      params: body.params,
    };

    const response = await mcpServer.handle(rpcRequest, ctx);
    return response;
  });
}
