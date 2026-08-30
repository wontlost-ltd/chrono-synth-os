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
  /**
   * 授权人 user id —— **同时**承担两个角色（审计 #440-2），二者并不冲突：
   *
   *   - **审计字段**：永远记录「这份授权书是谁签发的」，是法律责任的落点，
   *     `listByPrincipal` / `getById` 照常可查（取证用）；
   *   - **授权键**：当本次调用**有人类主体**时，只有该主体自己签发的授权书
   *     才对它生效。
   *
   * ⚠️ 此前只落实了前者：判定不看 principal，于是同一 persona 上任一委托人的
   * 宽泛授权会替**所有人**放行（`idx_agency_authorizations_persona` 是非唯一
   * 索引，多份授权书本就能并存）。实测 bob 的全权委托让 alice 用上了
   * `wire_money`，而「Alice 只授权了只读」这条约束在系统里根本无法表达。
   *
   * ⚠️ 自主路径（`invokerUserId: null`，如 earning cycle）**不按 principal
   * 过滤** —— 它没有人类主体，拿谁去比都不对；其约束来自 allowedTools /
   * deniedTools 与叠加的 ToolPermission 层。详见 `coversPrincipal`。
   */
  readonly principalUserId: string;
  /** 授权范围 */
  readonly scope: AgencyScope;
  /** 授权范围的自然语言描述（用于法律证据） */
  readonly scopeDescription: string;
  /** 允许的工具白名单（toolId 列表）；空则按 scope 默认 */
  readonly allowedTools: readonly string[];
  /** 拒绝的工具黑名单 */
  readonly deniedTools: readonly string[];
  /**
   * 工具清单 JSON 解析失败（审计 #424）。true ⇒ 本授权书**一律不放行**。
   *
   * 为什么必须显式标记而不是退化成空数组：空数组在 `isToolAllowed` 里恰是
   * **放宽**语义 —— 空白名单 = 按 scope 默认放行、空拒绝清单 = 不拒任何工具。
   * 静默当空会让损坏的授权书从「仅 3 个工具」变成**全部工具**（实测：
   * 写坏 denied_tools_json 后，被明确拒绝的 wire_money 变成 allowed），
   * 且 GET 详情看到的仍是 `[]`，从外部看不出损坏。
   *
   * 可选字段：既有构造点（create/update 路径）不传即 undefined = 未损坏。
   */
  readonly toolListCorrupted?: boolean;
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
