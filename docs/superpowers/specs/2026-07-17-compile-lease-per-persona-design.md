# 编译锁去全局化设计（compile lease: 租户全局 → per-persona）

**日期:** 2026-07-17
**范围:** `src/intelligence/distillation-service.ts`、`src/intelligence/shadow-exam-verifier.ts`
**关联:** ADR-0047（LLM-as-teacher 蒸馏管线 + 多实例 gating）、ADR-0056（per-persona 认知核心隔离，K5b 全维度收口）、ADR-0057（影子验收，红线13 compile lease）
**规模化缺口:** #4 —— 编译锁租户级全局串行，是大租户「保持所有 persona 内核新鲜」的吞吐瓶颈；也是 #3 分片的前置（分片后每 shard 内部仍会被大租户全局锁卡住，吃掉分片的并行收益）

## 背景与问题

数字人的「成长」经蒸馏管线落地：候选工件 → 门控 → **编译进认知内核**。编译临界区（快照 → 编译 → 状态推进 → 补偿）受一把 **compile 锁**保护，防并发编译互相踩状态。

当前这把锁是**租户级全局**的：`distillation-service.ts:294` 与 `shadow-exam-verifier.ts:98` 都用固定 key `GLOBAL_LEASE_PERSONA_ID='__global__'` 抢 `(tenant, '__global__', 'compile')` 一把锁。后果：**同一租户内所有 persona 的编译串行化**。一个有百万 persona 的大租户，编译吞吐上限 ≈ `1/编译临界区耗时`（全租户共享），远不足以让所有 persona 的内核保持编译新鲜。

## 核心论证：全局锁的理由已失效（逐条对代码核实）

`distillation-service.ts:280-283` 注释称锁必须全局，因为 `value_shift`/`memory_edge` 底层 `ValueStore`/`CognitiveMemoryGraph` 仍 tenant 共享（「**K5b 前**」）。**此注释陈旧——K5b 已交付，理由不再成立。** 核实结果：

| 编译目标 | 写入表 / 路径 | 隔离状态（已核实） |
| --- | --- | --- |
| value_shift | `core_values ... WHERE id=? AND persona_id=?`（`value-executors.ts:71`） | ✅ per-persona |
| memory_edge | `core.linkMemories → CognitiveMemoryGraph.addEdge(...,personaId) → kernel addEdge → **memory_edges**（`memory-executors.ts:238-239`，非 persona_memory_edges）`；读/写/删均 `WHERE persona_id=?`（`memory-executors.ts:217,238,246`） | ✅ per-persona（隔离成立，见下「已知风险」冲突键弱守卫） |
| narrative / decision_style / cognitive_model patch | 人格特征三件套（K2 executor） | ✅ per-persona |
| response_template | `response_templates (…, persona_id, …)` 对象级追加版本 | ✅ per-persona |
| rule | 专用规则表，per-persona | ✅ per-persona |
| **快照 / 回滚** | `snapshotGuard.snapshot(personaId)` + rollback `coreSelfOnly`（不恢复租户级状态）（`distillation-service.ts:281,329`） | ✅ per-persona |

ADR-0056 头部佐证：「K0-K6 + K5b 全部已交付，认知核心**全 7 维** per-persona 隔离，均已合入 main」（文档漂移校正 2026-07-04）。`memory-executors.ts:100` 亦标「K5b：memory_nodes / memory_edges 按 persona_id 显式隔离」。

**结论：编译临界区触碰的全部状态（7 维内核 + 快照 + 回滚）均已 per-persona 隔离。不同 persona 的并发编译不会互相踩状态。全局锁的唯一理由（共享价值/记忆存储）已消失。**

> ⚠️ 此论证是本设计的**安全根基**。若判读有偏差（某写路径实际仍 tenant 共享），并发编译会污染同 persona 或跨 persona 状态。故实现**必须先落一个并发隔离测试作安全网**（见「不变量 1」），用测试证明隔离真成立，再收窄锁——即使论证有误，测试会挡住。

### 已知风险（Codex 交叉审查补，实施前须处理）

`memory_edges` 的 upsert 冲突键是 `ON CONFLICT(source, target)`（`memory-executors.ts:239`），**无 tenant/persona guard**——而并行表 `persona_memory_edges` 有（`cognitive-memory-executors.ts:187-198`）。因 memory id 是全局随机 UUID，跨 persona 撞同一 `(source,target)` 概率极低，**不是本次锁收窄的直接阻断点**，但它削弱「memory_edge 全隔离」的强度：理论上两 persona 恰好引用同一对 memory id 时，后写者会覆盖前者的 persona_id。缓解：不变量 1 的跨 persona memory_edge 隔离测试须覆盖此边界；实施时评估是否顺带给 `memory_edges` upsert 补 persona guard（对齐 `persona_memory_edges`），或至少补一条同类守卫测试（本 spec 列为「实施时评估」，非强制前置——见「明确不做」的边界）。

