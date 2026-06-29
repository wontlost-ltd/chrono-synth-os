# 0056 — 每-(租户, 人格) 认知内核隔离：一个组织里多个不同认知人格的数字员工

**Status:** Accepted（架构；分阶段——K0 本 ADR 仅定隔离模型 + 分片路线，K1-K6 后续实现）
**Date:** 2026-06-21
**Scope:** `packages/kernel/src/domain/core-self`（认知核心服务）、`src/core`（`CoreRhythmLayer` 及各 Store）、
`src/chrono-synth-os.ts`（OS 的 `core` 生命周期）、`packages/schema-dsl`（核心状态表迁移）、
`src/workforce`（org bootstrap 真实接入）、`src/intelligence`（M3 蒸馏）、`src/workforce/org-autorun-service`（M5 自适应）、
podman 编排。
**Relates to:** [0047](0047-llm-as-distillable-teacher.md)（零-LLM 运行时——本变更不引入运行时 LLM），
[0046](0046-dual-product-companion.md)（enterprise/companion 双产品边界——default persona 承载 legacy），
[0055](0055-digital-workforce-execution-governance.md)（数字员工执行治理——本变更让多 worker 各有独立认知主体）。

## Context（背景）

数字员工组织（M1→D 链→A/B/C→M2/M3/M5/M7）已落地：组织能确定性分解委派、真实执行（经审批门）、
多级协作升级、版本化规则、从经验蒸馏变强、预算内自主运营。但有一个**地基级缺口**：

**认知核心当前是「每租户单个人格」**。`decision_style` / `core_values` / `core_narrative` /
`cognitive_model` / `survival_anchor` / `core_memories` / `core_edges` 等核心状态表**全部按 `tenant_id` 单键**
（无 `persona_id` 维度）；`ChronoSynthOS.core` 是**单个共享 `CoreRhythmLayer` 实例**；9 个 kernel core-self
服务签名是 `(tx, tenantId)`。整个 OS 假设「一租户一脑」。

后果：一个组织里的多个数字员工（worker）虽然各引用一个 `personaId` 字符串，但运行时**共用同一个认知内核**——
他们的决策风格、价值观、记忆图、成长轨迹**全部串在一起**。这使「不同的数字人格」无法真正表达：
- 探索者-研究员和守护者-审核员**做不出不同的决策风格**（共用一个 decision_style）；
- 一个 worker 的成长（M3 蒸馏写入 core）会**污染**另一个 worker 的认知；
- M5 多 worker 调度看似多主体，认知层仍是单主体。

要支撑「一个组织里多个不同认知人格的数字员工」（并最终一键 podman 部署这样一个完整组织），必须先把
**认知核心的身份从 `tenantId` 扩成 `(tenantId, personaId)`**。这是对系统最敏感子系统（零-LLM 认知核心，
ADR-0047 所有论点的根基）的地基级重构，**不能一个 PR 完成**，故本 ADR（K0）先冻结隔离模型、向后兼容
策略、可回滚策略与分片路线，避免后续每片各自发明 persona 语义、乱序返工。

### 现有事实（已核查）

- 核心状态表全部 `tenant_id` 单键：`decision_style`(v005) / `core_values`(v001) / `cognitive_model`(v005) /
  `core_narrative` / `survival_anchor` / `core_memories` / `core_edges`。
- 9 个 kernel core-self 服务（decision-style / cognitive-model / narrative + 各自 queries）= `(tx, tenantId)`。
- `ChronoSynthOS.core = new CoreRhythmLayer(..., tenantId)` 是单个共享实例；它构造 `ValueStore` /
  `NarrativeStore` / `SurvivalAnchorStore` / `DecisionStyleStore` / `CognitiveModelStore`。
- `setDecisionStyle(tx, clock, tenantId, ...)` 按 tenantId 单键 upsert——archetype 应用会覆盖整租户唯一人格。
- 已有零件：`OrgChartService.bootstrap`（仅测试调用）、4 原型 `explorer/guardian/analyst/doer` +
  `archetypeDecisionStyle`、M3 `PlaybookDistiller`（确定性自成长）、M5 `OrgAutorunService`（确定性自适应）、
  podman compose（已有 dev SQLite / prod PG profile）。

## Decision（决策）

**认知核心的身份从 `tenantId` 扩成 `(tenantId, personaId)`。** 每个数字员工（worker）绑定一个 `personaId`，
拥有**真正独立的认知内核**（独立 decision_style / values / memories / narrative / cognitive_model 等）。
legacy「一租户一脑」行为映射到 `personaId = 'default'`，**绝不破坏**。运行时仍**零-LLM**。

