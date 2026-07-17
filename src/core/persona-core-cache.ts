/**
 * per-persona 认知内核缓存（LRU + 可选 TTL + pin）。
 *
 * 背景：ChronoSynthOS.personaCores 原为无界 Map，长跑进程触达大量 persona 会单调增长直至 OOM。
 * 本类把它变成有界缓存：容量 LRU 兜底 OOM（主防线），可选 TTL 清长尾，pin 保护 'default'
 * （其被 this.core 长活引用，绝不能驱逐）。
 *
 * 安全前提：CoreRhythmLayer 是纯 write-through 视图（零脏内存态），故驱逐仅从缓存删除即可，
 * 无需 flush；重建后读回同一份 DB 态，零数据丢失。
 *
 * 确定性：时间经注入 Clock（clock.now()），不用 Date.now()——可测、符合可复现内核铁律。
 */

/** 缓存参数。max<=0=无上限（禁用容量驱逐）；ttlMs<=0=禁用 TTL。 */
export interface PersonaCoreCacheOptions {
  readonly max?: number;
  readonly ttlMs?: number;
}

/** 可观测指标。 */
export interface PersonaCoreCacheStats {
  readonly size: number;
  readonly max: number;
  readonly evictions: number;
  readonly pinned: number;
}

/** 单条目：值 + 最近访问时刻 + 是否 pin。 */
interface Entry<T> {
  value: T;
  lastAccessedAt: number;
  pinned: boolean;
}

const DEFAULT_MAX = 512;

export class PersonaCoreCache<T> {
  /* Map 保留插入序；LRU 通过"命中即 delete+set 移到末尾"维护，末尾=最近、头部=最久。 */
  private readonly entries = new Map<string, Entry<T>>();
  private readonly max: number;
  private readonly ttlMs: number;
  private evictions = 0;

  constructor(
    private readonly clock: { now(): number },
    options: PersonaCoreCacheOptions = {},
  ) {
    this.max = options.max ?? DEFAULT_MAX;
    this.ttlMs = options.ttlMs ?? 0;
  }

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    /* TTL：非 pin 项超期 → 删除并视为 miss。 */
    if (this.isExpired(e)) {
      this.entries.delete(key);
      return undefined;
    }
    /* LRU 提升：移到末尾 + 刷新访问时刻。 */
    e.lastAccessedAt = this.clock.now();
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: string, value: T): void {
    const existing = this.entries.get(key);
    const pinned = existing?.pinned ?? false;
    /* 覆盖写：先删旧位再插末尾，保证 LRU 末尾=最近。 */
    if (existing) this.entries.delete(key);
    this.entries.set(key, { value, lastAccessedAt: this.clock.now(), pinned });
    this.evictIfNeeded();
  }

  has(key: string): boolean {
    /* 纯探测：不改 LRU 顺序、不因 TTL 删除（可观测/幂等）。 */
    return this.entries.has(key);
  }

  pin(key: string): void {
    const e = this.entries.get(key);
    if (e) e.pinned = true;
  }

  keys(): string[] {
    return [...this.entries.keys()].sort();
  }

  stats(): PersonaCoreCacheStats {
    let pinned = 0;
    for (const e of this.entries.values()) if (e.pinned) pinned++;
    return { size: this.entries.size, max: this.max, evictions: this.evictions, pinned };
  }

  private isExpired(e: Entry<T>): boolean {
    if (this.ttlMs <= 0 || e.pinned) return false;
    return this.clock.now() - e.lastAccessedAt > this.ttlMs;
  }

  /** 超容量时驱逐最久未访问的**非 pin** 项（Map 头部往后找第一个非 pin）。 */
  private evictIfNeeded(): void {
    if (this.max <= 0) return;
    while (this.entries.size > this.max) {
      let victim: string | undefined;
      for (const [k, e] of this.entries) {
        if (!e.pinned) { victim = k; break; }   // Map 迭代=插入序=LRU 头部优先
      }
      if (victim === undefined) return;          // 全是 pin，无法再驱逐
      this.entries.delete(victim);
      this.evictions++;
    }
  }
}
