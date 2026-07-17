# personaCores 缓存驱逐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ChronoSynthOS.personaCores` 无界 `Map` 换成有界的 LRU（默认 512）+ 可选 TTL（默认关）缓存，永久 pin `'default'`，兜住长跑进程 OOM，且零数据丢失、零行为回归。

**Architecture:** 新增聚焦单一职责的 `PersonaCoreCache`（纯内存、注入 Clock、零 DB/LLM 依赖）；`ChronoSynthOS` 内把裸 map 换成它，`getCore` 逻辑等价（miss 建实例、命中提升 LRU），构造 `'default'` 后 `pin`。因 `CoreRhythmLayer` 是纯 write-through 视图（零脏内存态），驱逐仅从缓存删除、无需 flush。

**Tech Stack:** TypeScript (ESM, `.js` 导入后缀)，`node:test` + `node:assert/strict`，内存 SQLite（`createMemoryDatabase` + `runDslSqliteMigrations`），注入式 `Clock`（`src/utils/clock.js`）。

## Global Constraints

- 注释/文档用简体中文（描述意图/约束/用法），遵循既有风格。
- 内核可复现铁律：**不用 `Date.now()`/`Math.random()`**，时间经注入 `Clock`（`clock.now()`）。
- ESM：所有相对导入带 `.js` 后缀。
- ADR-0056 红线5：缓存 persona-aware，同一 personaId 任一时刻缓存内至多一个实例。
- `'default'` 永不被驱逐/过期（保护 `this.core` 长活引用，`src/chrono-synth-os.ts:216`）。
- 零回归：容量未超上限时行为与现状完全一致。
- 本地验证强制：改动须能本地跑通 `npm run typecheck` + 相关单测；失败即止。

---

### Task 1: `PersonaCoreCache` 核心类（LRU + pin + 可选 TTL）

**Files:**
- Create: `src/core/persona-core-cache.ts`
- Test: `src/test/unit/persona-core-cache.test.ts`

**Interfaces:**
- Consumes: `Clock`（`{ now(): number }`）来自 `src/utils/clock.js`。
- Produces:
  ```ts
  export interface PersonaCoreCacheOptions { max?: number; ttlMs?: number }
  export interface PersonaCoreCacheStats { size: number; max: number; evictions: number; pinned: number }
  export class PersonaCoreCache<T> {
    constructor(clock: { now(): number }, options?: PersonaCoreCacheOptions);
    get(key: string): T | undefined;         // 命中提升为最近；TTL 启用且过期 → 删除并返回 undefined
    set(key: string, value: T): void;        // 写入；size 超 max 时驱逐最久未访问的非 pin 项
    has(key: string): boolean;               // 不影响 LRU 顺序、不触发 TTL 删除（纯探测）
    pin(key: string): void;                  // 标记该 key 永不驱逐/过期
    keys(): string[];                        // 已排序，供可观测
    stats(): PersonaCoreCacheStats;
  }
  ```
  语义：`max <= 0` 视为无上限（禁用容量驱逐）；`ttlMs <= 0` 视为禁用 TTL。`'default'` 的 pin 由调用方（Task 2）负责，本类只提供 `pin`。

- [ ] **Step 1: 写失败测试**