> **当前实现进度（截至 K5b：全维度收口）**：认知核心**全 7 维**已按 `(tenant, persona)` 隔离——
> 人格特征三件套 narrative / decision_style / cognitive_model（K2 executor）+ values / memories（含 edges）/
> survival（K5b executor）。working_memory 无 persona_id 列，经 memory_nodes correlated EXISTS 限定所属 persona。
> 隔离机制：写 persona_id + 读按 persona 过滤；主键仍 id（UUID）；tenant_id 由 TenantDatabase rewriter 自动注入。

### D0.1 — personaId 是实例身份，archetype 是模板（不可混淆）

| 概念 | 是什么 | 例子 |
|---|---|---|
| **archetype（原型）** | 模板/出生基准（4 种） | `explorer` / `guardian` / `analyst` / `doer` |
| **personaId（人格实例）** | 一个具体认知内核的稳定身份 | `worker-researcher-01`（出生时套 explorer 模板）|

一个 archetype 可被多个 persona 实例采用（同组织可有两个 explorer）。`personaId` **绝不**从 archetype 名临时推断。

### D0.2 — 隔离边界：`(tenantId, personaId)` 是认知状态的硬边界

所有核心状态读/写**必须**同时携带 `tenantId` + `personaId`。同租户不同 persona 的 decision_style / values /
memories / edges **互不可见、互不覆盖**。这是隔离的硬不变量。

> 实现进度：截至 **K5b 全维度收口**，硬不变量在**全 7 维**完整成立——三件套（narrative / decision_style /
> cognitive_model，K2）+ values / memories / edges / survival（K5b executor 已扩）。

### D0.3 — 向后兼容：default persona 委托

```
旧 (tenantId)  ⟶  (tenantId, personaId = 'default')
```

- **DB 层**：核心状态表加 `persona_id NOT NULL DEFAULT 'default'`；现有数据回填 `'default'`；
  原 tenant 级唯一约束/索引改为含 persona_id 的复合键。
- **服务层**：新 canonical API = `(tx, tenantId, personaId)`；旧 `(tx, tenantId)` API **保留**并委托到 `'default'`。
  **读路径与写路径必须同等扩维**（只改写不改读 = 伪隔离，最隐蔽的 bug）。
- **OS 层**：`ChronoSynthOS.core` 保留为 default persona 的兼容 facade；新路径用 `getCore(tenantId, personaId)`。
  legacy companion + manager-persona 实例继续只看 default core。
- **内存缓存**：`CoreRhythmLayer` / Store / projection cache **必须 persona-aware**——DB 隔离了但内存按 tenant
  缓存仍会串脑。
- **bootstrap 层**：未显式指定 persona 的 legacy / bootstrap 路径只能创建或读取 `'default'`，**不得隐式生成
  archetype 命名的 persona**；多 persona 出生只允许由 K4 的显式、幂等流程完成。
- **M3/M5 层**：单 persona tenant 的 autorun / distill 行为必须**等价于旧行为**，目标 persona 缺省为 `'default'`；
  新 org 路径必须显式传 personaId，tenant 级预算 / 风险天花板兼容旧配置。

### D0.4 — 红线（贯穿所有切片，违反即退回）

1. **零-LLM 运行时**（ADR-0047）：persona 化不引入任何运行时 LLM；认知仍是确定性规则 + 蒸馏 playbook。
2. **向后兼容**：现有单租户单 persona（companion + manager-persona 实例）每片后仍不崩；旧测试不传 personaId 仍过。
3. **可回滚**：每个迁移定义回滚策略；**一旦生产写入非 default persona，回滚到 tenant-only 会丢/合并人格状态**——
   迁移 ADR 必须定义「允许回滚窗口」与「含非 default 数据后的回滚策略」。
4. **读写对称**：每处核心状态读路径与写路径同等扩维 persona。
5. **缓存 persona-aware**：禁止 DB 隔离了内存仍串。
6. **成长/蒸馏目标明确**：M3 蒸馏结果写 persona-local 还是 org-shared，必须有硬边界，不得把一个 worker 的经验
   伪装共享污染另一个 worker。
7. **多 worker 调度确定性**：M5 多 persona 调度固定排序 + 预算扣减顺序 + 风险评估顺序——零-LLM ≠ 自动确定性。
8. **podman 不补应用层**：部署脚本不得硬编码多 persona 弥补应用层缺失的 bootstrap 语义。
9. **core 工厂不 seed 业务状态**（Codex 复审升格）：`getCore` / core factory **只能寻址 / 加载**，**绝不**自动
   seed persona 业务状态（decision_style / values / memories / ...）；persona 出生只允许由 K4 bootstrap 的
   **显式、幂等**流程完成。运行时对象创建带业务副作用 = 回滚 / 测试 / 重启都变难。

