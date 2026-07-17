# 人格出生多样性设计（消除同原型出生撞车）

**日期:** 2026-07-17
**范围:** `src/workforce/workforce-persona-bootstrap-service.ts`（出生扰动接线）、
`packages/kernel/src/domain/core-self/decision-style-perturbation.ts`（hashSeed 32→64 位）
**关联:** ADR-0056（per-persona 隔离）、ADR-0047（可复现内核，出生扰动须确定性）、
规模化评估（"出生多样性天花板"是 6e9 规模第 2 类缺陷）、PR #159（出生扰动接入多租户路径）

## 背景与问题（读代码校准）

规模化评估指出"出生态在 6e9 规模会塌成近似重复"。逐路径核对后，缺陷有两层，主次分明：

1. **主缺陷（workforce 出生路径零扰动）。** `WorkforcePersonaBootstrapService.birthPersona()`
   （`src/workforce/workforce-persona-bootstrap-service.ts:114`）对每个 persona 只写
   `archetypeDecisionStyle(spec.archetype)`，**不加任何扰动**。→ 同一原型的所有数字员工出生时
   决策风格**逐字节相同**；4 原型 = 全库最多 4 种出生决策风格，与人格数量无关。这是"同原型出生
   全相同"，是真正压垮多样性的一层。

2. **次缺陷（扰动值空间 32 位天花板）。** 多租户路径已加扰动（`chrono-synth-os.ts:533`
   `perturbDecisionStyle`），但其 PRNG `hashSeed`（`decision-style-perturbation.ts:68-77`）是
   **FNV-1a 32 位**（`0x811c9dc5` + `Math.imul(...,0x01000193)` + `>>> 0`）。扰动值空间 ≤2^32≈4.3e9，
   6e9 种子必然鸽笼碰撞（~46% 撞车）。这在主缺陷修复后、极大规模时才成为瓶颈。

## 关键安全属性（为什么不破坏现有人格）

两条出生路径都有 **`isPristine` 守卫**（`chrono-synth-os.ts:520-528` / `bootstrap:102-109`）：
出生扰动/出生写入**只作用于 7 维核心全空的全新 persona**；任一核心维度非空即"已出生/已成长"，跳过。
→ 本设计的两处改动都在守卫之内：**只改变未来新生 persona 的出生态，已落库人格零漂移。**
这消解了"改出生逻辑破坏可复现性"的顾虑——可复现性铁律要求"相同 seed→相同扰动"，本设计仍满足
（同 personaId + 同 magnitude → 同扰动），只是把"未加扰动"变为"加确定性扰动"，把 32 位换成 64 位。

## 设计决策

| 决策 | 选择 |
| --- | --- |
| 做到哪步 | #1（birthPersona 加 per-persona 扰动）+ #2（hashSeed 32→64 位）+ #3（deliberationDepth 整数维也拉开）一起 |
| 扰动种子 | `spec.personaId`（`pcore_<UUIDv4>`，122 随机位，种子空间无忧；同 persona 恒同扰动，可复现） |
| 扰动幅度 | 固定 0.15（与多租户路径一致）。`DEFAULT_PERSONALITY_BIRTH_MAGNITUDE` 现仅在 `tenant-os-factory.ts` 定义、**未从 kernel 导出**，故 workforce 服务内定义同值本地 const（镜像 tenant-factory 模式），不新增 spec 字段、不扩 kernel API |
| 64 位实现 | BigInt FNV-1a（标准 64 位 offset basis `0xcbf29ce484222325` + prime `0x100000001b3`，掩码 64 位） |
| deliberationDepth 拉开 | 整数维缩放系数 `×2` → 具名常量 `INT_DIM_SCALE=10`：`round(depth + jitter×mag×10)`。数值已实测（base=3, mag=0.15 → 分布 {2,3,4} 各约三分之一），`magnitude=0` 仍 `depth+0=depth`（向后兼容），`clampInt` 保 [1,5] |
| 兼容性 | 三处均在 `isPristine` 守卫内；现有人格不动 |

## 已知局限（如实记录，不夸大）

- 修复后 `magnitude=0.15` 下 **6 维全部拉开**：5 个浮点维各 ±0.15；`deliberationDepth`（1..5 整数）
  经 `INT_DIM_SCALE=10` 后实测在原型值 ±1（偶尔 ±2）范围分散（如 base=3 → {2,3,4} 各约三分之一）。
  整数维天然只能取有限档，分散度低于连续浮点维是固有特性，非缺陷。
- 本设计只治**出生态**多样性；跨原型的结构差异与后天演化多样性不在范围内（那本就充足）。
- `INT_DIM_SCALE=10` 是"让 0.15 幅度在 5 档整数上产生 ±1~2 分散"的经验值，非任意——见决策表实测依据。

## 组件与数据流

### 改动 1：`birthPersona` 加 per-persona 扰动（主）

`src/workforce/workforce-persona-bootstrap-service.ts:114`
- 现状：`core.decisionStyle.set(archetypeDecisionStyle(spec.archetype, now))`
- 改为：先取原型基准，再套 `perturbDecisionStyle(base, spec.personaId, BIRTH_MAGNITUDE, now)`，最后 `set`。
  新增 import：`perturbDecisionStyle`（来自 `@chrono/kernel`）；`BIRTH_MAGNITUDE = 0.15` 为服务内本地 const
  （`DEFAULT_PERSONALITY_BIRTH_MAGNITUDE` 未从 kernel 导出，镜像 `tenant-os-factory.ts:35` 的本地定义模式）。
