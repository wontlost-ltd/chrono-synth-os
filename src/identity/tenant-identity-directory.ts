/**
 * 协调库身份目录门面（tenant_identity_directory）。
 *
 * 租户分片 Phase 0 · Plan 1c Task 4 —— 把 Task 3 的 directory / bootstrap SQL executor 包成
 * **语义方法**（reserve / activate / resolve / record / changeEmail），供 Auth service 层调用。
 * 门面本身不含 SQL：每方法用 `resolver.coordinatorDb()` 取协调库，再走 Task 3 executor 的
 * Query/Command 工厂 —— 目录键（email/token/api_key → tenant）是**平台级**跨租户表，故落协调库而非
 * 任一 shard。
 *
 * 语义要点（reservedByUs 判据分两路）：
 *   - `reserveTenant`（register，密码流）：operationId **由调用方传入**（客户端 Idempotency-Key 或
 *     一次性随机）。reserve 用 `ON CONFLICT DO NOTHING`（幂等占位），随后读回既存行，
 *     `reservedByUs = 读回行.operation_id === 传入 operationId`。故同 operationId 重试（即使本地重新
 *     生成了随机 tenantId/userId）仍属己，且返回的 canonical 身份 + pendingPasswordHash 是**第一次
 *     持久化**的值（调用方据此写 shard、复用 hash 作 users.password_hash，不产生第二个租户）。
 *   - `reservePasswordlessTenant`（SSO/SCIM，无密码流）：内部生成一次性随机 operationId，
 *     `reservedByUs = 读回行.operation_id === 本次随机 operationId`——即只有我们刚插的才属己；任何冲突
 *     （已有 PENDING/ACTIVE）一律 false，不做「tenant_id 相等即续做」的无证明续做（一次性 state 无法续做）。
 *
 * `recordActiveLookup` 建 token/api_key → tenant 的 ACTIVE 目录项（已 ACTIVE 租户签发凭据，无两段
 * PENDING→ACTIVE）；`ON CONFLICT DO NOTHING` 后**读回校验 tenant_id 属己**，不等则抛（并发下两租户
 * 同键——极端但不假定同映射，宁可拒发凭据）。
 */

import { randomUUID } from 'node:crypto';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import {
  dirCmdReserve, dirCmdActivate, dirCmdDeleteByLookup, dirCmdDeleteByLookupOp,
  dirQueryByLookup, dirQueryPendingBefore,
} from '@chrono/kernel';
import type { DirectoryRow } from '@chrono/kernel';
import { StateError, StorageError, ErrorCode } from '../errors/index.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { canonicalizeEmail } from './email-canonical.js';

/** 门面对外返回的目录项（camelCase，隐藏 SQL 行 snake_case）。 */
export interface DirectoryEntry {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly status: string;
  readonly operationKind: string;
  readonly previousLookupValue: string | null;
  readonly pendingPasswordHash: string | null;
}

/** listPending 返回的过期 PENDING 工单（恢复 worker 用，Task 8）。 */
export interface PendingEntry {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly operationId: string;
  readonly operationKind: string;
  readonly previousLookupValue: string | null;
  readonly lookupKind: string;
  readonly lookupValue: string;
}

export class TenantIdentityDirectory {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /**
   * register 预留：写 email→tenant 的 PENDING 目录项（幂等占位）后读回既存行判 reservedByUs。
   *
   * operationId 由调用方传入。首次即刚插的行、重试即上次持久化的行——两种情况都从读回行取 canonical
   * 身份 + pendingPasswordHash，故重试不产生第二个租户、复用同一密码 hash。
   */
  reserveTenant(input: {
    tenantId: string;
    userId: string;
    operationId: string;
    pendingPasswordHash: string;
    email: string;
  }): { reservedByUs: boolean; canonicalTenantId: string; canonicalUserId: string; pendingPasswordHash: string } {
    const lookupValue = canonicalizeEmail(input.email);
    const db = this.resolver.coordinatorDb();
    db.execute(dirCmdReserve({
      tenantId: input.tenantId, userId: input.userId, operationId: input.operationId,
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: input.pendingPasswordHash,
      lookupKind: 'email', lookupValue, status: 'PENDING', now: Date.now(),
    }));
    const row = this.readLookup(db.queryOne(dirQueryByLookup('email', lookupValue)), lookupValue);
    return {
      reservedByUs: row.operation_id === input.operationId,
      canonicalTenantId: row.tenant_id,
      canonicalUserId: this.requireUserId(row, lookupValue),
      pendingPasswordHash: this.requireHash(row, lookupValue),
    };
  }

