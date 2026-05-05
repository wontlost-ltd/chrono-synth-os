/**
 * 工具权限模型类型
 *
 * 设计原则：
 *  1. 权限按 (personaId, toolId) 一一记录，独立于 agency authorization
 *  2. revocation 是 soft delete (revokedAt 非 null)，不允许删除（保留审计）
 *  3. constraints 使用 JSON 序列化，便于扩展
 *  4. 所有权限调用必须经过 ToolInvocationPipeline，绕过 = 严重 bug
 */

/** 工具调用 scope */
export type ToolScope = 'read' | 'write' | 'execute';

/** 工具调用 constraint */
export interface ToolConstraints {
  /** 每天最大调用次数；undefined 表示不限制 */
  readonly maxActionsPerDay?: number;
  /** 是否要求二次确认（高风险工具强制 true） */
  readonly requireConfirmation?: boolean;
  /** 预算上限（分），用于按调用计费的工具（如 LLM 检索） */
  readonly budgetLimitCents?: number;
  /** 收件人/目标白名单（email/calendar 用） */
  readonly allowList?: readonly string[];
  /** 拒绝列表（黑名单） */
  readonly denyList?: readonly string[];
}

/** 工具权限 */
export interface ToolPermission {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly scope: ToolScope;
  readonly constraints: ToolConstraints;
  /** 授权人（user id 或 system） */
  readonly grantedBy: string;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly revocationReason: string | null;
  /**
   * 撤销密钥 — 用于带外撤销（紧急情况下不依赖 admin UI）。
   * 持有此 key 的人/系统可以撤销该权限。
   */
  readonly revocationKey: string;
}

/** 工具权限授予参数 */
export interface ToolPermissionGrantParams {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly scope: ToolScope;
  readonly constraintsJson: string;
  readonly grantedBy: string;
  readonly now: number;
  readonly expiresAt: number | null;
  readonly revocationKey: string;
}

/** 工具权限检查输入 */
export interface ToolPermissionCheckInput {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly now: number;
}

/** 工具权限检查结果 */
export type ToolPermissionCheckResult =
  | { readonly allowed: true; readonly permission: ToolPermission }
  | { readonly allowed: false; readonly reason: ToolPermissionDenyReason };

/** 拒绝原因 */
export type ToolPermissionDenyReason =
  | 'not_granted'
  | 'expired'
  | 'revoked';

/** SQL 行类型 */
export interface ToolPermissionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly tool_id: string;
  readonly scope: string;
  readonly constraints_json: string;
  readonly granted_by: string;
  readonly granted_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly revocation_reason: string | null;
  readonly revocation_key: string;
}
