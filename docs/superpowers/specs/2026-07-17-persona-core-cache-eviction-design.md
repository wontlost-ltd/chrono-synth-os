# personaCores 缓存驱逐设计

**日期:** 2026-07-17
**范围:** `src/chrono-synth-os.ts`（`personaCores` map + `getCore`）
**关联:** ADR-0056（per-persona 认知内核隔离，红线5 缓存 persona-aware）、
上一轮规模评估（`personaCores` 无驱逐 → 长跑 pod 单调增长直至 OOM，是"规模化第 1 个先崩点"）

## 背景与问题

`ChronoSynthOS.personaCores`（`src/chrono-synth-os.ts:170`）是一个裸 `Map<string, CoreRhythmLayer>`，
由 `getCore(personaId)` 惰性建、**只增不删**（无 `.delete`、无容量上限、无 TTL）。任何触达大量
不同 persona 的长跑进程会单调增长，最终在 pod 内存上限（k8s 512Mi）被 OOM-kill。这是规模化评估
里"最先崩"的一层。

本设计给 `personaCores` 加**容量 LRU 驱逐 + 可选 TTL**，把无界 map 变成有界缓存，兜住 OOM，
同时不破坏 ADR-0056 红线5 与现有行为。

## 关键事实（读代码确认，非假设）

1. **`CoreRhythmLayer` 是纯 write-through 视图，零脏内存态。** 其 6 个 store
   （`ValueStore`/`CognitiveMemoryGraph`/`NarrativeStore`/`SurvivalAnchorStore`/`DecisionStyleStore`/
   `CognitiveModelStore`，见 `src/core/core-rhythm-layer.ts:28-56`）全部即读即写 SQL；
   `CognitiveMemoryGraph` 仅持有不可变 config/adapter 字段（`src/core/memory-graph.ts:42-60`），
   **无节点缓存、无 Map、无待刷新缓冲**。→ 驱逐一个 core **零数据丢失**；重建后读回同一份 DB 态。

2. **`getCore` 的长活引用只有 `'default'`。** 7 个调用方（`src/chrono-synth-os.ts:216,244,537,582`、
   `src/workforce/workforce-persona-bootstrap-service.ts:99`、`src/server/app.ts:686`）中，只有
   `this.core = this.getCore('default')`（`:216`）把结果存成长期字段。`ArtifactCompiler` 拿的是
   闭包 `(pid) => this.getCore(pid)`（`:244`），按需 re-resolve，不捕获实例。其余用完即弃。

3. **红线5（防串脑）** 禁的是"DB 按 (tenant,persona) 隔离了，但内存共享一个 core 实例而串脑"。
   本设计**只会重建实例**（同 personaId 任一时刻 map 内至多一个），共享的是按 persona 隔离的 DB，
   不引入跨 persona 共享实例，故不破红线。

## 设计决策

| 决策点 | 选择 |
| --- | --- |
| 数据结构 | 裸 `Map` → 内部小型 LRU（保留插入/访问顺序，超容量驱逐最久未访问项） |
| 默认容量 `maxPersonaCores` | **512**（宽松：单租户典型人格数远低于此，日常不触发驱逐=零回归；异常多人格时兑现防 OOM） |
| TTL `personaCoreTtlMs` | **可选，默认 0=禁用**（LRU 为主防线；TTL 清长尾，默认关=零回归） |
| `'default'` | **永久 pin**：不计入 LRU 容量、永不被驱逐、永不 TTL 过期（保护 `this.core` 长活引用） |
| 驱逐动作 | 从 map 删除即可（write-through 无脏态，无需 flush/close） |
| 配置入口 | `ChronoSynthOSConfig.personaCoreCache?: { max?: number; ttlMs?: number }` + env `CHRONO_PERSONA_CORE_CACHE_MAX` / `CHRONO_PERSONA_CORE_CACHE_TTL_MS`（遵循既有 config 风格） |
| 可观测 | 保留 `listPersonaCores()`；新增 `personaCoreCacheStats(): { size; max; evictions; pinned }` |

## 组件与数据流

