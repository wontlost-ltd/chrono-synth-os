# 自演化闭环实证补强 — WBS + 验收契约

> 来源：项目评价的②补强计划（Codex 独立架构审计 72/100 + 我的评价 7.5/10 + 代码占比量化收敛）。
> 核心判断：「可蒸馏的确定性自成长人格」立论**骨架真实、闭环半通、零硬指标**。本 WBS 把"补强计划"
> 落成可执行任务 + 可验证的验收契约。所有缺口已用真实代码核对（引用 file:line）。
>
> **排序原则**：先闭合（earn→distill）→ 再补全（artifact 编译器）→ 再度量（learning benchmark）→ 再加固（真实形态测试）。
> 每个 WP 独立成 PR、Codex 交叉审、本地 test:golden 全绿。

---

## 现状核对（事实，非推测）

| 缺口 | 代码证据 |
|------|---------|
| earn→distill **未自动接线** | `persona-marketplace-service.ts:1269` `completeTask` 算出 `growthDelta/reputationDelta`(:1280-81) **直写 persona**，全程不碰 `earningDistiller`。distiller 已建（`chrono-synth-os.ts:177`）但 marketplace 拿不到 |
| 蒸馏编译器**只实现 4/7 种 artifact** | `artifact-compiler.ts:16` 注明「rule / decision_style_patch / cognitive_model_patch 目前不编译」；switch(:62) 仅 value_shift/memory_edge/narrative_patch/response_template |
| **无"变好"硬指标** | 无 benchmark/replay/baseline 代码；但决策引擎已产出可度量量：`decision-engine.ts` `recommendedAlternative`(:174)/`regretProbability`(:150)/`overallScore`，且是**零-LLM 确定性路径**(:107) |
| 测试**偏理想化 mock** | 关键测试用 TestClock/内存DB/mock provider/手造 evidence（本周实战已被 route-B、真实快照形态等 Critical 反复教训） |

---

## WP-0 ｜ 接通 earn→distill 自动闭环（P0，最该闭合）

**目标**：让「挣钱完成 → 高质量 outcome → 自动蒸馏 → 经蒸馏门更新内核」端到端跑通，不再绕过蒸馏门。

### 任务
- T0.1 让 `completeTask`/`settleTaskPayment` 路径能拿到 `EarningOutcomeDistiller`（依赖注入或经 ChronoSynthOS 编排器回调；**不**让 marketplace service 直接 new）。
- T0.2 任务完成结算后，把高质量 outcome（qualityScore ≥ 阈值）自动喂 `earningDistiller.distill(...)` → 产 `value_shift` 候选 → 进 `core-update-gate`（**不再**直写 `growthDelta` 绕过门）。
- T0.3 保留 reputation/wallet 的即时结算（那是经济账，不走蒸馏）；只把**人格成长**改走蒸馏门。区分清楚「钱」与「成长」两条路径。
- T0.4 低质量 outcome（qualityScore < 阈值）不触发蒸馏（避免噪声污染内核），记审计。

### 验收契约
- ✅ `autonomous-earning-e2e.test.ts` 升级为**全链断言**：earn → accept → complete → **distill 被自动触发** → core-update-gate 审核 → `core.values` 权重确实变化。现在它只到「能 apply 任务」(`:97-105`)。
- ✅ 新增单测：高质量 outcome 触发蒸馏候选；低质量 outcome 不触发。
- ✅ 回归：现有 marketplace/wallet 结算测试不变（钱的路径行为等价）。
- ✅ 审计：蒸馏触发/跳过有 audit 记录。
- ✅ test:golden 全绿；Codex ≥90 PASS。

**反向不变量**：不得让"挣钱"能绕过 core-update-gate 直接改人格内核（这正是当前 bug）。

---

## WP-1 ｜ 补齐蒸馏编译器 artifact 覆盖（P1）

**目标**：`artifact-compiler` 支持全部 7 种 artifact kind，让「老师产出」能完整蒸馏进内核。

### 任务
- T1.1 实现 `decision_style_patch` 编译路径 → 写 `CoreSelfState.decisionStyle`（经 CoreRhythmLayer，与 value_shift 同纪律）。
- T1.2 实现 `cognitive_model_patch` 编译路径 → 写 `CoreSelfState.cognitiveModel`。
- T1.3 实现 `rule` 编译路径 → 写规则存储（rule-engine 的持久规则；明确是否衰减/版本化，参考 response_template 的专用表设计）。
- T1.4 每种 kind 缺依赖时**显式失败**（`{ok:false, reason}`），与现有 response_template 的"未注入则不可编译"一致，不静默吞。

### 验收契约
- ✅ `artifact-compiler.ts` 的 switch 覆盖全部 7 种 kind；移除 `:16` 的"目前不编译"注释。
- ✅ 每种新 kind 一条集成测试：构造 artifact → 编译 → 断言**内核对应字段确实变化**（decisionStyle/cognitiveModel/rule 各一）。
- ✅ 缺依赖显式失败测试（不静默）。
- ✅ 契约：新 artifact 类型若涉及 @chrono/contracts schema，前后端同源。
- ✅ test:golden 全绿；Codex ≥90 PASS。

**依赖**：可与 WP-0 并行（不互相阻塞），但建议 WP-0 先合（闭环优先于覆盖面）。

---

## WP-2 ｜ persona learning benchmark（P2，核心命题的实证）★最高价值

