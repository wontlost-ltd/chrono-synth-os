/**
 * SCIM Provisioning Application Service
 * 封装 SCIM 用户同步的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, ScimUserRow } from '@chrono/kernel';
import {
  scimQueryUsers, scimQueryUsersByEmail,
  scimQueryUserCount, scimQueryUserCountByEmail,
  scimQueryUserByEmailGlobal, scimQueryUserById,
  scimQueryUserExists, scimQueryAvatarIdsByUser,
  scimCmdCreateUser, scimCmdDeleteDeviceAvatars,
  scimCmdDeleteAutorunRunlog, scimCmdDeleteAutorunConfig,
  scimCmdDeleteAvatarsByIdentity, scimCmdDeleteRefreshTokens,
  scimCmdDeleteIdentities, scimCmdDeleteUser,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { StateError, ErrorCode } from '../errors/index.js';
import { IdentityService } from '../identity/identity-service.js';

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
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly evidenceRecorder?: ScimEvidenceRecorder,
    private readonly evidenceFailureSink?: ScimEvidenceFailureSink,
  ) {
    registerCoreSelfExecutors();
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

    let rows: readonly ScimUserRow[];
    let total: number;
    if (input.userName) {
      rows = this.tx.queryMany(scimQueryUsersByEmail({ tenantId, email: input.userName, count: input.count, offset }));
      total = this.tx.queryOne(scimQueryUserCountByEmail({ tenantId, email: input.userName }))?.count ?? 0;
    } else {
      rows = this.tx.queryMany(scimQueryUsers({ tenantId, count: input.count, offset }));
      total = this.tx.queryOne(scimQueryUserCount(tenantId))?.count ?? 0;
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
    const existing = this.tx.queryOne(scimQueryUserByEmailGlobal(input.email));
    if (existing && existing.tenant_id !== tenantId) {
      throw new StateError('该邮箱已存在于其他 tenant，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
    }

    const now = Date.now();
    const userId = existing?.id ?? `user_${randomUUID()}`;
    const identityService = new IdentityService(this.tx);
    if (!existing) {
      this.tx.execute(scimCmdCreateUser({ id: userId, email: input.email, tenantId, now }));
    }
    identityService.ensureForUser(userId, tenantId, input.displayName);

    const row = this.tx.queryOne(scimQueryUserById(userId));
    this.safeRecordEvidence({
      tenantId,
      evidenceType: 'scim_user_provisioned',
      payload: {
        userId, email: input.email, displayName: input.displayName,
        isNew: !existing, provisionedAt: now,
      },
    });
    return { user: toScimUser(row!), isNew: !existing };
  }

  deleteUser(tenantId: string, userId: string): boolean {
    const row = this.tx.queryOne(scimQueryUserExists({ tenantId, userId }));
    if (!row) return false;

    try {
      this.tx.transaction(() => {
        const avatarIds = this.tx.queryMany(scimQueryAvatarIdsByUser(userId));
        for (const avatar of avatarIds) {
          this.tx.execute(scimCmdDeleteDeviceAvatars(avatar.id));
          this.tx.execute(scimCmdDeleteAutorunRunlog(avatar.id));
          this.tx.execute(scimCmdDeleteAutorunConfig(avatar.id));
        }
        this.tx.execute(scimCmdDeleteAvatarsByIdentity(userId));
        this.tx.execute(scimCmdDeleteRefreshTokens(userId));
        this.tx.execute(scimCmdDeleteIdentities(userId));
        this.tx.execute(scimCmdDeleteUser({ userId, tenantId }));
      });
    } catch (error) {
      throw new StateError(
        `SCIM 删除失败，用户可能仍有关联业务数据: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }

    this.safeRecordEvidence({
      tenantId,
      evidenceType: 'scim_user_deprovisioned',
      payload: { userId, deprovisionedAt: Date.now() },
    });
    return true;
  }
}
