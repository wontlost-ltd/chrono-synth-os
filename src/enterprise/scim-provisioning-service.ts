/**
 * SCIM Provisioning Application Service
 * 封装 SCIM 用户同步的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { ScimUserRow } from '@chrono/kernel';
import {
  scimQueryUsers, scimQueryUsersByEmail,
  scimQueryUserCount, scimQueryUserCountByEmail,
  scimQueryUserById,
  scimQueryUserExists, scimQueryAvatarIdsByUser,
  scimCmdCreateUser, scimCmdDeleteDeviceAvatars,
  scimCmdDeleteAutorunRunlog, scimCmdDeleteAutorunConfig,
  scimCmdDeleteAvatarsByIdentity, scimCmdDeleteRefreshTokens,
  scimCmdDeleteIdentities, scimCmdDeleteUser,
  bootQueryByOperation, bootCmdMarkComplete,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { StateError, ErrorCode } from '../errors/index.js';
import { IdentityWriter } from '../identity/identity-service.js';
import { TenantIdentityDirectory } from '../identity/tenant-identity-directory.js';
import { canonicalizeEmail } from '../identity/email-canonical.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

/**
 * SCIM 操作发出的 CC6.1 证据签名。调用方通常注入 `recordEvidence` 的
 * 适配函数：传 tenantId/payload 进来，由调用方决定写入哪个 db 实例。
 * 故意做成可选 — 单元测试不必关心证据通道；生产路由必须接入。
 */
export type ScimEvidenceRecorder = (input: {
  tenantId: string;
  evidenceType: 'scim_user_provisioned' | 'scim_user_deprovisioned';
  payload: Record<string, unknown>;
}) => void;

/**
 * 证据写入失败可观测性回调。recorder 抛错时本服务调用此 sink 把结构化
 * 失败上报到日志/指标/DLQ，避免静默丢失 CC6.1 证据。
 */
export type ScimEvidenceFailureSink = (failure: {
  tenantId: string;
  evidenceType: 'scim_user_provisioned' | 'scim_user_deprovisioned';
  error: Error;
}) => void;

function toScimUser(row: Pick<ScimUserRow, 'id' | 'email' | 'created_at' | 'updated_at'>) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: row.id,
    userName: row.email,
    active: true,
    emails: [{ value: row.email, primary: true }],
    meta: {
      resourceType: 'User',
      created: new Date(Number(row.created_at)).toISOString(),
      lastModified: new Date(Number(row.updated_at)).toISOString(),
    },
  };
}

export interface ScimListInput {
  userName?: string;
  startIndex: number;
  count: number;
}

export interface ScimCreateInput {
  email: string;
  displayName: string;
}

export class ScimProvisioningService {
  /** 协调库身份目录门面：email→tenant 目录 reserve/activate/resolve 全经它（Plan 1c Task 4）。 */
  private readonly directory: TenantIdentityDirectory;

  /**
   * 分片 Plan 1c Task 6：SCIM createUser 是 mixed-scope（先协调库目录定位 email→tenant，再租户级写 shard）。
   * 全局 email 查从裸 `tx.queryOne(scimQueryUserByEmailGlobal)`（错-shard）改为
   * `directory.resolveByEmail(canonicalizeEmail(email))`；写走 `resolver.dbForTenant(tenantId)` 单事务
   * + `bootCmdMarkComplete(tenantId, operationId)`（per-op）。SCIM createUser 的 tenantId 是目标租户
   * （客户端给，非自生成）；email 全新时用 `reservePasswordlessTenant` 保证 email 全局唯一定位。
   */
  constructor(
    private readonly resolver: TenantDbResolver,
    private readonly evidenceRecorder?: ScimEvidenceRecorder,
    private readonly evidenceFailureSink?: ScimEvidenceFailureSink,
  ) {
    registerCoreSelfExecutors();
    this.directory = new TenantIdentityDirectory(this.resolver);
  }

