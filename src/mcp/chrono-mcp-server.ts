/**
 * ChronoSynth MCP Server
 *
 * 实现 MCP Spec 2024-11-05 的核心方法：
 *  - initialize：协商协议版本和能力
 *  - tools/list：返回本部署的能力目录（注册了哪些工具），非 per-token 过滤清单；真授权在 tools/call 强制
 *  - tools/call：执行工具调用，路由至 ToolInvocationPipeline
 *  - ping：保活
 *
 * 注意：传输层（HTTP / SSE）由 src/server/routes/mcp.ts 实现，
 * 此文件只处理协议语义。
 */

import {
  JSONRPC_ERROR_INVALID_REQUEST,
  JSONRPC_ERROR_METHOD_NOT_FOUND,
  JSONRPC_ERROR_INVALID_PARAMS,
  JSONRPC_ERROR_INTERNAL,
  MCP_ERROR_TOOL_NOT_FOUND,
  MCP_ERROR_PERMISSION_DENIED,
  MCP_ERROR_QUOTA_EXCEEDED,
  MCP_ERROR_CONFIRMATION_REQUIRED,
  MCP_ERROR_TOOL_FAILED,
  MCP_ERROR_TIMEOUT,
  MCP_METHOD_INITIALIZE,
  MCP_METHOD_TOOLS_LIST,
  MCP_METHOD_TOOLS_CALL,
  MCP_METHOD_PING,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpToolsListResult,
  type McpToolsCallParams,
  type McpToolsCallResult,
  type McpTool,
} from '@chrono/kernel';
import type { ToolInvocationPipeline } from '../agent/tool-invocation-pipeline.js';
import type { ToolRegistry } from '../agent/tool-registry.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'McpServer';

/** MCP 调用上下文（由 HTTP 层注入） */
export interface McpCallContext {
  readonly tenantId: string;
  readonly personaId: string;
  readonly invokerId: string;
  /** 触发调用的用户 ID（用于"待我确认"列表索引）；JWT 路径下取 sub */
  readonly invokerUserId?: string | null;
  readonly invokerType: 'mcp' | 'admin';
  /** 用户级 OAuth token 解析器（HTTP 层按 user 注入） */
  readonly oauthResolver?: import('../agent/tool-adapter.js').UserOauthTokenResolver;
}