## 设计决策

| 决策 | 选择 |
| --- | --- |
| 锁粒度 | `GLOBAL_LEASE_PERSONA_ID` → 真实 `personaId`。`acquire(personaId, 'compile', now, ttl)` 的首参从 `'__global__'` 改为传入的 `personaId` |
| 两处一起改 | `distillation-service.ts:294` + `shadow-exam-verifier.ts:98`，**同一 persona** 的正式编译与影子编译仍互斥（抢同一把 `(tenant, personaId, 'compile')` 锁）；**不同 persona** 之间并行 |
| schema | 无变更。lease 表 `v081` 已是 `(tenant_id, persona_id, purpose)` 唯一键；per-persona 只是传真 personaId 而非 `'__global__'` |
| TTL | 不变（两处均 60_000ms；临界区同步执行 ≪ TTL，安全裕度不变） |
| 未注入 leaseStore | 单进程同步语义不变（`if (!leaseStore) compileApprovedLocked(...)`），零回归 |
| `lease_busy` 语义 | 不变（拿不到锁 → 返回 `lease_busy` 待重试）。收窄后 `lease_busy` **只可能因同 persona 的并发编译触发**，跨 persona 不再互相 busy |

## 组件与数据流（改动面）

### 改动 1：正式编译锁收窄

`src/intelligence/distillation-service.ts:293-295`
- 现状：`acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', now, COMPILE_LEASE_TTL_MS)`
- 改为：`acquire(personaId, 'compile', now, COMPILE_LEASE_TTL_MS)`（`personaId` 是 `compileApproved` 已有的入参）
- 日志/注释同步更新（去掉「全租户编译竞争同一把锁」的陈述，改为「同 persona 编译互斥」）。
- `compileApprovedLocked` 内锁内预算复核（`checkBudget`）不变——预算本就 per-persona（`unverifiedGrowthBudgetExceeded(personaId)`），收窄锁不影响其正确性。

### 改动 2：影子验收编译锁收窄

`src/intelligence/shadow-exam-verifier.ts:98`
- 现状：`acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', now, SHADOW_COMPILE_LEASE_TTL_MS)`
- 改为：`acquire(personaId, 'compile', now, SHADOW_COMPILE_LEASE_TTL_MS)`（该函数已知 `personaId`）
- 红线13（影子编译期间持 compile 锁，与正式编译/另一影子互斥）**在 per-persona 层面仍成立**：同 persona 的影子核编译与正式编译抢同一把锁，互斥；不同 persona 无需互斥（影子核 `createShadowCore` 用独立 EventBus + 独立 persona 状态）。

### 数据流不变

编译仍是「抢锁 → 快照(personaId) → 编译落该 persona 内核 → 状态推进 → 释放」。唯一变化：锁 key 从租户级单例变为 per-persona，使不同 persona 的编译临界区可并发执行。

## 不变量（测试必须覆盖）

1. **【安全网·最先写】跨 persona 编译互不污染（value_shift + memory_edge 两类都测）**：同租户两个 persona A/B，各有一个 value_shift 候选**和**一个 memory_edge 候选，依次编译，断言 A 的价值权重/记忆边只变 A、B 只变 B，读回互不串（证明底层 `core_values` + `memory_edges` 隔离真成立）。「并发」用**注入 leaseStore + 手动交错持锁**模拟（Node 单线程，非真多线程）：先让 A 持锁，此时对 B 发起编译应成功（拿到 B 自己的锁），再验两者落到各自 core。（此测试证明 per-persona 锁安全的前提——隔离真成立——先于收窄锁落地。）
   1b. **memory_edges 冲突键边界（Codex 补）**：两 persona 恰好引用同一对 `(source,target)` memory id 时，验证后写者不覆盖前者的 persona_id 归属（若现状 `ON CONFLICT(source,target)` 无 persona guard 导致覆盖，此测试会红 → 实施时决定补 guard 或接受该极低概率边界并文档标注）。