创建 `src/test/unit/persona-core-cache.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaCoreCache } from '../../core/persona-core-cache.js';

/** 注入式假时钟：可手动推进，验证 TTL 而不依赖真实时间（可复现）。 */
function fakeClock(start = 1_000): { now(): number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('PersonaCoreCache（personaCores 驱逐）', () => {
  it('未超容量时不驱逐，返回同一实例（零回归）', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 4 });
    c.set('a', 'A'); c.set('b', 'B');
    assert.equal(c.get('a'), 'A');
    assert.equal(c.get('b'), 'B');
    assert.equal(c.stats().size, 2);
    assert.equal(c.stats().evictions, 0);
  });

  it('超容量驱逐最久未访问项（LRU 顺序）', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 2 });
    c.set('a', 'A'); c.set('b', 'B');
    c.get('a');            // a 变最近 → b 最久未访问
    c.set('c', 'C');       // 触发驱逐 → 应逐 b
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('a'), 'A');
    assert.equal(c.get('c'), 'C');
    assert.equal(c.stats().evictions, 1);
  });

  it('pin 的 key 永不被容量驱逐', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 2 });
    c.set('default', 'D'); c.pin('default');
    c.set('a', 'A');
    c.set('b', 'B');       // 已有 default(pin)+a → 加 b 触发驱逐，只能逐 a（default 免疫）
    c.set('c', 'C');       // 再逐 b
    assert.equal(c.get('default'), 'D');   // pin 项恒在
    assert.equal(c.stats().pinned, 1);
  });

  it('TTL 启用时，过期的非 pin 项在下次 get 视为 miss；pin 项不过期', () => {
    const clk = fakeClock();
    const c = new PersonaCoreCache<string>(clk, { max: 10, ttlMs: 100 });
    c.set('default', 'D'); c.pin('default');
    c.set('a', 'A');
    clk.advance(50);
    assert.equal(c.get('a'), 'A');         // 未过期
    clk.advance(101);                      // a 上次访问后 > 100ms
    assert.equal(c.get('a'), undefined);   // 过期 miss
    assert.equal(c.get('default'), 'D');   // pin 不过期
  });

  it('max<=0 表示无上限（禁用容量驱逐）', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 0 });
    for (let i = 0; i < 100; i++) c.set(`k${i}`, `v${i}`);
    assert.equal(c.stats().size, 100);
    assert.equal(c.stats().evictions, 0);
  });

  it('has 探测不影响 LRU 顺序、不触发 TTL 删除', () => {
    const clk = fakeClock();
    const c = new PersonaCoreCache<string>(clk, { max: 2, ttlMs: 100 });
    c.set('a', 'A'); c.set('b', 'B');
    clk.advance(200);
    assert.equal(c.has('a'), true);        // 探测：即便逻辑过期，has 仍报告存在（不删）
    assert.equal(c.stats().size, 2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/persona-core-cache.test.js`
Expected: FAIL —— 模块 `../../core/persona-core-cache.js` 不存在 / 编译期报 `PersonaCoreCache` 未定义。

- [ ] **Step 3: 写最小实现**

创建 `src/core/persona-core-cache.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/persona-core-cache.test.js`
Expected: PASS —— 6 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/persona-core-cache.ts src/test/unit/persona-core-cache.test.js src/test/unit/persona-core-cache.test.ts 2>/dev/null
git add src/core/persona-core-cache.ts src/test/unit/persona-core-cache.test.ts
git commit -m "$(printf 'feat(core): PersonaCoreCache——LRU + 可选 TTL + pin\n\npersonaCores 驱逐的核心容器：容量 LRU 兜底 OOM，可选 TTL 清长尾，\npin 保护 default。纯内存、注入 Clock、零 DB/LLM 依赖。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: 接入 `ChronoSynthOS`（map → cache，pin default，可观测）

**Files:**
- Modify: `src/chrono-synth-os.ts`（第 170 行 `personaCores` 字段、第 216 行 `this.core=getCore('default')`、第 438-446 行 `getCore`、第 449-451 行 `listPersonaCores`、`ChronoSynthOSConfig` 接口第 71 行起）
- Test: `src/test/unit/persona-core-cache-integration.test.ts`

**Interfaces:**
- Consumes: `PersonaCoreCache`（Task 1）、`CoreRhythmLayer`（既有）。
- Produces:
  - `ChronoSynthOSConfig.personaCoreCache?: { max?: number; ttlMs?: number }`
  - `ChronoSynthOS.personaCoreCacheStats(): PersonaCoreCacheStats`
  - `getCore` / `listPersonaCores` 行为对外不变（签名不变）。

- [ ] **Step 1: 写失败测试**

创建 `src/test/unit/persona-core-cache-integration.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';

/* 用小容量 personaCoreCache 驱动 ChronoSynthOS 层的驱逐不变量。 */
describe('ChronoSynthOS personaCores 驱逐接入', () => {
  it("'default' 永不被驱逐，this.core 恒等于 getCore('default')", () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 2 } });
    const defaultCore = os.getCore('default');
    assert.equal(os.core, defaultCore);
    /* 塞入多个 persona 触发驱逐（max=2，default 被 pin 不占额度） */
    for (let i = 0; i < 5; i++) os.getCore(`p${i}`);
    /* default 仍是同一活实例 */
    assert.equal(os.getCore('default'), defaultCore);
    assert.equal(os.core, defaultCore);
    os.close();
  });

  it('驱逐后重取，DB 态一致（write-through 零数据丢失）', () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 1 } });
    /* 给 p1 写一条价值 */
    const p1 = os.getCore('p1');
    p1.addValue('诚信', 0.9);
    /* 访问其它 persona 把 p1 挤出缓存（max=1，default 已 pin 占 map 但不占驱逐额度→p1 会被逐） */
    os.getCore('p2');
    os.getCore('p3');
    /* 重新取 p1（重建实例），读回 DB 态 */
    const p1again = os.getCore('p1');
    const values = [...p1again.values.getAll().values()];
    assert.equal(values.some((v) => v.label === '诚信'), true);
    os.close();
  });

  it('容量足够时零回归：同 personaId 返回同实例', () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 512 } });
    const a1 = os.getCore('a');
    const a2 = os.getCore('a');
    assert.equal(a1, a2);
    os.close();
  });

  it('personaCoreCacheStats 可观测', () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 2 } });
    os.getCore('x'); os.getCore('y'); os.getCore('z');
    const s = os.personaCoreCacheStats();
    assert.ok(s.evictions >= 1);
    assert.ok(s.pinned >= 1);   // default 被 pin
    os.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/persona-core-cache-integration.test.js`
