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
| 做到哪步 | #1（birthPersona 加 per-persona 扰动）+ #2（hashSeed 32→64 位）一起 |
| 扰动种子 | `spec.personaId`（`pcore_<UUIDv4>`，122 随机位，种子空间无忧；同 persona 恒同扰动，可复现） |
| 扰动幅度 | 固定 `DEFAULT_PERSONALITY_BIRTH_MAGNITUDE`（0.15，与多租户路径一致），不新增字段 |
| 64 位实现 | BigInt FNV-1a（标准 64 位 offset basis `0xcbf29ce484222325` + prime `0x100000001b3`，掩码 64 位） |
| 兼容性 | 两处均在 `isPristine` 守卫内；现有人格不动 |

## 已知局限（如实记录，不夸大）

- `magnitude=0.15` 下，扰动**有效拉开 6 维中的 5 维浮点维**（riskAppetite/timeHorizon/explorationBias/
  regretSensitivity/lossAversion，各 ±0.15）。**`deliberationDepth`（1..5 整数）几乎不动**：
  `round(depth + jitter×0.15×2) = round(depth ± ≤0.3)` → 停在原型值。这是整数维在小幅度下的固有
  行为，非 bug；多样性主要由 5 个浮点维承载，`personalityDiversity` 度量在这 5 维上从 0 → >0 已足证。
- 本设计只治**出生态**多样性；跨原型的结构差异与后天演化多样性不在范围内（那本就充足）。

## 组件与数据流

### 改动 1：`birthPersona` 加 per-persona 扰动（主）

`src/workforce/workforce-persona-bootstrap-service.ts:114`
- 现状：`core.decisionStyle.set(archetypeDecisionStyle(spec.archetype, now))`
- 改为：先取原型基准，再套 `perturbDecisionStyle(base, spec.personaId, DEFAULT_PERSONALITY_BIRTH_MAGNITUDE, now)`，
  最后 `set`。新增 import：`perturbDecisionStyle` + `DEFAULT_PERSONALITY_BIRTH_MAGNITUDE`（来自 `@chrono/kernel`）。
- 幂等/守卫不变（`isPristine` 已在此函数内，`:102-109`）。

### 改动 2：`hashSeed` 32→64 位 BigInt FNV-1a（次）

`packages/kernel/src/domain/core-self/decision-style-perturbation.ts:68-77`
- 现状：32 位 FNV-1a，`(h>>>0)/0x100000000` → [0,1)。
- 改为：BigInt 64 位 FNV-1a，`Number(h & 0xFFFFFFFFFFFFFFFFn) / 2^64` → [0,1)。
- 纯函数、无依赖、确定性不变（同字符串恒同值）；仅**值分布**变（未来新生扰动值随之变，守卫下不动现有）。
- **须重建 kernel dist**：改 kernel 后 `tsc -b packages/kernel --force`（记忆坑：kernel 类型改动须强制重建）。

数据流不变：出生仍是"取原型基准 → （新增）加 personaId 扰动 → 写 decision_style"，全零-LLM、确定性、
守卫幂等。

## 不变量（测试必须覆盖）

1. **同原型多路 persona 出生态被拉开**：给 N 个同原型、不同 personaId 的 persona 出生，把它们各自
   完整的 `DecisionStyle` 喂给 `personalityDiversity(styles)`，`diversityScore > 0`（修复前恒 =0）。
   注：>0 由 5 个浮点维的分散贡献（deliberationDepth 在 0.15 下不动，不影响结论）。
2. **可复现**：同 personaId + 同 archetype + 同 magnitude → 出生决策风格逐字段相同（跑两次一致）。
3. **不同 personaId 出生态不同**：至少一个浮点维不同（证明扰动真按 personaId 分叉）。
4. **isPristine 守卫不破**：已写过任一核心维度的 persona 再 bootstrap → `skipped_existing`，出生态不被覆盖。
5. **64 位 hashSeed 确定性**：同字符串两次 `hashSeed` 相等；输出 ∈ [0,1)。
6. **零回归（内核纯函数）**：`perturbDecisionStyle(base, seed, 0, now)` （magnitude=0）仍返回 base（不扰动），
   与旧行为一致。

## 明确不做（YAGNI）

- 不给 `WorkerPersonaSpec` 加 magnitude 字段（固定默认足够）。
- 不动多租户路径的 `seed=tenantId` 语义（那是"跨租户差异"的设计意图；per-persona 差异由改动 1 承载）。
- 不改 `deliberationDepth` 的扰动量纲（整数维小幅度不动是固有行为，改它属过度设计）。
- 不追求"6 维全动"或"抹平所有碰撞"（次缺陷 64 位已把碰撞降到可忽略，够了）。

## 本地验证

- **kernel 单测** `packages/kernel/.../decision-style-perturbation` 相关：覆盖不变量 5/6（64 位确定性 + magnitude=0 零回归）。
- **workforce 单测** `src/test/unit/`：覆盖不变量 1/2/3/4（出生扰动拉开 + 可复现 + 分叉 + 守卫）。
- `tsc -b packages/kernel --force` 重建 + `npm run typecheck` + `npm run build`。
- 相关既有测试回归（workforce bootstrap / personality）。
- 失败即止。

## 风险

- **低-中**。#1 纯新增、守卫内、零-LLM，风险低。#2 改内核纯函数、改变未来新生扰动值——但
  `isPristine` 守卫保证现有人格不漂移，可复现性（同 seed→同结果）仍成立，风险可控。唯一操作性坑是
  **必须重建 kernel dist**（否则测试跑旧 32 位实现，假绿）。