2. **同 persona 编译互斥**：同一 persona 的两次并发 compile，第二次拿不到锁 → `lease_busy`（正式 vs 影子亦然：同 persona 影子编译持锁时，正式编译 `lease_busy`）。
3. **跨 persona 不再互相 busy**：persona A 持锁编译时，persona B 的编译**能拿到锁**（不再 `lease_busy`）——这是本改动的**收益证明**（修复前 B 会被 A 的全局锁挡成 `lease_busy`）。
4. **单进程语义零回归**：未注入 leaseStore 时，行为与现状完全一致（同步 `compileApprovedLocked`，无锁交互）。
5. **快照/回滚仍 per-persona**：编译失败触发回滚，只恢复该 persona 的 core，不碰其它 persona/租户级状态（沿用现状 `coreSelfOnly`，收窄锁不改回滚）。
6. **预算复核正确**：锁内 `checkBudget` 的不确定性预算判定仍按 persona 正确（收窄锁后，COUNT 仍是该 persona 的权威计数）。

## 明确不做（YAGNI）

- 不动 `earning` lease（本就 per-persona，`persona-earning-service.ts`）。
- 不改 lease 表 schema（`v081` 已支持 per-persona 键）。
- 不改快照/回滚机制（已 per-persona，本改动只收窄锁 key）。
- 不做 #3 分片（独立子项目，本 spec 之后单独走）。
- 不清理 `GLOBAL_LEASE_PERSONA_ID` 常量（可能仍有其它/未来用途；仅停止在这两处用它）。
- 不修「动态成长预算 resolver 仍读 default core」（`chrono-synth-os.ts:282-295`，Codex 指出）——这是**既有设计债**，不破坏本次锁安全（预算 COUNT 仍按 persona 权威），不归入本 spec 范围；仅在此标注，避免 spec 宣称「预算输入完全 per-persona」的过度表述。

## 本地验证

- **单测** `src/test/unit/`：覆盖上述不变量（1 + 1b + 2-6），用内存 SQLite + 注入 `PersonaLeaseStore`（真 CAS 语义）+ 手动交错验证并发。
- **文档注释同步**（Codex 改进4）：实施时一并更新陈旧注释——`artifact-compiler.ts:79-82`（「executor 未扩」已过时）、`distillation-service.ts:280-283`（「K5b 前共享」已过时）、`shadow-exam-verifier.ts` compile 锁注释、`persona-lease-types.ts` 全局锁说明，改为反映 per-persona 现状。
- `npm run typecheck` + `npm run build` + 相关既有蒸馏/影子验收测试回归（`distillation-service` / `shadow-exam-verifier` / persona-lease 相关；更新既有 lease 测试断言：同 persona busy、跨 persona 不 busy、影子同 persona 互斥）。
- 失败即止。

## 风险

- **中**。改动代码面极小（两处 key），但**语义是并发正确性**：从「全租户串行」放宽到「per-persona 并行」，若某编译目标实际仍 tenant 共享（论证有误），会引入跨 persona 状态污染。缓解：不变量 1（跨 persona 隔离安全网）**先于收窄锁**落地并通过，把安全性建立在测试证据而非论证之上。次要风险：`GLOBAL_LEASE_PERSONA_ID` 若被其它未审代码路径依赖为「全局屏障」——已 grep 确认仅这两处 acquire 用它作 compile 锁，无第三方依赖。

## 交叉审查记录（CLAUDE.md 互审规范）

- **生成:** Claude；**审查:** Codex（独立，非自审）；报告落 `.claude/review-report.md`。
- **Codex 综合评分:** 82/100，建议「需讨论后可实现」，品味 8/10。**安全论证独立核实=基本支持**（K5b 后编译写集 + 快照/回滚均 per-persona，全局锁理由已失效）。
- **主 AI 决策（82 落 80-89 边界，仔细审阅后）:** 采纳，不退回。方案核心成立，Codex 发现的问题均为可修订项，已逐条并入本 spec：
  1. 【事实错误·已修】`memory_edge` 落表更正为 `memory_edges`（非 `persona_memory_edges`）——主 AI 独立核实确认（`memory-executors.ts:238`），Codex 抓对。隔离结论不变。
  2. 【风险·已补】`memory_edges` upsert `ON CONFLICT(source,target)` 无 persona guard → 已加「已知风险」段 + 不变量 1b 覆盖该边界。
  3. 【安全网·已在】跨 persona 隔离测试先于收窄锁——已扩为同时测 value_shift + memory_edge。
  4. 【文档债·已列】陈旧注释同步（artifact-compiler / distillation-service / shadow-exam / lease-types）纳入本地验证清单。
  5. 【既有债·已标】动态预算 resolver 读 default core → 标注为既有设计债，不归入本次安全论证。
- 结论：**spec 通过（修订后）**，进入 writing-plans。