Expected: FAIL —— `personaCoreCache` 配置不被接受 / `personaCoreCacheStats` 未定义 / max=2 时 default 被误逐。

- [ ] **Step 3: 改 `ChronoSynthOS`**

3a. 在 imports 区（`src/chrono-synth-os.ts:11` 附近）加：

```ts
import { PersonaCoreCache, type PersonaCoreCacheStats } from './core/persona-core-cache.js';
```

3b. 在 `ChronoSynthOSConfig` 接口（第 71 行起）里，`cognitionConfig?` 附近加字段：

```ts
  /** per-persona 认知内核缓存（防 OOM）：max=容量上限（默认 512，<=0 无上限），ttlMs=可选 TTL（默认 0=关）。
   * 缺省 → 默认 512 容量、无 TTL（宽松：日常不驱逐=零回归，仅异常多人格时兜底）。 */
  personaCoreCache?: { max?: number; ttlMs?: number };
```

3c. 把第 170 行的字段声明：

```ts
  private readonly personaCores = new Map<string, CoreRhythmLayer>();
```

改为：

```ts
  private readonly personaCores: PersonaCoreCache<CoreRhythmLayer>;
```

3d. 在构造函数体内、**第 216 行 `this.core = this.getCore('default')` 之前**，初始化缓存（此时 `this.clock` 已在 `:181` 赋值）。在 `this.core = this.getCore('default');` 上一行插入：

```ts
    this.personaCores = new PersonaCoreCache<CoreRhythmLayer>(this.clock, config.personaCoreCache);
```

3e. 把第 216 行：

```ts
    this.core = this.getCore('default');
```

改为（建实例后立即 pin，保护 this.core 长活引用）：

```ts
    this.core = this.getCore('default');
    this.personaCores.pin('default');
```

3f. 把 `getCore`（第 438-446 行）改为用缓存 API（逻辑等价）：

```ts
  getCore(personaId = 'default'): CoreRhythmLayer {
    const cached = this.personaCores.get(personaId);
    if (cached) return cached;
    const core = new CoreRhythmLayer(
      this.db, this.bus, this.clock, this.logger, this.cognitionConfig, this.encryption, this.tenantId, personaId,
    );
    this.personaCores.set(personaId, core);
    return core;
  }
```

（注：`this.personaCores.get/set` 与旧 `Map.get/set` 同名同签名，函数体几乎不变，仅底层容器换成 `PersonaCoreCache`。）

3g. 把 `listPersonaCores`（第 449-451 行）改为委托缓存（`keys()` 已排序）：

```ts
  /** 已实例化(缓存)的 persona core 身份列表（可观测；不含未被 getCore 触达或已被驱逐的 persona）。 */
  listPersonaCores(): readonly string[] {
    return this.personaCores.keys();
  }
```

3h. 在 `listPersonaCores` 之后加可观测方法：

```ts
  /** per-persona 内核缓存指标（size/max/evictions/pinned），供内存监控。 */
  personaCoreCacheStats(): PersonaCoreCacheStats {
    return this.personaCores.stats();
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/persona-core-cache-integration.test.js`
Expected: PASS —— 4 个测试全绿。

- [ ] **Step 5: typecheck + 相关回归**

Run:
```bash
npm run typecheck
node --test --test-force-exit dist/test/unit/persona-core-cache.test.js dist/test/unit/persona-core-cache-integration.test.js
```
Expected: typecheck 无错；两个测试文件全绿。

- [ ] **Step 6: 提交**