  /**
   * SSO/SCIM 无密码预留：内部生成一次性随机 operationId，reservedByUs 仅在本次 INSERT 成功（读回行
   * operation_id === 本次随机 operationId）时为 true——冲突一律 false（一次性 state 无跨请求续做）。
   */
  reservePasswordlessTenant(input: {
    tenantId: string;
    userId: string;
    email: string;
  }): { reservedByUs: boolean; operationId: string; canonicalTenantId: string; canonicalUserId: string } {
    const lookupValue = canonicalizeEmail(input.email);
    const operationId = `reg:${randomUUID()}`;
    const db = this.resolver.coordinatorDb();
    db.execute(dirCmdReserve({
      tenantId: input.tenantId, userId: input.userId, operationId,
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue, status: 'PENDING', now: Date.now(),
    }));
    const row = this.readLookup(db.queryOne(dirQueryByLookup('email', lookupValue)), lookupValue);
    return {
      reservedByUs: row.operation_id === operationId,
      operationId: row.operation_id,
      canonicalTenantId: row.tenant_id,
      canonicalUserId: this.requireUserId(row, lookupValue),
    };
  }

  /** CAS 激活 email 目录项 PENDING→ACTIVE，仅匹配 operationId 命中时成功。 */
  activateTenant(input: { email: string; operationId: string }): boolean {
    const db = this.resolver.coordinatorDb();
    const result = db.execute(dirCmdActivate({
      lookupKind: 'email', lookupValue: canonicalizeEmail(input.email),
      operationId: input.operationId, now: Date.now(),
    }));
    return result.rowsAffected === 1;
  }

  /** 按 email 查目录项（返全元数据供续做校验 / worker 分支），未命中 null。 */
  resolveByEmail(email: string): DirectoryEntry | null {
    const row = this.resolver.coordinatorDb().queryOne(dirQueryByLookup('email', canonicalizeEmail(email)));
    return row ? this.toEntry(row) : null;
  }

  /** 按 refresh token hash 查所属 tenant，仅 ACTIVE 命中。 */
  resolveByRefreshTokenHash(hash: string): { tenantId: string } | null {
    return this.resolveActiveTenant('refresh_token_hash', hash);
  }

  /** 按 api key hash 查所属 tenant，仅 ACTIVE 命中。 */
  resolveByApiKeyHash(hash: string): { tenantId: string } | null {
    return this.resolveActiveTenant('api_key_hash', hash);
  }

  /**
   * 建 token/api_key → tenant 的 ACTIVE 目录项（已 ACTIVE 租户签发凭据，无两段）。ON CONFLICT DO
   * NOTHING 后读回校验 tenant 属己，不等则抛（并发下两租户同键——不假定同映射，拒发凭据）。
   *
   * lookupKind 取 v123 schema CHECK 允许的 'refresh_token_hash' / 'api_key_hash'（brief 简写
   * refresh_token/api_key 与 schema 不符，以 schema CHECK 为准）；operation_kind 相应为 'API_KEY'/'TOKEN'。
   */
  recordActiveLookup(input: { tenantId: string; lookupKind: string; lookupValue: string }): void {
    const db = this.resolver.coordinatorDb();
    db.execute(dirCmdReserve({
      tenantId: input.tenantId, userId: null, operationId: `lk:${input.lookupKind}`,
      operationKind: input.lookupKind === 'api_key_hash' ? 'API_KEY' : 'TOKEN',
      previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: input.lookupKind, lookupValue: input.lookupValue, status: 'ACTIVE', now: Date.now(),
    }));
    const row = this.readLookup(db.queryOne(dirQueryByLookup(input.lookupKind, input.lookupValue)), input.lookupValue);
    if (row.tenant_id !== input.tenantId) {
      throw new StateError(
        `目录键 ${input.lookupKind} 已映射到其他租户，拒绝覆盖`,
        ErrorCode.STATE_ALREADY_EXISTS,
      );
    }
  }

  /**
   * 改名第一步：新 email 建 PENDING（EMAIL_CHANGE，previous=canon(oldEmail)），旧 email ACTIVE 保留
   * 不锁死。新 email 已被他人 ACTIVE/PENDING 占用（读回行 operationId ≠ 本次）→ 抛。
   */
  reserveEmailChange(input: {
    tenantId: string;
    userId: string;
    oldEmail: string;
    newEmail: string;
    operationId: string;
  }): void {
    const newLookup = canonicalizeEmail(input.newEmail);
    const db = this.resolver.coordinatorDb();
    db.execute(dirCmdReserve({
      tenantId: input.tenantId, userId: input.userId, operationId: input.operationId,
      operationKind: 'EMAIL_CHANGE', previousLookupValue: canonicalizeEmail(input.oldEmail),
      pendingPasswordHash: null, lookupKind: 'email', lookupValue: newLookup,
      status: 'PENDING', now: Date.now(),
    }));
    const row = this.readLookup(db.queryOne(dirQueryByLookup('email', newLookup)), newLookup);
    if (row.operation_id !== input.operationId) {
      throw new StateError('目标邮箱已被占用', ErrorCode.AUTH_EMAIL_EXISTS);
    }
  }

