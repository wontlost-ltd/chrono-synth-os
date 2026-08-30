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

  /**
   * 检查某次工具调用是否被 active 授权书覆盖。
   *
   * @param executingPrincipalUserId 本次调用**代表谁**行动。
   *   - 具体 userId：人类操作者路径（worker-execution / companion）；
   *   - `null`：数字人**自主**行动（earning cycle / 内部动作），无人类主体。
   *
   * ⚠️ 审计 #440-2：此前签名里**没有执行主体**，判定是
   * 「该 persona 上任意一份 active 授权书覆盖了该工具即放行」。
   * 由于 `idx_agency_authorizations_persona` 是**非唯一**索引，同一 persona 上
   * 可以并存多份授权书，于是：
   *
   *   alice 授权（只读）→ read_email 放行 / wire_money 拒绝
   *   bob 另签一份宽泛授权 → **wire_money 对 alice 也放行了**
   *
   * 后果是「Alice 只授权了只读」这条约束在系统里**根本无法表达** —— 任何
   * 其他委托人的宽泛授权都会替她放行。
   *
   * ⚠️ 但不能简单要求「principal 必须等于执行者」：`persona-earning-service`
   * 与 `draft-github-reply` 等**自主路径**明确传 `invokerUserId: null`
   * （数字人自己在跑 earning cycle，本就没有人类发起者）。一刀切匹配会让
   * 自主赚钱闭环全挂 —— 那比原缺陷更糟。
   *
   * 故按「有没有人类主体」分流（见 `coversPrincipal`）。
   */
  isToolAllowedForPrincipal(
    tenantId: string,
    personaId: string,
    toolId: string,
    executingPrincipalUserId: string | null,
    now = Date.now(),
  ): boolean {
    const auths = this.listByPersona(tenantId, personaId);
    return auths.some((auth) => {
      if (auth.status !== 'active') return false;
      /* ⚠️ 审计 #424：工具清单损坏 ⇒ **fail-closed**。
       * 空数组在下面恰是「放宽」语义（空白名单=按 scope 放行、空拒绝清单=不拒），
       * 若把损坏静默当空，授权书会从「限制性」变成**完全放行**。 */
      if (auth.toolListCorrupted) return false;
      if (auth.expiresAt !== null && auth.expiresAt < now) return false;
      if (!coversPrincipal(auth, executingPrincipalUserId)) return false;
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

/**
 * 该授权书是否覆盖本次调用的**执行主体**（审计 #440-2）。
 *
 * `principal_user_id` 同时承担两个角色，二者并不冲突：
 *   - **审计字段**：永远记录「这份授权书是谁签发的」，出事可追责；
 *   - **授权键**：当本次调用有人类主体时，决定它能否用这份授权。
 *
 * 分流规则：
 *
 * | 执行主体 | 判据 |
 * |---|---|
 * | 某个 userId | 只认**该 userId 自己签发**的授权书 |
 * | null（自主） | 任一委托人签发的授权书都可用，工具边界仍由 allowed/denied 把关 |
 *
 * 为什么自主路径不按 principal 过滤：自主行动**没有**人类主体，拿谁去比都不对。
 * 它的约束来自别处 —— `allowedTools`/`deniedTools` 已经限定了工具边界，
 * 叠加的 ToolPermission 层还有 scope/constraints，自主路径并非无人看管。
 *
 * ⚠️ 我先试过用 `scope === 'all'` 当自主许可，**是错的**：
 * `autonomous-earning-e2e` 的真实夹具用 `scope: 'research'` +
 * `allowedTools: ['marketplace.act']` 授权自主接活 —— 窄 scope + 精确工具清单
 * 恰恰是更好的安全实践。按 `scope='all'` 判会把它拒掉（实测 2 条 E2E 转红），
 * 反而逼用户去申请全权委托才能保住自主运行，比现状更糟。
 *
 * ⚠️ 这条规则**改变了产品语义**：此前靠「别人的宽泛授权顺带放行」而工作的
 * **有人类主体**的调用会开始被拒。这是有意为之 —— 那正是缺陷本身。
 * 自主路径的行为不变（本就没有「借用别人授权」这一说）。
 */
function coversPrincipal(auth: AgencyAuthorization, executingPrincipalUserId: string | null): boolean {
  if (executingPrincipalUserId === null) return true;
  return auth.principalUserId === executingPrincipalUserId;
}

/**
 * 工具清单 JSON 解析（审计 #424）。
 *
 * ⚠️ 此前是 `catch { /* 空 *\/ }` —— 解析失败静默退化成空数组，而空数组在
 * `isToolAllowed` 里恰恰是**放宽**语义：
 *   - `deniedTools` 损坏 → `[]` → `includes(toolId)` 恒假 → 拒绝清单变成**死代码**；
 *   - `allowedTools` 损坏 → `[]` → 命中「空白名单 = 按 scope 默认放行」→ 从
 *     「仅 3 个工具」变成**全部工具**。
 *
 * 实测：把 `denied_tools_json` 写坏后，被明确拒绝的 `wire_money` 变成 allowed。
 * 且 GET 授权书详情看到的仍是 `[]`，**从外部看不出损坏**。
 *
 * 任何写入路径 bug、迁移截断、字符集问题都会触发 —— 而后果是授权书静默变成
 * 完全放行。故改为 **fail-closed**：解析失败返回 null，调用方据此整条作废。
 */
function parseToolList(json: string): string[] | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    /* 非数组同样视为损坏（如被写成 `{}` 或 `"abc"`）—— 否则 includes 会抛或恒假。 */
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
}

function rowToAuth(row: AgencyAuthorizationRow): AgencyAuthorization {
  const allowedParsed = parseToolList(row.allowed_tools_json);
  const deniedParsed = parseToolList(row.denied_tools_json);
  /* 任一清单损坏 ⇒ 整条授权书不可信，标记为 corrupted（isToolAllowed 一律拒绝）。 */
  const toolListCorrupted = allowedParsed === null || deniedParsed === null;
  const allowedTools = allowedParsed ?? [];
  const deniedTools = deniedParsed ?? [];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    principalUserId: row.principal_user_id,
    scope: row.scope as AgencyScope,
    scopeDescription: row.scope_description,
    allowedTools,
    deniedTools,
    toolListCorrupted,
    status: row.status as AgencyStatus,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    revocationKey: row.revocation_key,
  };
}
