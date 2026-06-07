/**
 * 工具适配器接口
 *
 * 所有外部工具（WebSearch / Calendar / Email / 内部 MCP 工具）实现此接口。
 * ToolInvocationPipeline 通过此接口统一调度，不关心工具实际类型。
 */

import type { McpToolSchema } from '@chrono/kernel';

/**
 * 用户级 OAuth access token 解析器
 *
 * 工具按 scope 索取 access token；resolver 内部自动刷新 + 持久化。
 * 返回 null 表示该用户尚未对此 scope 授权（工具应回 401 引导授权）。
 */
export type UserOauthTokenResolver = (scope: string) => Promise<string | null>;

/** 工具调用上下文 */
export interface ToolInvocationContext {
  readonly tenantId: string;
  readonly personaId: string;
  readonly invokerType: 'mcp' | 'internal' | 'admin';
  readonly invokerId: string;
  /** 触发本次调用的用户 ID（用于按用户解析 OAuth token） */
  readonly invokerUserId?: string | null;
  readonly arguments: Record<string, unknown>;
  /** 二次确认 token（若工具 highRisk） */
  readonly confirmationToken?: string;
  /** 调用截止时间 */
  readonly deadline: number;
  /** 用户级 OAuth token 解析器（可选；存在则工具优先使用） */
  readonly oauthResolver?: UserOauthTokenResolver;
}

/** 工具内容元素 */
export type ToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly json: unknown };

/** 工具调用结果 */
export interface ToolInvocationResult {
  /** 标准化输出（structured） */
  readonly content: readonly ToolContent[];
  /** 计费金额（分） */
  readonly costCents: number;
  /** 输出 size（bytes，用于审计） */
  readonly outputSizeBytes: number;
}

/** 工具元数据 */
export interface ToolMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: McpToolSchema;
  /** 高风险工具：强制二次确认（pipeline 自动校验） */
  readonly highRisk: boolean;
  /** 默认超时（ms）；pipeline 强制；null = 无超时（仅极少数同步工具用） */
  readonly defaultTimeoutMs: number;
  /** 默认每日调用上限（用作 constraints fallback） */
  readonly defaultMaxPerDay: number;
}

/** 工具适配器 */
export interface ToolAdapter {
  readonly metadata: ToolMetadata;
  /**
   * 可选：按 action/参数 动态判定本次调用是否高风险（ADR-0048）。
   * 返回 true → pipeline 强制二次确认（叠加在 metadata.highRisk 之上）。
   * 用于"同工具不同 action 风险不同"——如 marketplace.apply 低风险免确认、
   * marketplace.submit 是对外承诺需确认。缺省时仅按 metadata.highRisk。
   */
  isHighRisk?(args: Record<string, unknown>): boolean;
  /**
   * 执行工具。pipeline 已完成所有前置检查（权限、配额、确认、断路器）。
   * 实现方只负责：读取 arguments → 调用底层 API → 返回 ToolInvocationResult。
   * 抛出异常 → pipeline 捕获并记录为 status=failed/timeout。
   */
  invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult>;
}
