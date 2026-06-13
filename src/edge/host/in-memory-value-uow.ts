/**
 * 端侧内存 UnitOfWork（ADR-0052 Edge-P2）— 非 Node runtime 的 reference 存储。
 *
 * 实现 kernel 的 `SyncWriteUnitOfWork`，把 core-value 域的 7 个 query/command kind 用一个纯 `Map`
 * 处理（**零 SQL、零 node:***），驱动 kernel 的 value-service 纯函数闭环。证明：kernel 领域逻辑
 * 能在「非 Node、非 SQLite」的端侧存储上确定性运行——可移植性从「架构承诺」变成「可跑的证明」。
 *
 * 范围：第一阶段只覆盖 core-value 一个闭环（backend 研究的 Native projection 路线：先证一个域，
 * 不复刻全部 executor）。后续 Phase（Edge-P3）做持久化 + 更多域。
 *
 * **语义对齐真实 executor**（Codex Edge-P2 复审）——本 reference adapter 会被端侧实现照抄，故必须与
 * src/storage/executors/value-executors.ts（SQL）+ packages/adapter-web（IndexedDB）语义一致：
 *   - 读接口返回 **detached 拷贝**（不暴露内部 live reference，调用方不能绕过 command 改存储）；
 *   - CREATE 对重复 id **抛错**（对齐 SQL INSERT 主键冲突）；UPSERT 才覆盖（ON CONFLICT DO UPDATE）；
 *   - DELETE_ALL 返回 rowsAffected=0（对齐 SQL executor）；
 *   - all() 排序 **weight desc, id asc**（对齐 adapter-web contract）。
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
        const v = this.values.get(id);
        /* detached 拷贝：不暴露 live reference（对齐 SQL/Web adapter 返回的 detached row）。 */
        return (v ? { ...v } : null) as TResult | null;
      }
      default:
        throw new Error(`InMemoryValueUnitOfWork 不支持 query kind: ${q.kind}`);
    }
  }

  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[] {
    switch (q.kind) {
      case VALUE_QUERY_ALL: {
        /* detached 拷贝 + 排序 weight desc, id asc（对齐 adapter-web contract）。 */
        const rows = [...this.values.values()].map((v) => ({ ...v }));
        rows.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
        return rows as unknown as readonly TResult[];
      }
      default:
        throw new Error(`InMemoryValueUnitOfWork 不支持 queryMany kind: ${q.kind}`);
    }
  }

  execute<TParams>(cmd: Command<TParams>): ExecResult {
    switch (cmd.kind) {
      case VALUE_CMD_CREATE: {
        const p = cmd.params as CreateValueParams;
        /* 对齐 SQL INSERT：重复主键抛错（不静默覆盖；覆盖语义是 UPSERT 的事）。 */
        if (this.values.has(p.id)) throw new Error(`core-value 主键冲突: ${p.id}`);
        this.values.set(p.id, toRow(p));
        return { rowsAffected: 1 };
      }
      case VALUE_CMD_UPSERT: {
        const p = cmd.params as CreateValueParams;
        /* 对齐 SQL ON CONFLICT DO UPDATE：存在则覆盖全字段，不存在则插入。 */
        this.values.set(p.id, toRow(p));
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
        this.values.clear();
        return { rowsAffected: 0 };   /* 对齐 SQL executor（DELETE_ALL 固定返回 0）。 */
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

  /** 当前状态的确定性指纹（golden replay 比对用）。按 id 排序，不依赖 Map 插入序。 */
  snapshotHash(): string {
    return [...this.values.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((v) => `${v.id}|${v.label}|${v.weight}|${v.timeDiscount}|${v.emotionAmplifier}|${v.updatedAt}`)
      .join('\n');
  }

  /**
   * 序列化为可落盘字符串（Edge-P3 持久化）。按 id 排序保证确定性序列化（同状态 → 同字符串）。
   */
  serialize(): string {
    const rows = [...this.values.values()].sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify(rows);
  }

  /**
   * 从序列化字符串重建（落盘后重载）。**原子**：先全部校验/构建到临时 Map，全部成功才替换
   * 当前状态——任一元素畸形则抛错且**不破坏现有状态**（Codex 复审：原实现先 clear 再逐条写，
   * 中途畸形会留半恢复状态）。
   */
  restore(serialized: string): void {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) throw new Error('InMemoryValueUnitOfWork.restore: 序列化数据必须是数组');
    const next = new Map<ValueId, CoreValue>();
    for (const raw of parsed) {
      if (!isValidValueRow(raw)) throw new Error('InMemoryValueUnitOfWork.restore: 含畸形价值行，已中止（状态未变）');
      next.set(raw.id, toRow(raw));
    }
    /* 全部校验通过才替换（原子）。 */
    this.values.clear();
    for (const [k, v] of next) this.values.set(k, v);
  }
}

/**
 * 校验一行价值数据的形状**与领域约束**（restore 原子性用）。复用 value-service 的区间约束
 * （weight/timeDiscount∈[0,1]、emotionAmplifier≥0），防坏落盘数据注入非法状态（如 weight:999）。
 */
function isValidValueRow(v: unknown): v is CoreValue {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0
    && typeof r.label === 'string'
    && isInUnit(r.weight)
    && isInUnit(r.timeDiscount)
    && typeof r.emotionAmplifier === 'number' && Number.isFinite(r.emotionAmplifier) && r.emotionAmplifier >= 0
    && typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt);
}

/** [0,1] 区间有限数。 */
function isInUnit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** CreateValueParams → CoreValue 行（统一构造，避免 create/upsert 重复）。 */
function toRow(p: CreateValueParams): CoreValue {
  return {
    id: p.id, label: p.label, weight: p.weight,
    timeDiscount: p.timeDiscount, emotionAmplifier: p.emotionAmplifier, updatedAt: p.updatedAt,
  };
}