- 幂等/守卫不变（`isPristine` 已在此函数内，`:102-109`）。

### 改动 2：`hashSeed` 32→64 位 BigInt FNV-1a（次）

`packages/kernel/src/domain/core-self/decision-style-perturbation.ts:68-77`
- 现状：32 位 FNV-1a，`(h>>>0)/0x100000000` → [0,1)。
- 改为：BigInt 64 位 FNV-1a，`Number(h & 0xFFFFFFFFFFFFFFFFn) / 2^64` → [0,1)。
- 纯函数、无依赖、确定性不变（同字符串恒同值）；仅**值分布**变（未来新生扰动值随之变，守卫下不动现有）。

### 改动 3：`deliberationDepth` 整数维拉开（补齐第 6 维）

`packages/kernel/src/domain/core-self/decision-style-perturbation.ts:56-60`
- 现状：`round(base.deliberationDepth + jitter × mag × 2)` → mag=0.15 时 offset∈[-0.3,0.3]→恒 round 回 base。
- 改为：具名常量 `const INT_DIM_SCALE = 10`，`round(base.deliberationDepth + jitter × mag × INT_DIM_SCALE)`，
  仍走既有 `clampInt(..., 1, 5)`。mag=0 时 `jitter×0×10=0` → 恒等 base（向后兼容不破）；mag=0.15 时实测
  在 base±1（偶尔±2）分散。
- 改动 2 与 3 同在此文件，一并改、一并重建。
- **须重建 kernel dist**：改 kernel 后 `tsc -b packages/kernel --force`（记忆坑：kernel 类型改动须强制重建），
  否则测试跑旧 dist 假绿。

数据流不变：出生仍是"取原型基准 → （新增）加 personaId 扰动 → 写 decision_style"，全零-LLM、确定性、
守卫幂等。

## 不变量（测试必须覆盖）

1. **同原型多路 persona 出生态被拉开**：给 N 个同原型、不同 personaId 的 persona 出生，把它们各自
   完整的 `DecisionStyle` 喂给 `personalityDiversity(styles)`，`diversityScore > 0`（修复前恒 =0）。
2. **可复现**：同 personaId + 同 archetype + 同 magnitude → 出生决策风格逐字段相同（跑两次一致）。
3. **不同 personaId 出生态不同**：至少一个浮点维不同（证明扰动真按 personaId 分叉）。
4. **isPristine 守卫不破**：已写过任一核心维度的 persona 再 bootstrap → `skipped_existing`，出生态不被覆盖。
5. **64 位 hashSeed 确定性**：同字符串两次 `hashSeed` 相等；输出 ∈ [0,1)。
6. **零回归（内核纯函数）**：`perturbDecisionStyle(base, seed, 0, now)` （magnitude=0）仍返回 base（不扰动，
   含 deliberationDepth 不变），与旧行为一致。
7. **deliberationDepth 在 0.15 下真拉开**：给一批不同 personaId、同 base（如 deliberationDepth=3）、mag=0.15
   扰动，结果 deliberationDepth 出现 ≥2 个不同取值（修复前恒为单一值 3）；且全部 ∈ [1,5] 整数。

## 明确不做（YAGNI）

- 不给 `WorkerPersonaSpec` 加 magnitude 字段（固定默认足够）。
- 不动多租户路径的 `seed=tenantId` 语义（那是"跨租户差异"的设计意图；per-persona 差异由改动 1 承载）。
- 不把 `DEFAULT_PERSONALITY_BIRTH_MAGNITUDE` 提升进 kernel API（workforce 侧本地 const 足够，避免扩内核表面）。
- 不追求"抹平所有碰撞"（64 位已把碰撞降到可忽略，够了）。

## 本地验证

- **kernel 单测** `packages/kernel/test/decision-style-perturbation.test.ts`（既有文件，增补断言）：
  覆盖不变量 5/6/7（64 位确定性 + magnitude=0 零回归 + deliberationDepth 在 0.15 下拉开）。
- **workforce 单测** `src/test/unit/`：覆盖不变量 1/2/3/4（出生扰动拉开 + 可复现 + 分叉 + 守卫）。
- `tsc -b packages/kernel --force` 重建 + `npm run typecheck` + `npm run build`。
- 相关既有测试回归（workforce bootstrap / personality-archetypes / personality-diversity）。
- 失败即止。

## 风险

- **低-中**。#1 纯新增、守卫内、零-LLM，风险低。#2/#3 改内核纯函数、改变未来新生扰动值——但
  `isPristine` 守卫保证现有人格不漂移，可复现性（同 seed→同结果）仍成立，风险可控。两个操作性坑：
  （a）**必须重建 kernel dist**（否则测试跑旧实现，假绿）；（b）改动 3 会让**既有 kernel 测试里任何隐含
  "deliberationDepth 在非零 magnitude 下不变"的断言失效**——已核对 `decision-style-perturbation.test.ts`：
  仅 magnitude=0 断言其不变（仍成立）+ 合法性断言（仍成立），无 "0.15 下不动" 断言，故不破既有测试。