## 分片路线（K0-K6，依赖排序，每片独立 PR + Codex 审）

> 核心原则：**先让状态层可同时容纳多 persona，再让服务层显式寻址 persona，再改 OS 内核生命周期，
> 最后接 org / autorun / distiller / 部署。**

```
K0 ADR / 路线冻结（本片，纯规划）
  │
  ▼
K1 数据模型扩维：核心状态表 tenant_id → (tenant_id, persona_id)，回填 default
  │
  ▼
K2 kernel core-self 服务签名扩维：(tx, tenantId) → (tx, tenantId, personaId)，旧 API 委托 default
  │
  ▼
K3 per-persona CoreRhythmLayer 工厂/注册表：os.getCore(tenantId, personaId)，os.core 兼容 facade
  │
  ▼
K4 org bootstrap 真实接入：为每 worker 创建独立 persona core + 套 archetype + 初始化最低可运行 core state
  │
  ▼
K5 M3/M5 persona-aware：蒸馏编译经 resolver 落该 persona 的人格特征内核（narrative/decision_style/
   cognitive_model 三件套已 K2 隔离）；per-persona 快照/回滚读写对称
  │  └─ K5b（**已完成**）：宽表 ValueStore/CognitiveMemoryGraph/SurvivalAnchorStore 的 (tenant, persona)
  │     executor 扩维——value_shift/memory_edge 已 per-persona 隔离（含 earning 回调真接线修复）
  │
  ▼
K6 podman 一键组织部署 + 端到端验收：一条命令起整栈 + seed 多原型 worker 组织 + 跑自适应/自成长周期
```

> **K5 实际隔离边界（诚实声明）**：K5 把蒸馏编译目标从共享 default core 改为按 personaId resolver 寻址，
> 并使快照/回滚 per-persona（读写对称）。但 persona 真隔离的载体目前是**人格特征三件套**（narrative/
> decision_style/cognitive_model，K2 已扩 executor）+ response_template/rule（对象级 persona 落库）。
> `value_shift`/`memory_edge` 底层 `ValueStore`/`CognitiveMemoryGraph` 仍是 tenant 键（`persona_id` 列已
> 加但 executor 未扩），故对非 default persona 这两类编译仍写**同租户共享**价值/记忆——**K5 不声明这两类
> per-persona 隔离**，留 **K5b** 完成宽表 executor 扩维。K5 的 per-persona 自成长以三件套维度为准，并有
> 专门用例锁住 value/memory「当前 = tenant 共享」的真实行为，防止被误当隔离悄悄回归。

