/**
 * 端侧内存 UnitOfWork（ADR-0052 Edge-P2）— 非 Node runtime 的 reference 存储。
 *
 * 实现 kernel 的 `SyncWriteUnitOfWork`，把 core-value 域的 7 个 query/command kind 用一个纯 `Map`
 * 处理（**零 SQL、零 node:***），驱动 kernel 的 value-service 纯函数闭环。证明：kernel 领域逻辑
 * 能在「非 Node、非 SQLite」的端侧存储上确定性运行——可移植性从「架构承诺」变成「可跑的证明」。
 *
 * 范围：第一阶段只覆盖 core-value 一个闭环（backend 研究的 Native projection 路线：先证一个域，
 * 不复刻全部 executor）。后续 Phase（Edge-P3）做持久化 + 更多域。
 */

import type {
  SyncWriteUnitOfWork, Query, Command, ExecResult,
  CoreValue, ValueId, CreateValueParams, UpdateValueParams,
} from '@chrono/kernel';
import {
  VALUE_QUERY_BY_ID, VALUE_QUERY_ALL,
  VALUE_CMD_CREATE, VALUE_CMD_UPDATE, VALUE_CMD_DELETE, VALUE_CMD_DELETE_ALL, VALUE_CMD_UPSERT,
} from '@chrono/kernel';

export class InMemoryValueUnitOfWork implements SyncWriteUnitOfWork {
  /** 价值表：id → CoreValue（插入序保留，复刻 SQL 表的稳定迭代序）。 */
  private readonly values = new Map<ValueId, CoreValue>();

  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): TResult | null {
    switch (q.kind) {
      case VALUE_QUERY_BY_ID: {
        const { id } = q.params as { id: ValueId };
        return (this.values.get(id) ?? null) as TResult | null;
      }
      default:
        throw new Error(`InMemoryValueUnitOfWork 不支持 query kind: ${q.kind}`);
    }
  }

  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[] {
    switch (q.kind) {
      case VALUE_QUERY_ALL:
        return [...this.values.values()] as unknown as readonly TResult[];
      default:
        throw new Error(`InMemoryValueUnitOfWork 不支持 queryMany kind: ${q.kind}`);
    }
  }

  execute<TParams>(cmd: Command<TParams>): ExecResult {
    switch (cmd.kind) {
      case VALUE_CMD_CREATE:
      case VALUE_CMD_UPSERT: {
        const p = cmd.params as CreateValueParams;
        this.values.set(p.id, {
          id: p.id, label: p.label, weight: p.weight,
          timeDiscount: p.timeDiscount, emotionAmplifier: p.emotionAmplifier, updatedAt: p.updatedAt,
        });
        return { rowsAffected: 1 };
      }
      case VALUE_CMD_UPDATE: {
        const p = cmd.params as UpdateValueParams;
        const existing = this.values.get(p.id);
        if (!existing) return { rowsAffected: 0 };
        /* 部分更新：只覆盖 patch 中存在的字段（与 SQL UPDATE ... SET 一致）。 */
        if (p.patch.weight !== undefined) existing.weight = p.patch.weight;
        if (p.patch.timeDiscount !== undefined) existing.timeDiscount = p.patch.timeDiscount;
        if (p.patch.emotionAmplifier !== undefined) existing.emotionAmplifier = p.patch.emotionAmplifier;
        existing.updatedAt = p.updatedAt;
        return { rowsAffected: 1 };
      }
      case VALUE_CMD_DELETE: {
        const { id } = cmd.params as { id: ValueId };
        return { rowsAffected: this.values.delete(id) ? 1 : 0 };
      }
      case VALUE_CMD_DELETE_ALL: {
        const n = this.values.size;
        this.values.clear();
        return { rowsAffected: n };
      }
      default:
        throw new Error(`InMemoryValueUnitOfWork 不支持 command kind: ${cmd.kind}`);
    }
  }

  /**
   * 端侧事务：内存实现用「快照 + 失败回滚」语义（异常时还原到进入前）。
   * 真实端侧 adapter（IndexedDB/Tauri）由各自实现决定事务边界（ADR-0001）。
   */
  transaction<T>(fn: () => T): T {
    const snapshot = new Map([...this.values].map(([k, v]) => [k, { ...v }]));
    try {
      return fn();
    } catch (err) {
      this.values.clear();
      for (const [k, v] of snapshot) this.values.set(k, v);
      throw err;
    }
  }

  /** 当前状态的确定性指纹（golden replay 比对用）。 */
  snapshotHash(): string {
    const ordered = [...this.values.values()].map((v) =>
      `${v.id}|${v.label}|${v.weight}|${v.timeDiscount}|${v.emotionAmplifier}|${v.updatedAt}`,
    );
    return ordered.join('\n');
  }
}