**目标**：把"它真的在成长"从叙事变成**可回归的数字**。建固定数据集，跑 `baseline → 学习 → replay`，度量决策质量。

### 任务
- T2.1 建固定 **decision case 回放集**（N 个标准决策场景 + 期望/标注），放 `src/test/benchmark/fixtures/` 或专用目录。
- T2.2 建 benchmark runner：同一回放集，对**学习前(baseline persona)** 与**学习后(经 WP-0/WP-1 蒸馏过的 persona)** 各跑一遍 `decision-engine`，采集指标。
- T2.3 指标（全部基于决策引擎已有可度量输出，无需新埋点）：
  - **推荐一致性**：同场景学习前后推荐是否稳定/可解释地变化（不是随机抖动）。
  - **价值违背率**：推荐是否违背 persona 的 top values（用 drift/values 算）。
  - **后悔概率均值**：`regretProbability` 学习后是否下降。
  - **任务成功率 / 收益质量**：回放挣钱场景，qualityScore 分布学习后是否上移。
- T2.4 把 benchmark 接进 `ga:check`（作为新门或 advisory 报告），让"学习有效性"成为发布可见信号。

### 验收契约
- ✅ benchmark 可重复运行（确定性，TestClock + 固定种子），输出指标报告（JSON + 人读摘要）。
- ✅ 至少证明**一个**正向闭环：构造一个"学习应让 X 更好"的场景，benchmark 显示学习后该指标确实改善（baseline → learned 的 delta 有方向性、可解释）。
- ✅ 指标全部来自现有决策引擎输出（recommendedAlternative/regretProbability/overallScore），不新增侵入式埋点。
- ✅ 报告纳入 ga:check（advisory 起步，不阻断；指标退化时告警）。
- ✅ Codex ≥90 PASS（重点审：指标是否真能反映"变好"，还是自证）。

**这是把项目从"令人印象深刻的工程"推到"立论被证实的产品"的关键 WP——优先级最高，但依赖 WP-0/WP-1 先让闭环可跑。**

---

## WP-3 ｜ 真实形态契约 / fuzz 测试（P3，补测试结构性偏斜）

**目标**：消除"理想化 mock 掩盖真实契约"的系统性风险（本周已被 route-B、真实快照 coreSelf.values Map 等 Critical 反复教训）。

### 任务
- T3.1 给真实 LLM provider 输出加 contract/fuzz 测试：malformed JSON、缺字段、幻觉 evidence、schema 漂移 → 蒸馏/解析应优雅降级不崩。
- T3.2 给跨端数据形态加契约锁：真实快照形态（`coreSelf.values` 序列化 Map）、API 信封（desktop apiFetch 不解包 `{data}`）—— 把本周踩的坑变成回归测试。
- T3.3 审计现有"理想化 mock"测试，对核心命题路径（蒸馏/drift/earning）补至少一条贴近真实数据形态的集成测试。

### 验收契约
- ✅ provider 输出 fuzz：恶意/畸形输入下蒸馏管线不崩、不写脏数据进内核。
- ✅ 跨端形态契约锁：真实快照 Map 形态 + 信封形态各有回归测试。
- ✅ test:golden 全绿；Codex ≥90 PASS。

---

## WP-4 ｜ 企业面架构预算（P4，纠正占比错配）

**目标**：冻结/限速新增 SaaS 能力，把工程力转回核心人格生命周期。

### 任务
- T4.1 记录占比基线（已量化：核心①+②=19% ≈ 企业④=19%，内核本体仅 12%）。
- T4.2 约定"架构预算"规则：新增企业模块需附带等量或更多的核心命题进展（文档约定，非硬门）。
- T4.3 评估现有企业模块哪些可下沉为可选插件/分包，减小核心心智负担（尤其 kernel 域里混入的 billing/enterprise/compliance）。

### 验收契约
- ✅ 占比基线 + 预算规则写入 ADR 或 CONTRIBUTING。
- ⊘ （可选项，已撤销）「从 kernel 域剥离企业能力」——③ 实做时发现这是度量误判：
  kernel 的 billing/enterprise/compliance/multi-tenant 是纯 Query/Command 可携契约
  （零逻辑零依赖，与其它 50+ 同类契约一致），不是 SaaS 逻辑，无可剥离。ADR-0050
  已据此修正（D2 重定义 / D3 撤销），占比基线改用 src/ 逻辑 LOC 量化。

---

## 优先级与排期建议

```
WP-0 (earn→distill 闭环) ──┐
                          ├─→ WP-2 (learning benchmark) ★最高价值
WP-1 (artifact 编译器补全)─┘         │
                                    └─→ 立论被证实
WP-3 (真实形态测试) ── 贯穿，随时插入
WP-4 (架构预算) ── 治理层，并行推进
```

- **第一步**：WP-0（最聚焦、最该闭合，Codex 标的"最危险"）。
- **第二步**：WP-1（与 WP-0 可并行）。
- **第三步**：WP-2（依赖 0/1 让闭环可跑；是核心命题实证的关键，价值最高）。
- WP-3 贯穿、WP-4 治理层并行。

## 总验收（项目级）

> 当 WP-0/1/2 完成，项目应能用**一个可重复的 benchmark 数字**回答"它真的在变好吗"——
> 这是把 7.5/10、72/100 推向更高分的唯一杠杆。**不是再加企业模块，是证明人格内核在自成长。**