  private safeRecordEvidence(input: Parameters<ScimEvidenceRecorder>[0]): void {
    if (!this.evidenceRecorder) return;
    try {
      this.evidenceRecorder(input);
    } catch (err) {
      /* evidence 写入失败不阻塞 SCIM 主流程，但必须可观测：
       * GA 要求 CC6.1 证据 100% 覆盖，所以静默吞错会破坏审计完整性。
       * 失败通过 evidenceFailureSink 报到日志 / metrics / DLQ。 */
      this.evidenceFailureSink?.({
        tenantId: input.tenantId,
        evidenceType: input.evidenceType,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  listUsers(tenantId: string, input: ScimListInput) {
    const offset = input.startIndex - 1;
    const shardDb = this.resolver.dbForTenant(tenantId);

    let rows: readonly ScimUserRow[];
    let total: number;
    if (input.userName) {
      /* SCIM userName filter 是 email（大小写归一化后按 v124 存储侧 LOWER(TRIM) 对齐）。 */
      const email = canonicalizeEmail(input.userName);
      rows = shardDb.queryMany(scimQueryUsersByEmail({ tenantId, email, count: input.count, offset }));
      total = shardDb.queryOne(scimQueryUserCountByEmail({ tenantId, email }))?.count ?? 0;
    } else {
      rows = shardDb.queryMany(scimQueryUsers({ tenantId, count: input.count, offset }));
      total = shardDb.queryOne(scimQueryUserCount(tenantId))?.count ?? 0;
    }

    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex: input.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map(toScimUser),
    };
  }

  createUser(tenantId: string, input: ScimCreateInput) {
    /* email 归一化：与 v124 存储侧 LOWER(TRIM(email)) 对齐，目录查/写、shard users.email 一律 canon 值。 */
    const canonEmail = canonicalizeEmail(input.email);
    /* 全局 email 定位经协调库目录（非某 shard users 查）：属其他 tenant → 拒。 */
    const entry = this.directory.resolveByEmail(canonEmail);
    if (entry && entry.tenantId !== tenantId) {
      throw new StateError('该邮箱已存在于其他 tenant，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
    }

    const shardDb = this.resolver.dbForTenant(tenantId);

    /* 既有 email（本 tenant）：确保身份存在、读回 shard user 行，isNew=false。 */
    if (entry) {
      if (entry.userId === null) {
        throw new StateError('目录项缺少 user 绑定，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
      }
      new IdentityWriter(tenantId, shardDb).ensureForUser(entry.userId, input.displayName);
      const row = shardDb.queryOne(scimQueryUserById(entry.userId));
      if (!row) {
        throw new StateError('目录标记 email 已存在但 shard 无对应 user 行', ErrorCode.STATE_INVALID_TRANSITION);
      }
      this.recordProvisioned(tenantId, { userId: entry.userId, email: canonEmail, displayName: input.displayName, isNew: false });
      return { user: toScimUser(row), isNew: false };
    }

    /* 全新 email：目录无密码预留（内部随机 operationId）→ canonical 身份 + operationId 写目标 shard。
     * SCIM createUser 的 tenantId 是客户端给的目标租户，reserve 用它作候选（canonical 以读回为准）。 */
    const reservation = this.directory.reservePasswordlessTenant({
      tenantId, userId: `user_${randomUUID()}`, email: canonEmail,
    });
    /* reservedByUs=false → 并发下他人刚占该 email（一次性 state 无续做）。 */
    if (!reservation.reservedByUs) {
      throw new StateError('该邮箱注册进行中，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
    }
    if (reservation.canonicalTenantId !== tenantId) {
      throw new StateError('该邮箱已存在于其他 tenant，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
    }

    const userId = reservation.canonicalUserId;
    const { operationId } = reservation;
    /* per-op bootstrap 完成标记：已 COMPLETE 即本次 operation 已落地（重试）→ 跳过重建。 */
    const boot = shardDb.queryOne(bootQueryByOperation(tenantId, operationId));
    if (boot?.status !== 'COMPLETE') {
      /* IdentityWriter.create 内部自开事务（node:sqlite 平坦 BEGIN 不可嵌套），故在主事务前独立写。 */
      new IdentityWriter(tenantId, shardDb).ensureForUser(userId, input.displayName);
      const now = Date.now();
      shardDb.transaction(() => {
        shardDb.execute(scimCmdCreateUser({ id: userId, email: canonEmail, tenantId, now }));
        shardDb.execute(bootCmdMarkComplete({ tenantId, operationId, now }));
      });
    }

    this.directory.activateTenant({ email: canonEmail, operationId });

    const row = shardDb.queryOne(scimQueryUserById(userId));
    if (!row) {
      throw new StateError('SCIM createUser 写入后读回 user 行缺失', ErrorCode.STATE_INVALID_TRANSITION);
    }
    this.recordProvisioned(tenantId, { userId, email: canonEmail, displayName: input.displayName, isNew: true });
    return { user: toScimUser(row), isNew: true };
  }

  /** 发出 scim_user_provisioned SOC2 CC6.1 证据（best-effort，失败经 sink 可观测）。 */
  private recordProvisioned(
    tenantId: string,
    detail: { userId: string; email: string; displayName: string; isNew: boolean },
  ): void {
    this.safeRecordEvidence({
      tenantId,
      evidenceType: 'scim_user_provisioned',
      payload: { ...detail, provisionedAt: Date.now() },
    });
  }

  deleteUser(tenantId: string, userId: string): boolean {
    const shardDb = this.resolver.dbForTenant(tenantId);
    const row = shardDb.queryOne(scimQueryUserExists({ tenantId, userId }));
    if (!row) return false;

    /* 删前取 email，用于清协调库目录项（释放 email 供重导入；正确性靠 shard user 删除权威）。 */
    const userRow = shardDb.queryOne(scimQueryUserById(userId));
    const email = userRow?.email;

    try {
      shardDb.transaction(() => {
        const avatarIds = shardDb.queryMany(scimQueryAvatarIdsByUser(userId));
        for (const avatar of avatarIds) {
          shardDb.execute(scimCmdDeleteDeviceAvatars(avatar.id));
          shardDb.execute(scimCmdDeleteAutorunRunlog(avatar.id));
          shardDb.execute(scimCmdDeleteAutorunConfig(avatar.id));
        }
        shardDb.execute(scimCmdDeleteAvatarsByIdentity(userId));
        shardDb.execute(scimCmdDeleteRefreshTokens(userId));
        shardDb.execute(scimCmdDeleteIdentities(userId));
        shardDb.execute(scimCmdDeleteUser({ userId, tenantId }));
      });
    } catch (error) {
      throw new StateError(
        `SCIM 删除失败，用户可能仍有关联业务数据: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }

    /* shard user 已删 → 清协调库 email 目录项（尽力而为，释放 email 供重导入）。 */
    if (email) {
      this.directory.removeLookup('email', canonicalizeEmail(email));
    }

    this.safeRecordEvidence({
      tenantId,
      evidenceType: 'scim_user_deprovisioned',
      payload: { userId, deprovisionedAt: Date.now() },
    });
    return true;
  }
}
