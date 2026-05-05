/**
 * 代理授权书（Agency Authorization）
 *
 * 区别于 ToolPermission：
 *  - ToolPermission：单个工具单个 persona 的权限粒度
 *  - AgencyAuthorization：人类授权人类似"委托代理书"，明确代理范围、目标、责任
 *
 * 在欧美企业法律语境中，AI 代表用户行动需要明确的授权依据。
 * 此类型即为该法律责任在系统中的承载。
 */

/** 代理范围 */
export type AgencyScope = 'communication' | 'scheduling' | 'research' | 'finance' | 'all';

/** 授权状态 */
export type AgencyStatus = 'active' | 'suspended' | 'revoked' | 'expired';

/** 代理授权书 */
export interface AgencyAuthorization {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  /** 授权人 user id */
  readonly principalUserId: string;
  /** 授权范围 */
  readonly scope: AgencyScope;
  /** 授权范围的自然语言描述（用于法律证据） */
  readonly scopeDescription: string;
  /** 允许的工具白名单（toolId 列表）；空则按 scope 默认 */
  readonly allowedTools: readonly string[];
  /** 拒绝的工具黑名单 */
  readonly deniedTools: readonly string[];
  readonly status: AgencyStatus;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly revocationReason: string | null;
  readonly revocationKey: string;
}

/** 创建参数 */
export interface AgencyAuthorizationCreateParams {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly principalUserId: string;
  readonly scope: AgencyScope;
  readonly scopeDescription: string;
  readonly allowedToolsJson: string;
  readonly deniedToolsJson: string;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly revocationKey: string;
}

/** SQL 行类型 */
export interface AgencyAuthorizationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly principal_user_id: string;
  readonly scope: string;
  readonly scope_description: string;
  readonly allowed_tools_json: string;
  readonly denied_tools_json: string;
  readonly status: string;
  readonly granted_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly revocation_reason: string | null;
  readonly revocation_key: string;
}