```bash
git add src/chrono-synth-os.ts src/test/unit/persona-core-cache-integration.test.ts
git commit -m "$(printf 'feat(core): personaCores 接入 PersonaCoreCache（pin default + 可观测）\n\n无界 map → 有界 LRU 缓存；default 建实例后立即 pin（保护 this.core\n长活引用）；getCore 逻辑等价；新增 personaCoreCacheStats。CoreRhythmLayer\nwrite-through → 驱逐零数据丢失。关闭规模化评估的第 1 个 OOM 缺口。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: env 旋钮接入（两个主入口）+ 全量验证

**Files:**
- Modify: `src/main.ts:25`（`new ChronoSynthOS({...})` 处）
- Modify: `src/main-desktop.ts:50`（同）
- Modify: `.env.example`（补文档）

**Interfaces:**
- Consumes: `ChronoSynthOSConfig.personaCoreCache`（Task 2）。
- Produces: env `CHRONO_PERSONA_CORE_CACHE_MAX` / `CHRONO_PERSONA_CORE_CACHE_TTL_MS` → 运行时配置。

说明：`tenant-os-factory.ts:112` 的构造走多租户路径，本轮不改（保持默认 512，符合 spec YAGNI——租户级调优是后续）。仅在两个进程主入口暴露 env，覆盖单实例/桌面部署。

- [ ] **Step 1: 改 `src/main.ts`**

在 `const os = new ChronoSynthOS({` 的配置对象里加一行（读 env，缺省走 config 默认）：

```ts
  personaCoreCache: {
    max: process.env.CHRONO_PERSONA_CORE_CACHE_MAX ? Number(process.env.CHRONO_PERSONA_CORE_CACHE_MAX) : undefined,
    ttlMs: process.env.CHRONO_PERSONA_CORE_CACHE_TTL_MS ? Number(process.env.CHRONO_PERSONA_CORE_CACHE_TTL_MS) : undefined,
  },
```

- [ ] **Step 2: 改 `src/main-desktop.ts`**

在其 `new ChronoSynthOS({` 配置对象里加同样一行（内容与 Step 1 一致）。

- [ ] **Step 3: 补 `.env.example`**

在文件末尾追加：

```
# per-persona 认知内核缓存（防 OOM）。缺省 max=512、无 TTL。
# CHRONO_PERSONA_CORE_CACHE_MAX=512
# CHRONO_PERSONA_CORE_CACHE_TTL_MS=0
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: 全量相关验证**

Run:
```bash
npm run build
node --test --test-force-exit dist/test/unit/persona-core-cache.test.js dist/test/unit/persona-core-cache-integration.test.js
```
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/main.ts src/main-desktop.ts .env.example
git commit -m "$(printf 'feat(core): personaCoreCache env 旋钮（main + desktop 入口）\n\nCHRONO_PERSONA_CORE_CACHE_MAX / _TTL_MS 暴露给单实例与桌面部署；\n多租户工厂路径保持默认（后续调优）。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**1. Spec coverage:**
- spec「LRU + 可选 TTL + pin default，默认 512」→ Task 1（类）+ Task 2（接入 pin）+ Task 3（env）。✓
- spec 6 条不变量 → Task 1 覆盖 1/4/5/6（纯类层），Task 2 覆盖 2/3（OS 层 default 免驱逐 + 驱逐后数据一致）。✓
- spec「驱逐仅删除、无需 flush」→ Task 1 实现无 flush 钩子（write-through 前提已在 spec 论证）。✓
- spec「可观测 `personaCoreCacheStats`」→ Task 2 Step 3h。✓
- spec「YAGNI：不动 TenantOSFactory / 不加回写缓冲 / 不改 createShadowCore」→ 三个 Task 均未触及，Task 3 明确保留租户工厂默认。✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步给了完整代码；命令给了 expected。✓

**3. Type consistency:** `PersonaCoreCache` 构造签名 `(clock, options?)`、`get/set/has/pin/keys/stats` 在 Task 1 定义，Task 2 一致使用；`PersonaCoreCacheStats` 字段 `{size,max,evictions,pinned}` 在 Task 1 定义、Task 2 `personaCoreCacheStats()` 返回同型；`personaCoreCache?: {max?,ttlMs?}` 配置名在 Task 2/3 一致。✓

**注意点（实现者留意）:** Task 2 Step 3d 依赖 `this.clock` 已在构造函数早于第 216 行赋值（`src/chrono-synth-os.ts:181`）——若实际行号漂移，以「`this.clock` 赋值之后、`this.core=getCore('default')` 之前」为准插入缓存初始化。
