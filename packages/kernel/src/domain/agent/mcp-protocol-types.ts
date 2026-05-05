/**
 * MCP (Model Context Protocol) 协议类型 — JSON-RPC 2.0 over HTTP
 *
 * 兼容 MCP spec 2024-11-05。
 *
 * 设计原则：
 *  1. kernel 端只保留协议结构，不含传输层（HTTP / SSE）实现
 *  2. 所有工具调用必须经过 ToolInvocationPipeline 的权限闸门
 *  3. 错误码遵循 JSON-RPC 标准 + MCP 扩展
 */

/* ── JSON-RPC 2.0 信封 ──────────────────────────────────────────────── */

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result: TResult;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly error: JsonRpcError;
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/* ── JSON-RPC 标准错误码 + MCP 扩展 ─────────────────────────────────── */

export const JSONRPC_ERROR_PARSE = -32700;
export const JSONRPC_ERROR_INVALID_REQUEST = -32600;
export const JSONRPC_ERROR_METHOD_NOT_FOUND = -32601;
export const JSONRPC_ERROR_INVALID_PARAMS = -32602;
export const JSONRPC_ERROR_INTERNAL = -32603;

/** MCP 扩展错误码（-32000 ~ -32099 区间） */
export const MCP_ERROR_UNAUTHORIZED = -32001;
export const MCP_ERROR_PERMISSION_DENIED = -32002;
export const MCP_ERROR_QUOTA_EXCEEDED = -32003;
export const MCP_ERROR_TOOL_NOT_FOUND = -32004;
export const MCP_ERROR_CONFIRMATION_REQUIRED = -32005;
export const MCP_ERROR_TOOL_FAILED = -32006;
export const MCP_ERROR_TIMEOUT = -32007;
export const MCP_ERROR_RATE_LIMITED = -32008;

/* ── MCP 方法常量 ───────────────────────────────────────────────────── */

/** initialize — 客户端首次连接，协商能力 */
export const MCP_METHOD_INITIALIZE = 'initialize' as const;

/** tools/list — 列出当前 token 可用的工具 */
export const MCP_METHOD_TOOLS_LIST = 'tools/list' as const;

/** tools/call — 调用一个工具 */
export const MCP_METHOD_TOOLS_CALL = 'tools/call' as const;

/** ping — 心跳（保持连接） */
export const MCP_METHOD_PING = 'ping' as const;

/* ── MCP 工具规格 ───────────────────────────────────────────────────── */

/** JSON Schema 简化类型（避免引入 zod / ajv） */
export interface McpToolSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** 是否为高风险工具（强制二次确认） */
  readonly highRisk: boolean;
  readonly inputSchema: McpToolSchema;
}

/* ── initialize 协商 ────────────────────────────────────────────────── */

export interface McpInitializeParams {
  readonly protocolVersion: string;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: McpClientCapabilities;
}

export interface McpClientCapabilities {
  /** 客户端支持的特性集 */
  readonly experimental?: Record<string, unknown>;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: McpServerCapabilities;
}

export interface McpServerCapabilities {
  readonly tools?: { readonly listChanged: boolean };
}

/* ── tools/list ─────────────────────────────────────────────────────── */

export interface McpToolsListResult {
  readonly tools: readonly McpTool[];
}

/* ── tools/call ─────────────────────────────────────────────────────── */

export interface McpToolsCallParams {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** 二次确认 token（若工具是 highRisk） */
  readonly confirmationToken?: string;
}

export interface McpToolsCallResult {
  readonly content: readonly McpContent[];
  /** 是否为部分结果（异步工具用） */
  readonly isError?: boolean;
}

export type McpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly json: unknown };

/** 协议版本常量 */
export const MCP_PROTOCOL_VERSION = '2024-11-05' as const;

/** ChronoSynth 服务端身份信息 */
export const MCP_SERVER_INFO = {
  name: 'chrono-synth-os',
  version: '2.0.0',
} as const;
