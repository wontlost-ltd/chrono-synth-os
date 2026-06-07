/**
 * PersonaLease 存储（ADR-0047 + ADR-0048）— 薄适配器，委托 kernel query/command。
 *
 * 提供 per-persona-per-purpose 的分布式互斥：
 *   - acquire：原子 CAS（无锁/已过期才成功），返回拿到的租约或 null；
 *   - release：仅释放本持有者的锁；
 *   - refresh：长任务续租；
 *   - withLease：acquire→执行→finally release 的便捷包装。
 *
 * 纯决策逻辑（validateAcquireIntent / leaseExpiry / isLeaseExpired）在 kernel；
 * 本类只负责持久化与行↔领域对象映射 + 生成持有者令牌。
 *
 * ⚠️ TTL 与时钟前提（部署约束）：
 *   - 互斥仅在「临界区实际耗时 << TTL」时成立。一旦持有者执行超过 TTL，第二实例会
 *     按设计抢占，而原持有者可能仍在执行 → split-brain。因此 TTL 必须显著大于
 *     可证明的最大临界区耗时。当前两个用途的临界区都很短：compile 是**全同步**执行
 *     （单事件循环 tick 内完成，无 await 让出点，进程不被冻结则不可能超时被抢），
 *     TTL=60s 余量极大；earning cycle 是短异步（毫秒~秒级），TTL=120s 余量充足。
 *     若未来引入更长的临界区，必须改用 refresh 心跳续租（本类已提供 refresh）。
 *   - CAS 的过期判定用调用方传入的 now（应用时钟），多实例间时钟漂移须显著小于 TTL；
 *     生产部署需保证 NTP 同步。若漂移可能逼近 TTL，应改用 DB 端时间。
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  personaLeaseQueryGet,
  personaLeaseCmdAcquire,
  personaLeaseCmdRelease,
  personaLeaseCmdRefresh,
  personaLeaseFromRow,
  leaseExpiry,
  validateAcquireIntent,
  validateRefreshIntent,
  type PersonaLease,
  type PersonaLeasePurpose,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';

/** 成功获取的租约句柄：携带 holderToken，供 release/refresh 使用。 */
export interface LeaseHandle {
  readonly tenantId: string;
  readonly personaId: string;
  readonly purpose: PersonaLeasePurpose;
  readonly holderToken: string;
  readonly expiresAt: number;
}

export class PersonaLeaseStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * 尝试获取锁。成功返回句柄；被未过期的他人持有则返回 null。
   * @param now 当前 epoch ms（调用方注入 clock.now()，与业务时间同源）
   * @param ttlMs 租约存活时长；持有者崩溃后到期可被抢占
   */
  acquire(personaId: string, purpose: PersonaLeasePurpose, now: number, ttlMs: number): LeaseHandle | null {
    const holderToken = randomUUID();
    const expiresAt = leaseExpiry(now, ttlMs);
    const intent = { tenantId: this.tenantId, personaId, purpose, holderToken, now, ttlMs };
    const errors = validateAcquireIntent(intent);
    if (errors.length > 0) {
      throw new Error(`PersonaLease acquire 非法输入: ${errors.join('; ')}`);
    }
    const result = this.tx.execute(personaLeaseCmdAcquire({
      tenantId: this.tenantId,
      personaId,
      purpose,
      holderToken,
      acquiredAt: now,
      expiresAt,
      now,
    }));
    if (result.rowsAffected <= 0) return null;
    return { tenantId: this.tenantId, personaId, purpose, holderToken, expiresAt };
  }

  /** 释放本持有者的锁。返回是否真的释放了（false = 锁已不归本持有者）。 */
  release(handle: LeaseHandle): boolean {
    const result = this.tx.execute(personaLeaseCmdRelease({
      tenantId: handle.tenantId,
      personaId: handle.personaId,
      purpose: handle.purpose,
      holderToken: handle.holderToken,
    }));
    return result.rowsAffected > 0;
  }

  /** 续租：仅当锁仍由本持有者持有且未过期才延长。返回新句柄或 null（续租失败）。 */
  refresh(handle: LeaseHandle, now: number, ttlMs: number): LeaseHandle | null {
    const intent = { ...handle, now, ttlMs };
    const errors = validateRefreshIntent(intent);
    if (errors.length > 0) {
      throw new Error(`PersonaLease refresh 非法输入: ${errors.join('; ')}`);
    }
    const expiresAt = leaseExpiry(now, ttlMs);
    const result = this.tx.execute(personaLeaseCmdRefresh({
      tenantId: handle.tenantId,
      personaId: handle.personaId,
      purpose: handle.purpose,
      holderToken: handle.holderToken,
      expiresAt,
      now,
    }));
    if (result.rowsAffected <= 0) return null;
    return { ...handle, expiresAt };
  }

  /** 读取当前租约（用于诊断/巡检）。 */
  get(personaId: string, purpose: PersonaLeasePurpose): PersonaLease | undefined {
    const row = this.tx.queryOne(personaLeaseQueryGet({ tenantId: this.tenantId, personaId, purpose }));
    return row ? personaLeaseFromRow(row) : undefined;
  }

  /**
   * 便捷包装：拿到锁则执行 fn 并在 finally 释放；拿不到锁返回 undefined（调用方据此跳过）。
   * fn 抛异常时锁仍会被释放，避免持有者崩溃外的悬挂。
   */
  async withLease<T>(
    personaId: string,
    purpose: PersonaLeasePurpose,
    now: number,
    ttlMs: number,
    fn: (handle: LeaseHandle) => Promise<T>,
  ): Promise<T | undefined> {
    const handle = this.acquire(personaId, purpose, now, ttlMs);
    if (!handle) return undefined;
    try {
      return await fn(handle);
    } finally {
      this.release(handle);
    }
  }
}