export class ChronoMcpServer {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly pipeline: ToolInvocationPipeline,
    private readonly logger: Logger,
  ) {}

  /**
   * 处理单个 JSON-RPC 请求并返回响应。
   * 不抛异常 — 所有错误转为 JsonRpcErrorResponse。
   */
  async handle(request: JsonRpcRequest, ctx: McpCallContext): Promise<JsonRpcResponse> {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return errorResponse(request.id ?? null, JSONRPC_ERROR_INVALID_REQUEST, '无效的 JSON-RPC 请求');
    }

    try {
      switch (request.method) {
        case MCP_METHOD_INITIALIZE:
          return successResponse(request.id, this.handleInitialize(request.params as McpInitializeParams | undefined));

        case MCP_METHOD_TOOLS_LIST:
          return successResponse(request.id, this.handleToolsList());

        case MCP_METHOD_TOOLS_CALL:
          return await this.handleToolsCall(request, ctx);

        case MCP_METHOD_PING:
          return successResponse(request.id, {});

        default:
          return errorResponse(request.id, JSONRPC_ERROR_METHOD_NOT_FOUND, `未知方法: ${request.method}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      /* 内部异常细节只进日志，对外（含已认证 MCP 客户端）只回通用文案——避免把 DB/内部错误消息透传出去
       * 被用于枚举内部实现（全维评审 G1）。 */
      this.logger.warn(LAYER, `请求处理异常 method=${request.method}: ${msg}`);
      return errorResponse(request.id, JSONRPC_ERROR_INTERNAL, '内部错误');
    }
  }

  private handleInitialize(_params: McpInitializeParams | undefined): McpInitializeResult {
    /* 协议协商：当前只支持 2024-11-05；客户端如果不兼容会自行决定降级 */
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { ...MCP_SERVER_INFO },
      capabilities: {
        tools: { listChanged: false },
      },
    };
  }

  /**
   * tools/list：返回**能力目录**（本部署注册了哪些工具及其 schema/风险标记），非「当前 token 可调用的工具」。
   * 真正的调用授权在 tools/call 经 ToolInvocationPipeline 双层门控（authz + permission）逐次强制，未授权工具
   * 调用会被拒——故目录本身对已认证同租户客户端可见是可接受的（全维评审漏报：语义应是 capability catalog，
   * 不是 per-token 过滤清单）。工具元数据不含敏感实现细节，仅 id/描述/风险/输入 schema。
   */
  private handleToolsList(): McpToolsListResult {
    const tools: McpTool[] = this.registry.list().map((adapter) => ({
      name: adapter.metadata.id,
      description: adapter.metadata.description,
      highRisk: adapter.metadata.highRisk,
      inputSchema: adapter.metadata.inputSchema,
    }));
    return { tools };
  }

  private async handleToolsCall(
    request: JsonRpcRequest,
    ctx: McpCallContext,
  ): Promise<JsonRpcResponse> {
    const params = request.params as McpToolsCallParams | undefined;
    if (!params || typeof params.name !== 'string' || typeof params.arguments !== 'object' || params.arguments === null) {
      return errorResponse(request.id, JSONRPC_ERROR_INVALID_PARAMS, 'tools/call 缺少必要参数 name/arguments');
    }

    if (!this.registry.has(params.name)) {
      return errorResponse(request.id, MCP_ERROR_TOOL_NOT_FOUND, `工具不存在: ${params.name}`);
    }

    const decision = await this.pipeline.invoke({
      tenantId: ctx.tenantId,
      personaId: ctx.personaId,
      toolId: params.name,
      invokerType: ctx.invokerType,
      invokerId: ctx.invokerId,
      invokerUserId: ctx.invokerUserId ?? null,
      arguments: params.arguments as Record<string, unknown>,
      confirmationToken: params.confirmationToken,
      oauthResolver: ctx.oauthResolver,
    });

    if (decision.ok) {
      const result: McpToolsCallResult = {
        content: decision.result.content,
      };
      return successResponse(request.id, result);
    }

    const code = mapStatusToErrorCode(decision.status);
    /* 对外错误文案脱敏（全维评审 G1 收口）：业务性拒绝（授权/权限/配额/待确认/工具不存在）的 reason 对客户端
     * 有意义且不含内部串，原样返回；**系统性失败**（failed/timeout/circuit_open 等，reason 可能内嵌 adapter/DB
     * 异常 err.message）只回通用文案，细节留 status + 内部日志。 */
    const message = isBusinessDecisionStatus(decision.status) ? decision.reason : '工具执行失败';
    if (!isBusinessDecisionStatus(decision.status)) {
      this.logger.warn(LAYER, `工具执行失败 status=${decision.status}: ${decision.reason}`);
    }
    return errorResponse(request.id, code, message, {
      invocationId: decision.invocationId,
      status: decision.status,
      confirmationTokenId: decision.confirmationTokenId,
    });
  }
}

/**
 * 业务性决策状态（reason 是 pipeline 刻意构造的清晰文案、不含内部异常串，对客户端有意义，可原样回显）；
 * 其余（failed/timeout/denied_circuit_open——reason 在 catch 里源自 err.message）为系统性失败，须脱敏。
 * denied_budget 与 denied_quota 同属预算/配额类业务拒绝，reason 是「当日预算/配额已耗尽」清晰文案（全维评审 G1 复审补）。
 */
function isBusinessDecisionStatus(status: string): boolean {
  return status === 'denied_authorization' || status === 'denied_permission'
    || status === 'denied_quota' || status === 'denied_budget'
    || status === 'pending_confirmation' || status === 'tool_not_found';
}

function mapStatusToErrorCode(status: string): number {
  switch (status) {
    case 'denied_authorization':
    case 'denied_permission':
      return MCP_ERROR_PERMISSION_DENIED;
    case 'denied_quota':
    case 'denied_budget':
      return MCP_ERROR_QUOTA_EXCEEDED;
    case 'pending_confirmation':
      return MCP_ERROR_CONFIRMATION_REQUIRED;
    case 'tool_not_found':
      return MCP_ERROR_TOOL_NOT_FOUND;
    case 'timeout':
      return MCP_ERROR_TIMEOUT;
    default:
      return MCP_ERROR_TOOL_FAILED;
  }
}

function successResponse<TResult>(id: string | number, result: TResult): JsonRpcResponse<TResult> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
}