  /**
   * 改名提交：CAS 新 email PENDING→ACTIVE 成功后，才删旧 email 目录项（旧地址不再权威）。
   *
   * 删旧 email **守卫在 CAS 命中之后**——若 CAS 未命中（rowsAffected≠1，如 stale/错 operationId、新
   * PENDING 已被 rollback/过期），新 email 未激活，则抛 StateError 通知调用方（register / Task 8 恢复
   * worker）完成失败，**绝不删旧 email**。否则「新未激活 + 旧被删」会让用户无任何 ACTIVE email 目录项，
   * login 按 email 查 null → 账号锁死（违「绝不破坏用户空间」）。
   */
  completeEmailChange(input: { oldEmail: string; newEmail: string; operationId: string }): void {
    const db = this.resolver.coordinatorDb();
    const newLookup = canonicalizeEmail(input.newEmail);
    const oldLookup = canonicalizeEmail(input.oldEmail);
    /* CAS 激活新 + 删旧作**同一协调库事务**原子提交（Codex Task 9 复审 #1）：消除「CAS 后、删旧前崩」
     * 留下「新旧双 ACTIVE」永久态（Task 8 只扫 PENDING、同参重试因 shard 已新 no-op，二者都收不回该态）。
     * CAS 未命中 → 抛错触发事务回滚（新未激活、旧未删）——旧 email 仍权威 ACTIVE 可 login，交 Task 8 收敛。 */
    db.transaction(() => {
      const activated = db.execute(dirCmdActivate({
        lookupKind: 'email', lookupValue: newLookup, operationId: input.operationId, now: Date.now(),
      })).rowsAffected === 1;
      if (!activated) {
        throw new StateError('改名提交失败：新 email PENDING→ACTIVE CAS 未命中，旧 email 保留', ErrorCode.STATE_INVALID_TRANSITION);
      }
      db.execute(dirCmdDeleteByLookup('email', oldLookup));
    });
  }

  /** 改名回滚：按 operationId 删自己未竟的新 PENDING（旧 email 仍权威 ACTIVE）。 */
  rollbackEmailChange(input: { newEmail: string; operationId: string }): void {
    this.resolver.coordinatorDb().execute(
      dirCmdDeleteByLookupOp('email', canonicalizeEmail(input.newEmail), input.operationId),
    );
  }

  /** 撤销凭据时清目录项（尽力而为；正确性靠 shard is_revoked 权威）。 */
  removeLookup(lookupKind: string, lookupValue: string): void {
    this.resolver.coordinatorDb().execute(dirCmdDeleteByLookup(lookupKind, lookupValue));
  }

  /** 列 updated_at < cutoff 的 PENDING 工单（恢复 worker 用，Task 8）。 */
  listPending(cutoff: number): PendingEntry[] {
    const rows = this.resolver.coordinatorDb().queryMany(dirQueryPendingBefore(cutoff));
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      userId: r.user_id,
      operationId: r.operation_id,
      operationKind: r.operation_kind,
      previousLookupValue: r.previous_lookup_value,
      lookupKind: r.lookup_kind,
      lookupValue: r.lookup_value,
    }));
  }

  /* ── 私有 ── */

  /** ACTIVE 命中才返 tenantId，PENDING / 未命中 → null。 */
  private resolveActiveTenant(lookupKind: string, lookupValue: string): { tenantId: string } | null {
    const row = this.resolver.coordinatorDb().queryOne(dirQueryByLookup(lookupKind, lookupValue));
    if (!row || row.status !== 'ACTIVE') return null;
    return { tenantId: row.tenant_id };
  }

  /** 读回既存行——reserve/record 语义要求「写后必有行」，缺失即数据完整性违规（fail-closed）。 */
  private readLookup(row: DirectoryRow | null, lookupValue: string): DirectoryRow {
    if (!row) {
      throw new StorageError(`目录项写入后读回缺失: ${lookupValue}`, ErrorCode.STORAGE_READ);
    }
    return row;
  }

  private requireUserId(row: DirectoryRow, lookupValue: string): string {
    if (row.user_id === null) {
      throw new StorageError(`目录项缺少 user_id: ${lookupValue}`, ErrorCode.STORAGE_READ);
    }
    return row.user_id;
  }

  private requireHash(row: DirectoryRow, lookupValue: string): string {
    if (row.pending_password_hash === null) {
      throw new StorageError(`register 目录项缺少 pending_password_hash: ${lookupValue}`, ErrorCode.STORAGE_READ);
    }
    return row.pending_password_hash;
  }

  private toEntry(row: DirectoryRow): DirectoryEntry {
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      status: row.status,
      operationKind: row.operation_kind,
      previousLookupValue: row.previous_lookup_value,
      pendingPasswordHash: row.pending_password_hash,
    };
  }
}