| # | 切片 | 前置 | 产出 | 验收要点 | 复杂度 | 风险 | 新 ADR |
|---|---|---|---|---|---|---|---|
| K0 | ADR + 路线冻结 | 无 | 本 ADR（隔离模型 + 兼容/回滚/红线 + 分片路线） | persona 语义/默认值/隔离边界/红线冻结 | 低 | 中 | 是（本片）|
| K1 | 核心状态表扩维 | K0 | 7 张核心表加 `persona_id`(default 'default') + 复合键 + 回填；可回滚。**唯一约束 / 外键 / 查询索引全部跟随 `(tenant_id, persona_id)`——不是只加列** | 旧测试不传 persona 仍过；同 tenant 两 persona 不冲突；memories/edges 不互见；**upsert conflict target / 查询 where / 索引同步扩维** | 中高 | 高 | K0 覆盖 |
| K2 | kernel 服务扩维 | K1 | 9 服务 `(tx,tenantId,personaId)` canonical + 旧 API 委托 default；**读写对称** | default fallback；persona isolation；same tenant 不同 persona 不覆盖 | 中 | 高 | K0 覆盖 |
| K3 | core 工厂/注册表 | K2 | `os.getCore(tenantId,personaId)` 返回独立 `CoreRhythmLayer`；`os.core` 兼容 facade；缓存 persona-aware | 旧 `os.core` 仍跑（=default）；多 core 状态不串；重启可恢复 | 高 | 很高 | K0 覆盖（如生命周期复杂可追 mini-design note）|
| K4 | org bootstrap 真实接入 | K3 | bootstrap 为每 worker 建 persona 记录 + 套 archetype + 初始化最低 core state；幂等/拒绝/versioned 三选一 | 一 tenant seed 多 persona 各有不同 decision_style；core state 完整不靠首次 autorun 隐式补 | 中高 | 中高 | K0 覆盖 |
| K5 | M3/M5 persona-aware | K4 | 蒸馏编译经 resolver 落该 persona 内核；**人格特征三件套(narrative/decision_style/cognitive_model)+response_template/rule persona-local**；per-persona 快照/回滚(coreSelfOnly 精确补偿) | 蒸馏只影响目标 persona 的三件套；default 不污染 worker；per-persona 回滚不误伤其他 persona；单 persona tenant 旧行为不变。**value/memory 仍 tenant 共享(K5b)** | 高 | 很高 | K0 覆盖（如 M3/M5 有独立 ADR 则追 amendment）|
| K5b ✅ | 宽表 executor 扩维（**完成**） | K5 | `ValueStore`/`CognitiveMemoryGraph`/`SurvivalAnchorStore` executor 扩 `(tenant, persona)`（kernel+SQLite+adapter-web+新 anchor executor）；value_shift/memory_edge 达成 per-persona 隔离；earning 回调真接线修复（读 worker 自己的 values）；working_memory 经 memory_nodes EXISTS 限定 | p-alice 的 value/memory/edge/anchor 编译不影响 p-bob/default（隔离测试 8/8）；K5 边界用例已反转为隔离断言 | 中高 | 高 | K0 覆盖 |
| K6 | podman 一键组织部署 | K5 | compose profile 起整栈 + seed 多原型 worker 组织 + 跑确定性自适应/自成长周期；健康检查证明 persona cores ready | 一命令起；多 worker 各异 core；M5 跑通一周期；M3 蒸一次；重启 persona state 保留；旧 dev/prod profile 不破 | 中 | 中 | K0 覆盖 |

### 可并行（很少）
- K0 后可提前草拟 K6 部署文档（不实现最终 compose 行为）。
- K1 后可并行补部分 K2 测试 fixture。
- K3 后 K4/K5 局部并行，但 K5 真验收依赖 K4。

## 排序反模式（务必避免）

1. 先改 kernel 服务、不先加 DB `persona_id` → 服务签名看似支持 persona，数据仍落 tenant 单槽，隔离是假的。
2. 先做 org seed、不先有 per-persona core → 多 worker 仍共享 `os.core`，多个数字员工共用一个脑。
3. 先做 M5 多 worker 调度、不先拆 `this.core` → 调度层多主体、认知层单主体，M3 成长互相污染。
4. 先做 podman 一键 demo 硬编码多 persona → 部署脚本变架构补丁，后续大返工。
5. 先删旧 `(tx, tenantId)` API → 单租户单 persona、旧测试、companion/manager 实例一起爆。
6. 只给写路径加 persona、不改 query/read → 写入隔离、读取串线（最隐蔽最危险）。
7. 把 archetype 当 personaId → 同组织无法有两个 explorer；模板身份与实例身份混淆。
8. 让 core factory 自动 seed persona 业务状态 → 运行时对象创建带业务副作用，回滚/测试/重启都变难。

## Consequences（影响）

**正面**（K5b 全维度收口后**完全成立**）：
- 「不同的数字人格」真正成立——同组织多 worker 各有独立认知内核（全 7 维）、独立决策风格、独立成长轨迹。
- M3 自成长按 persona 局部学习，不污染他人（含 value/memory 维度）；M5 自适应按 persona 调度，认知层真多主体。
- 为「一键 podman 部署完整数字员工组织」铺平地基（K6）。
- legacy 单 persona（companion + manager-persona）经 default 委托完全不受影响。

**负面/代价**：
- 多切片、多周、高风险（动认知核心地基）。每片必须独立可审、可回滚、向后兼容。
- 含非 default persona 数据后回滚受限（红线 3）——一旦生产化要谨慎。
- 内存/缓存 persona 化是隐蔽工作量（红线 5）。

**不做（non-goals）**：
- 不引入运行时 LLM。
- 不做跨 persona 共享认知，除非显式建模（org-shared 层）。
- 本程序不移除 legacy 单 persona 行为。
- 不用 podman 硬编码弥补应用层 bootstrap 语义。

## 下一步

K0（本 ADR）完成即**冻结** persona 语义/默认值/隔离边界/兼容/回滚/红线/分片路线。
后续从 **K1（核心状态表扩维）** 起逐片实施，每片独立 PR + Codex 交叉审查，golden 全绿 + 向后兼容验证后合入。
