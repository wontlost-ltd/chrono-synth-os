/**
 * 端侧人格运行时（ADR-0052 Local Persona Autonomy 第一步）— 在浏览器 Web Worker 里真的跑 kernel。
 *
 * 这是 Edge-P2（#102 在 Node test 证明 kernel 源码级可移植）的真实兑现：companion-web **首次真
 * runtime import `@chrono/kernel`**，在浏览器 worker 线程加载 kernel value-service 跑确定性人格
 * 状态闭环——证明「确定性人格内核能在非 Node 端侧 runtime 运行」（zero-LLM 论点的设备侧落地）。
 *
 * 证明的**精确边界**（Codex 复审）：真实 Worker runtime path 已构建（vite 产出 persona-worker
 * chunk = kernel 可 bundle 进浏览器 Worker）且代码走真 `new Worker(new URL)`；自动测试用 fake
 * worker（Node 可测协议+kernel 闭环）。**真浏览器 Worker E2E 执行**待 playwright 后续，本切片不宣称
 * 「CI 已证明浏览器端完整运行」。
 *
 * 本文件是**纯逻辑**（不碰 postMessage / Worker 全局），故可在 Node 直接单测；worker 边界在
 * persona-worker.ts。浏览器 host adapter（内存 UoW + 确定性 clock/random）零 node:*——可移植。
 */

import {
  createValue, updateValue, getAllValues,
  type CoreValue, type ValueId, type CreateValueParams, type UpdateValueParams,
  type SyncWriteUnitOfWork, type Query, type Command, type ExecResult, type KernelClock, type KernelRandom,
  VALUE_QUERY_BY_ID, VALUE_QUERY_ALL,
  VALUE_CMD_CREATE, VALUE_CMD_UPDATE, VALUE_CMD_DELETE, VALUE_CMD_DELETE_ALL, VALUE_CMD_UPSERT,
} from '@chrono/kernel';

/* ── 浏览器 worker host adapter（零 node:*，纯 ECMAScript）─────────────── */

/** 端侧确定性时钟（生产可换 Date.now；确定性供可复现）。 */
class DeterministicClock implements KernelClock {
  private current: number;
  constructor(startMs = 1_000, private readonly stepMs = 1_000) { this.current = startMs; }
  now(): number { const t = this.current; this.current += this.stepMs; return t; }
}

/** 端侧确定性随机（生产可换 crypto.randomUUID；确定性供可复现）。 */
class DeterministicRandom implements KernelRandom {
  private counter = 0;
  uuid(prefix?: string): string {
    const body = `web-${(this.counter++).toString(16).padStart(8, '0')}`;
    return prefix ? `${prefix}_${body}` : body;
  }
}

/** 浏览器内存 value UoW（语义对齐 src/edge Edge-P2：detached 读、CREATE 拒重复、排序 weight desc/id asc）。 */
class InMemoryValueUnitOfWork implements SyncWriteUnitOfWork {
  private readonly values = new Map<ValueId, CoreValue>();

  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): TResult | null {
    if (q.kind === VALUE_QUERY_BY_ID) {
      const { id } = q.params as { id: ValueId };
      const v = this.values.get(id);
      return (v ? { ...v } : null) as TResult | null;
    }
    throw new Error(`InMemoryValueUnitOfWork 不支持 query kind: ${q.kind}`);
  }

  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[] {
    if (q.kind === VALUE_QUERY_ALL) {
      const rows = [...this.values.values()].map((v) => ({ ...v }));
      rows.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
      return rows as unknown as readonly TResult[];
    }
    throw new Error(`InMemoryValueUnitOfWork 不支持 queryMany kind: ${q.kind}`);
  }

  execute<TParams>(cmd: Command<TParams>): ExecResult {
    switch (cmd.kind) {
      case VALUE_CMD_CREATE: {
        const p = cmd.params as CreateValueParams;
        if (this.values.has(p.id)) throw new Error(`core-value 主键冲突: ${p.id}`);
        this.values.set(p.id, toRow(p));
        return { rowsAffected: 1 };
      }
      case VALUE_CMD_UPSERT: {
        const p = cmd.params as CreateValueParams;
        this.values.set(p.id, toRow(p));
        return { rowsAffected: 1 };
      }
      case VALUE_CMD_UPDATE: {
        const p = cmd.params as UpdateValueParams;
        const e = this.values.get(p.id);
        if (!e) return { rowsAffected: 0 };
        if (p.patch.weight !== undefined) e.weight = p.patch.weight;
        if (p.patch.timeDiscount !== undefined) e.timeDiscount = p.patch.timeDiscount;
        if (p.patch.emotionAmplifier !== undefined) e.emotionAmplifier = p.patch.emotionAmplifier;
        e.updatedAt = p.updatedAt;
        return { rowsAffected: 1 };
      }
      case VALUE_CMD_DELETE: {
        const { id } = cmd.params as { id: ValueId };
        return { rowsAffected: this.values.delete(id) ? 1 : 0 };
      }
      case VALUE_CMD_DELETE_ALL:
        this.values.clear();
        return { rowsAffected: 0 };
      default:
        throw new Error(`InMemoryValueUnitOfWork 不支持 command kind: ${cmd.kind}`);
    }
  }

  transaction<T>(fn: () => T): T {
    const snap = new Map([...this.values].map(([k, v]) => [k, { ...v }]));
    try { return fn(); } catch (err) { this.values.clear(); for (const [k, v] of snap) this.values.set(k, v); throw err; }
  }
}

function toRow(p: CreateValueParams): CoreValue {
  return { id: p.id, label: p.label, weight: p.weight, timeDiscount: p.timeDiscount, emotionAmplifier: p.emotionAmplifier, updatedAt: p.updatedAt };
}

/* ── 端侧人格运行时（worker 逻辑，纯——无 postMessage）──────────────── */

/** worker 命令（主线程 → worker）。 */
export type PersonaCommand =
  | { readonly kind: 'addValue'; readonly label: string; readonly weight: number }
  | { readonly kind: 'updateValue'; readonly id: string; readonly weight: number }
  | { readonly kind: 'listValues' };

/** worker 结果（worker → 主线程）。 */
export interface PersonaResult {
  readonly values: readonly CoreValue[];
}

/**
 * 端侧人格运行时：用浏览器 host adapter 驱动真实 kernel value-service。
 * **运行时无 LLM、无云、无 node**——纯确定性核（zero-LLM 论点的端侧落地）。
 */
export class PersonaRuntime {
  private readonly tx = new InMemoryValueUnitOfWork();
  private readonly clock = new DeterministicClock();
  private readonly random = new DeterministicRandom();

  /** 处理一条命令（调真实 kernel value-service），返回当前全部价值。 */
  handle(cmd: PersonaCommand): PersonaResult {
    switch (cmd.kind) {
      case 'addValue':
        createValue(this.tx, this.clock, this.random, cmd.label, cmd.weight);
        break;
      case 'updateValue':
        updateValue(this.tx, this.clock, cmd.id, { weight: cmd.weight });
        break;
      case 'listValues':
        break;
    }
    return { values: [...getAllValues(this.tx).values()] };
  }
}