- **`PersonaCoreCache`（新，`src/core/persona-core-cache.ts`）** —— 一个聚焦单一职责的小类：
  - `get(personaId): CoreRhythmLayer | undefined` —— 命中则记为最近访问（LRU 提升）；TTL 启用时
    命中但已过期 → 视为 miss 并删除。
  - `set(personaId, core)` —— 写入；若 `size > max` 驱逐最久未访问的**非 pin** 项。
  - `pin(personaId)` —— 标记永不驱逐/永不过期（用于 `'default'`）。
  - `keys()` / `stats()` —— 可观测。
  - 时间经注入的 `Clock`（复用 `os.clock`），保持确定性/可测（不用 `Date.now()`）。
  - 纯内存、零 DB 依赖、零 LLM。

- **`ChronoSynthOS` 改动** ——
  - `personaCores` 由 `Map` 换成 `PersonaCoreCache`（构造时读 config/env 得 max/ttl）。
  - `getCore(personaId)`：`cache.get` → miss 则 `new CoreRhythmLayer(...)` + `cache.set`。逻辑等价，
    只是底层容器换成有界缓存。
  - `this.core = this.getCore('default')` 之后 `cache.pin('default')`（保证 default 永不被驱逐）。
  - `listPersonaCores()` 委托 `cache.keys()`；新增 `personaCoreCacheStats()` 委托 `cache.stats()`。

数据流不变：`getCore` 仍是"寻址/加载"，业务状态仍在 DB，事件仍经 bus。唯一变化是内存中 core 实例
的**生命周期**从"永驻"变为"有界 LRU（default 除外）"。

## 不变量（测试必须覆盖）

1. **零回归**：容量足够大（未超 max）时，行为与现状完全一致（不驱逐、同 personaId 返回同实例）。
2. **`'default'` 永不被驱逐**：塞满 > max 个其它 persona 后，`getCore('default')` 仍返回被 pin 的活实例，
   且 `this.core === getCore('default')`。
3. **驱逐后重取数据一致**：`getCore(p)` 写价值/记忆 → 触发 p 被 LRU 驱逐 → 再 `getCore(p)` 读回，
   DB 态一致（证明 write-through 下驱逐零数据丢失）。
4. **LRU 顺序正确**：最近访问的不被驱逐；最久未访问的先走；`get` 会刷新访问顺序。
5. **TTL（启用时）**：超过 ttlMs 未访问的**非 pin** 项，下次 `get` 视为过期 miss；default 不受 TTL 影响。
6. **红线5**：同一 personaId 任一时刻 **cache 内**至多一个实例（驱逐→重建不产生并存的两个 map 条目）。
   注：一个瞬时调用方可能在其 core 被驱逐后仍持旧引用，而新 `getCore` 建了新实例——两实例短暂并存于
   map 之外。这是**良性**的：write-through 下二者读写同一份（按 persona 隔离的）DB 行，无 RAM 态分叉，
   不构成红线5 的"共享实例串脑"（那指的是**跨 persona** 共享一个实例）。

## 明确不做（YAGNI）

- 不动 `TenantOSFactory` 的租户级 LRU（另一个规模化缺口，本次不涉及）。
- 不引入回写缓冲/延迟刷新（write-through 已无脏态，加缓冲反增风险）。
- 不做跨进程/分布式驱逐（单实例内的事）。
- 不改 `createShadowCore`（本就不进 personaCores，`src/chrono-synth-os.ts:458`）。

## 本地验证（遵循强制本地验证）

- **单测** `src/test/unit/persona-core-cache.test.ts`：覆盖上述 6 条不变量，用小容量（max=2）+ 注入
  假 Clock 驱动 LRU/TTL；对 `ChronoSynthOS` 层用内存 SQLite 验证不变量 2/3。
- **typecheck**：`npm run typecheck`（若触类型）。
- **回归**：跑 core/chrono-synth 相关既有单测证明零回归。
- 失败即止，不带缺陷交付。

## 风险

- **低**。核心风险点（驱逐丢数据、串脑、悬垂引用）均被"write-through + pin default + 单实例重建"消解，
  已逐条对代码确认。剩余唯一注意点是 `'default'` 的 pin 必须在 `getCore('default')` 建实例后立即生效——
  由构造顺序保证（先 `this.core = getCore('default')` 再 `pin`）。
