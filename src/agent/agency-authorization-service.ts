/**
 * 代理授权书 Application Service
 *
 * 不同于 ToolPermission（机器粒度），AgencyAuthorization 是法律语义粒度：
 *  - principalUserId 明确委托人（法律责任主体）
 *  - scopeDescription 是自然语言授权范围（用于审计取证）
 *  - allowedTools / deniedTools 决定该授权下可用的工具集合
 *
 * 工具调用前必须同时满足：
 *  1. 存在 active 的 AgencyAuthorization 覆盖该工具
 *  2. 存在未撤销未过期的 ToolPermission
 *
 * 双层授权：principal 授权 → tool permission 配置具体约束
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, AgencyAuthorization, AgencyAuthorizationRow, AgencyScope, AgencyStatus } from '@chrono/kernel';
import {
  agauthQueryById, agauthQueryListByPersona, agauthQueryListByPrincipal, agauthQueryByRevocationKey,
  agauthCmdCreate, agauthCmdRevoke, agauthCmdSuspend, agauthCmdResume,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { ValidationError, ErrorCode } from '../errors/index.js';

export interface CreateAuthorizationInput {
  readonly tenantId: string;
  readonly personaId: string;
  readonly principalUserId: string;
  readonly scope: AgencyScope;
  readonly scopeDescription: string;
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly expiresAt?: number | null;
}

export interface CreateAuthorizationResult {
  readonly id: string;
  readonly revocationKey: string;
}

export class AgencyAuthorizationService {
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  create(input: CreateAuthorizationInput): CreateAuthorizationResult {
    if (!input.scopeDescription.trim()) {
      throw new ValidationError('授权范围描述必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const id = `agauth_${randomUUID()}`;
    const revocationKey = `rk_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();

    this.tx.execute(agauthCmdCreate({
      id,
      tenantId: input.tenantId,
      personaId: input.personaId,
      principalUserId: input.principalUserId,
      scope: input.scope,
      scopeDescription: input.scopeDescription.trim(),
      allowedToolsJson: JSON.stringify(input.allowedTools ?? []),
      deniedToolsJson: JSON.stringify(input.deniedTools ?? []),
      grantedAt: now,
      expiresAt: input.expiresAt ?? null,
      revocationKey,
    }));

    return { id, revocationKey };
  }

  revoke(tenantId: string, id: string, reason: string): boolean {
    if (!reason.trim()) {
      throw new ValidationError('撤销原因必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const result = this.tx.execute(agauthCmdRevoke({
      id, tenantId, reason: reason.trim(), now: Date.now(),
    }));
    return result.rowsAffected > 0;
  }

  suspend(tenantId: string, id: string): boolean {
    const result = this.tx.execute(agauthCmdSuspend({
      id, tenantId, now: Date.now(),
    }));
    return result.rowsAffected > 0;
  }

  resume(tenantId: string, id: string): boolean {
    const result = this.tx.execute(agauthCmdResume({
      id, tenantId, now: Date.now(),
    }));
    return result.rowsAffected > 0;
  }

  /** 检查该 persona 的工具调用是否有 active 授权书允许 */
  isToolAllowed(tenantId: string, personaId: string, toolId: string, now = Date.now()): boolean {
    const auths = this.listByPersona(tenantId, personaId);
    return auths.some((auth) => {
      if (auth.status !== 'active') return false;
      if (auth.expiresAt !== null && auth.expiresAt < now) return false;
      if (auth.deniedTools.includes(toolId)) return false;
      if (auth.allowedTools.length === 0) return true; // 空白名单 = 按 scope 默认放行
      return auth.allowedTools.includes(toolId);
    });
  }

  getById(tenantId: string, id: string): AgencyAuthorization | null {
    const row = this.tx.queryOne(agauthQueryById({ id, tenantId }));
    return row ? rowToAuth(row) : null;
  }

  listByPersona(tenantId: string, personaId: string): AgencyAuthorization[] {
    const rows = this.tx.queryMany(agauthQueryListByPersona({ tenantId, personaId }));
    return rows.map(rowToAuth);
  }

  listByPrincipal(tenantId: string, principalUserId: string): AgencyAuthorization[] {
    const rows = this.tx.queryMany(agauthQueryListByPrincipal({ tenantId, principalUserId }));
    return rows.map(rowToAuth);
  }

  /** 通过 revocation_key 查找代理授权书。租户隔离：须传 tenantId 限定查询。 */
  findByRevocationKey(tenantId: string, key: string): AgencyAuthorization | null {
    const row = this.tx.queryOne(agauthQueryByRevocationKey({ tenantId, revocationKey: key }));
    return row ? rowToAuth(row) : null;
  }
}

function rowToAuth(row: AgencyAuthorizationRow): AgencyAuthorization {
  let allowedTools: string[] = [];
  let deniedTools: string[] = [];
  try { allowedTools = JSON.parse(row.allowed_tools_json) as string[]; } catch { /* 空 */ }
  try { deniedTools = JSON.parse(row.denied_tools_json) as string[]; } catch { /* 空 */ }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    principalUserId: row.principal_user_id,
    scope: row.scope as AgencyScope,
    scopeDescription: row.scope_description,
    allowedTools,
    deniedTools,
    status: row.status as AgencyStatus,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    revocationKey: row.revocation_key,
  };
}
