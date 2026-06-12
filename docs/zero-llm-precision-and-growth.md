# 零-LLM 精度、蒸馏门、提速、成长历程与企业接入

> 本文档解释 ChronoSynth 的核心论题（ADR-0047）在代码中的真实落地：**数字人在没有 LLM
> 时如何不失精度、蒸馏门如何防止 LLM 幻觉污染内核、响应速度如何提升、一个空白人格如何
> 成长为领域大师、以及该人格如何接入企业级系统**。所有论断均引真实代码（`file:line`）。
>
> 相关：[ADR-0047](adr/0047-llm-as-distillable-teacher.md)（LLM 是可蒸馏的老师）、
> [ADR-0048](adr/0048-autonomous-earning-loop-governance.md)（自主挣钱闭环）、
> [ADR-0046](adr/0046-dual-product-companion.md)（双产品）、[architecture.md](architecture.md)。

---

## 0. 一句话论题

**精度不住在 LLM 里。** LLM 是老师，精度是学生（数字人）学到的**确定性内核**。运行时用户
感知的实时路径（决策 / 对话 / 检索）默认**零-LLM**——所以既快又确定可回归；LLM 只在后台
自我成长时被调用，且其产出必须过**蒸馏门**才能进内核——所以幻觉污染不了人格。

```
LLM（老师，离线）──蒸馏门──▶ 确定性内核（学生，运行时）──▶ 用户（决策/对话/建议）
   可能幻觉          四层防御         零-LLM、确定性、快
```

---

## 1. 没有 LLM 时如何不失精度

### 1.1 精度的载体：确定性结构化评分（零依赖纯函数）

`packages/kernel/src/domain/intelligence/structural-scorer.ts:98` `computeStructuralScore`
从人格四层算出综合分，**同输入同输出，无 LLM**：

```
overallScore = alignmentScore − constraintPenalty − stylePenalty + boundedBias
```

| 项 | 来源 | 代码 |
|----|------|------|
| `alignmentScore` | L1 核心价值（权重 × 情绪放大 × 相关度 的加权比） | `structural-scorer.ts:131` |
| `constraintPenalty` | L0 生存锚点被违反的惩罚 | `structural-scorer.ts:46` |
| `stylePenalty` | L2 决策风格（风险偏好 / 时间视野）偏离 | `structural-scorer.ts:61` |
| `cognitiveBias` | L3 认知模型（确认偏误 / 损失厌恶…）系统性偏移（封顶 ±0.2） | `structural-scorer.ts:68` |

### 1.2 关键认知：即使有 LLM，打分也不信任 LLM

`src/intelligence/decision-engine.ts:306` —— 即使 `growth`（有 LLM）模式，LLM 只产出**原材料**
（备选项、模拟结果、对齐度估计），最终分数永远过 `computeStructuralScore`。所以"没有 LLM"
丢的是**生成多样性**，不是**决策精度**。

### 1.3 autonomous 模式是一等主路径，不是降级

`decision-engine.ts:76-109`：`mode:'autonomous'` 完全不触碰 LLM（`evaluateAutonomous`），直接走
`RuleEngine`。注释明说"规则引擎在此处是主路径而非降级回退"。`growth` 模式失败时回退的，正是
autonomous 用的同一套确定性内核（`:86-90`）——**有没有 LLM，最终打分器是同一个**。

### 1.4 冷启动精度来自问卷，不是 LLM

`packages/kernel/src/domain/intelligence/questionnaire-engine.ts:57` `evaluateQuestionnaire` 把
用户问卷答案**确定性地**推断出初始 L0–L3 参数。数字人出生即有精度，不靠 LLM 推断人格。

### 1.5 精度不退化是可度量的硬证据

`src/intelligence/learning-benchmark.ts:5-8` 在 **autonomous 零-LLM 模式**下用固定外部 oracle
（`expectedAlternative`）度量 `accuracy` 命中率，证明蒸馏前后 accuracy **0→1 提升**——"没有 LLM"
不仅不失精度，蒸馏还让它**变准**，且有数字背书。

### 1.6 诚实代价

- **失去的**：备选项开放生成（无 LLM 时回退 `DEFAULT_ALTERNATIVES`，`decision-engine.ts:220`）、
  自然语言解释丰富度（回退模板化解释，`:379-383`）、对**未蒸馏新场景**的泛化。
- **不失的**：已蒸馏价值/规则/风格的决策精度、可解释性、确定性可回归、离线可用。

---

## 2. 蒸馏门：四层纵深防止 LLM 幻觉污染内核

原则：**LLM 输出默认不可信**，进内核必须层层过门；任何一步失败都**回滚 + 标记，不静默吞**。

### 第一层 — 结构校验门（畸形直接拒）

`src/intelligence/distillation-service.ts:106` `validateArtifact`：schema 校验，畸形/缺字段/越界
直接 `rejected`。（WP-3 fuzz 测试钉死：30 类畸形 provider 输出全被拒，内核零脏写，见
`src/test/integration/distillation-provider-fuzz.test.ts`。）

### 第二层 — 来源分级门（distilled vs deterministic）

`packages/kernel/src/domain/core-self/core-update-gate.ts:103-118` 显式分两类来源：
- **deterministic**（API 确认 / 统计漂移，可信）：只看幅度门。
- **distilled**（LLM 蒸馏，可能幻觉）：**额外叠加证据门**。

对幻觉来源的**不对称防御**——LLM 来源更谨慎是对的，不是漂移（`:16`）。

### 第三层 — 三重证据门（防幻觉的核心阈值）

LLM 蒸馏的 `value_shift` 要自动进内核，必须**同时**满足
（`core-update-gate.ts:124-127`，默认值 `:83`）：

```
confidence ≥ 0.8   ∧   patternAgrees === true   ∧   |delta| ≤ 0.05
（置信度门）           （确定性 pattern 交叉验证）    （幅度封顶）
```

每个阈值针对一种幻觉模式：
- **`confidence ≥ 0.8`**：低置信瞎猜进不来。
- **`patternAgrees === true`**：**关键**——LLM 结论必须和**确定性统计 pattern 交叉验证**一致
  （"两个独立证人"机制，单凭 LLM 一面之词不算数）。
- **`|delta| ≤ 0.05`**：**幅度封顶**。幻觉就算漏网，单次也只能造成**有界小漂移**，不会一次
  把人格带偏。

`memory_edge` 同理要 `confidence ≥ 0.75 ∧ evidenceCount ≥ 2`（`:131-137`，至少两条证据）。
不满足 → `confirm`（转人工审批）。**L0 生存锚点 / L2 / L3 / 规则 / 模板的蒸馏来源默认全部需
人工审批**（`:139-141`）——越靠近人格底线，门越严。

### 第四层 — 编译失败→快照回滚（兜底）

即使过了所有门，编译写内核出错时，`distillation-service.ts` 的 `compensateAfterCompile` 会
**回滚到编译前快照 + 标记 rejected**（`SnapshotGuard.snapshot/rollback`，`:59-61`），绝不留
"内核已变 + 工件悬挂"的不一致。

### 阈值的"单一事实来源"（防代码分叉漂移）

`DEFAULT_CORE_UPDATE_GATE_POLICY`（`core-update-gate.ts:83`）是 `Object.freeze` 的**唯一阈值
来源**。历史上两套门控（UpdateGate / canAutoCompile）各自硬编码阈值会越漂越远；现已统一到
一处（PR #61），改一处即两套生效。

> **小结**：幻觉要污染内核，得同时骗过 schema 校验、置信度门、**独立 pattern 交叉验证**、
> 幅度封顶，还要躲过编译回滚——而且单次最多动 0.05。这不是"信任 LLM 再纠错"，是"默认不信，
> 多证据才放行，放行也只给一小步"。

---

## 3. 响应速度如何提升

速度根源：**autonomous 路径整条零 LLM、零网络往返**。一次 LLM 调用通常几百 ms~秒级；确定性
内核是本地纯计算 + SQLite，亚毫秒级——**数量级提升，不是百分比**。

| # | 机制 | 代码 | 效果 |
|---|------|------|------|
| ① | 零-LLM 决策主路径 | `decision-engine.ts:99` autonomous → RuleEngine | 决策延迟从 LLM RTT 降到本地计算 |
| ② | 离线对话回应器（对话零-LLM） | `src/conversation/offline-conversation-responder.ts:81` `respond()` 纯函数 | 无网络拼装人格化回应，可复现 |
| ③ | 响应模板缓存（学过的回复查表） | `src/storage/response-template-store.ts:42` `getLatestByIntent` | 常见意图查表命中，不走生成 |
| ④ | 内存向量索引 + TTL 缓存 | `src/intelligence/embedding-index-memory.ts:70` Map 缓存 + `cosineSimilarityFast:46` | 检索热路径不打 DB/网络 |
| ⑤ | 检索优雅降级 | `src/intelligence/retrieval-service.ts:30` `getContext`（embedding 可空 → 退化关键词/图检索） | 慢路径失败自动切快路径，不阻塞 |

**速度与精度的统一**：两者是同一架构决策的两面——把智慧蒸馏成确定性内核 → 运行时不调 LLM
→ 既不失精度（已蒸馏决策照样准）又快（本地纯计算）。

---

## 4. 离线小模型（Ollama）增强档怎么接

### 4.1 ADR-0047 的"语言皮肤"三档

ADR-0047 把"语言能力"分三档，**精度内核与语言皮肤解耦**：

```
档1：纯本地确定性（offline-conversation-responder）── 零模型、零网络，永远可用
档2：本地小模型增强（Ollama）── 可选，本地推理，仅润色"语言皮肤"
档3：云端 LLM（OpenAI/Anthropic）── growth 模式，生成 + 蒸馏老师
```

**关键不变量**：档2/档3 只增强**表达**（措辞、流畅度、备选生成），不改**决策**——决策永远走
档1 的确定性内核。所以接 Ollama **不影响精度论题**，只换更好的"嘴"。

### 4.2 现状（已就位的部分）

`src/intelligence/model-router.ts` 已把 `ollama` 作为**可选 provider**接入：
- `chat`：`model-router.ts:164` `case 'ollama': chatOllama(...)`。
- `embed`：`model-router.ts:239` `case 'ollama': embedOllama(...)`。
- 配置经 `src/config/schema.ts`，`provider: 'ollama'` + `baseUrl`（本地 Ollama 端点）即可启用。
- keyless 可用性已修：embedding 注入不再要求 `apiKey` 真值（见
  [[adr-deferred-items-progress]]：`intelligenceProvidesEmbeddings(config)` ollama→true）。

**接法（当前）**：把 `intelligence.provider` 配为 `ollama`、`baseUrl` 指向本地 Ollama
（如 `http://localhost:11434`），数字人的 growth 模式即用本地小模型而非云端 LLM——离线、零
云成本、数据不出本机。

### 4.3 自动分层降级链（ADR-0047 D2，已实现）

**`ModelRouter` 现支持有序 provider 链**（`model-router.ts` `fallbacks` + `dispatchWithFallback`）：
主 provider 因**可用性失败**（网络/超时/5xx/能力缺失）时，按顺序降级到下一档；典型配置
`provider:'anthropic'`（云）+ `fallbacks:[{provider:'ollama', baseUrl:'http://localhost:11434'}]`
（本地）。

降级策略（最优实现）：
1. **链式尝试** `[主, ...fallbacks]`，每档自带 provider/model/凭据/端点（云端用云 key、本地用
   本地 url，互不共享）。`dispatchWithFallback` 仅在可用性失败时降级。
2. **主动拒绝不降级**：安全拒绝（`ValidationError`）/ 预算·配额耗尽（`QuotaExceededError`）是
   **有意结果**，换 provider 也该被拒——`isAvailabilityError` 判定这两类直接抛出，不降级（否则
   降级会绕过策略）。
3. **安全/预算/配额只在主路径消费一次**，子路由（fallback）精简、不重复扣费、无递归。
4. **确定性档1 不在 ModelRouter 内**：全链 LLM 都失败 → 抛错，由调用方落到确定性档
   （`decision-engine` → `RuleEngine`，对话 → `offline-conversation-responder`）。所以**最坏情况
   永远 fallback 到确定性，决策不失精度**。
5. 降级次数计入 `llmMetrics.fallbacks` 可观测。

配置：`intelligence.fallbacks: [{ provider, model, baseUrl?, apiKey?, embeddingModel? }]`
（`src/config/schema.ts`）。空数组 = 不降级（保持单 provider 行为不变，向后兼容）。

> 三档完整闭环：**云端 LLM（档3）→ 本地 Ollama（档2）→ 确定性内核（档1）自动逐级降级**，
> 任一层失败自动落到下一层，最坏永远是确定性，既不中断服务又不失决策精度。

---

## 5. 空白人格 → 领域大师：成长历程（以"职业经理人"为例）

一个空白人格成长为领域大师，是 ADR-0047 蒸馏闭环 + ADR-0048 挣钱飞轮的端到端旅程。每一步
都把"经历"确定性地沉淀进内核，全程过蒸馏门，**不靠运行时 LLM 撑场**。

### 阶段 0：诞生（冷启动，确定性）
- owner 答问卷 → `evaluateQuestionnaire`（`questionnaire-engine.ts:57`）确定性推断初始 L0–L3。
- onboarding（`src/onboarding/onboarding-v2-service.ts`）建立 persona、组织归属、初始价值。
- 此刻"职业经理人"人格有了**初始风格**（如 timeHorizon 偏长、riskAppetite 中性），但**零领域经验**。

### 阶段 1：摄入领域知识（确定性沉淀）
- 通过 `src/onboarding/data-ingestion.ts` / knowledge 模块摄入管理学知识、案例库、公司制度。
- 知识落**记忆图**（`CognitiveMemoryGraph`）+ 向量索引，供后续确定性检索（不衰减的长期记忆）。
- 此刻人格能**检索并引用**领域知识（offline-responder 的 `knowledge_grounded` 路径），但还没
  形成"判断力"。

### 阶段 2：在 marketplace 做真实任务（挣经验）
- 人格在 marketplace（人才市场）接管理类 gig：如"评估某扩张方案""审一份预算"。
- ADR-0048 自主挣钱闭环：discover → decide（`DecisionEngine` autonomous 确定性决策）→ execute
  （确定性 skill router + 可选档3 LLM 增强）→ submit。
- 完成质量被打分 `qualityScore`（`earning-outcome-distiller.ts:32`）。

### 阶段 3：经验蒸馏进内核（过门，长本事）
- 高质量完成（`qualityScore ≥ 0.8`）→ `EarningOutcomeDistiller.distill`
  （`earning-outcome-distiller.ts:9`）对"该任务类别对应的价值"产 `value_shift` 候选
  （如多次成功的"审慎扩张"→ 强化"风险评估"价值权重 +0.05/次）。
- 候选过**第 2 节的蒸馏门**：`confidence ≥ 0.8 ∧ patternAgrees ∧ |delta| ≤ 0.05` → 自动编译进
  L1 核心价值；高影响变更（改 L0/L2/规则）→ 人工审批。
- 反复挣→蒸馏，人格的**决策倾向**逐步从"通用"收敛为"职业经理人特有"（重视现金流、风险量化、
  长期视野…）——这是**确定性的、有界的、可审计的**成长，不是 LLM 即兴。

### 阶段 4：规则与认知模型成熟（成为"大师"）
- 反复模式被蒸馏成 `rule`（if-then 偏好规则，刚补全 7/7，见
  `src/storage/rule-store.ts`）：如"若涉及裁员且无合规预案 → avoid"。
- `decision_style_patch` / `cognitive_model_patch` 校准 L2/L3：决策风格趋于成熟（deliberationDepth
  提高、特定偏误被纠正）。
- **大师 = 一套被真实经历蒸馏出来的、确定性的价值 + 规则 + 风格 + 认知模型**。它能在
  **零-LLM** 下对管理决策给出一致、可解释、可回归的判断。

### 阶段 5：成长可度量（证明真的变强）
- `learning-benchmark.ts` 用固定管理类 oracle 回放集，度量蒸馏前后 accuracy 提升——"成为大师"
  不是叙事，是 accuracy 0→1 的数字。

> **历程本质**：经历（挣任务）→ 蒸馏（过门）→ 内核固化（价值/规则/风格）→ 决策更准（benchmark
> 证明）。LLM 全程只当"老师"提供原材料，"本事"长在确定性内核里。

---

## 6. 该人格如何接入企业级系统（提供专业建议 / 辅助决策）

成熟的"职业经理人"人格通过三类企业级接口提供价值，全部带**多租户隔离 + 授权门 + 审计**。

### 6.1 决策建议 API（辅助决策）
- `POST /api/v1/decisions/:id/simulate`（`src/server/routes/decisions.ts:4`）：企业提交一个决策
  case（含备选、约束、上下文），人格用 `DecisionEngine` 给出 `rankedOptions`——每个备选带
  `overallScore` / `alignmentScore` / `regretProbability` / `explanation`（依据 + 反事实）。
- 可选 `mode:'autonomous'`（零-LLM 确定性、快、可复现）或 `growth`（LLM 增强解释）。
- 多租户隔离：`decisions.ts:69` 按 `tenantId` 取租户专属 OS，决策基于**该企业自己养的人格**。

### 6.2 自主行动（代理执行，强授权）
人格不只是"给建议"，还能**代企业执行**经济/工具动作（如查资料、发邮件、提报告），但走
**两层授权 + 多重机器闸**（`src/agent/tool-invocation-pipeline.ts:6-10`）：

```
1. checkAgencyAuthorization：persona 必须有 owner 签发的 active 授权书（自然语言意图）
2. checkPermission：(persona, tool) 必须有未撤销未过期的 ToolPermission
3. enforceQuota：maxActionsPerDay 配额
4. enforceBudget：budgetLimitCents 预算
5. enforceConfirmation：高风险 / requireConfirmation → 强制人工二次确认
6. CircuitBreaker：连续失败/异常自动熔断暂停
```

ADR-0048 治理矩阵：低风险自主、中风险一次性授权、高风险（首次新类别 / 外部承诺 / 敏感数据）
人工审批、**钱包提现/转账永远人工确认**（`wallet 仅 credit-only 自主，debit 需人）。

### 6.3 经济闭环（人格自负盈亏）
- marketplace（人才市场）+ wallet（薪资钱包）：人格接企业 gig 挣钱，结算入钱包；挣到的经验
  反哺成长（第 5 节飞轮）。企业为专业服务付费，人格用收入"养"自己的成长。

### 6.4 企业级保障（已实现）
| 保障 | 实现 |
|------|------|
| 多租户隔离 | `TenantDatabase` 自动注入 `tenant_id`；每企业独立 persona/数据（见隔离审计 `docs/audit/`） |
| GDPR 合规 | 导出/擦除 fail-closed（PR #89）；35 表分类覆盖；legal hold 阻断擦除 |
| 双层授权 + 审计 | agency authorization + tool permission + 全量审计链（hash-chain 锚点） |
| 确定性可解释 | 每个建议带 `scoreBreakdown`（价值贡献/锚点违反/偏差调整），可审计为何这么判 |
| 离线可用 | 断网/无 LLM 时决策走 autonomous、对话走 offline-responder，企业服务不中断 |

> **企业视角的价值**：一个**你自己养大的、懂你公司的、确定性可审计的、离线也能用的**专业
> 人格——不是租用一个黑盒云 LLM，而是一个把你的领域经验蒸馏进确定性内核、能代理行动且全程
> 受治理约束的数字专家。

---

## 附：关键文件索引

| 主题 | 文件 |
|------|------|
| 确定性评分 | `packages/kernel/src/domain/intelligence/structural-scorer.ts` |
| 决策引擎（autonomous/growth） | `src/intelligence/decision-engine.ts` |
| 蒸馏门（统一阈值） | `packages/kernel/src/domain/core-self/core-update-gate.ts` |
| 蒸馏服务（校验/编译/回滚） | `src/intelligence/distillation-service.ts` |
| 挣钱→蒸馏飞轮 | `src/intelligence/earning-outcome-distiller.ts` |
| 规则库（7/7） | `src/storage/rule-store.ts` |
| 离线对话 | `src/conversation/offline-conversation-responder.ts` |
| 冷启动问卷 | `packages/kernel/src/domain/intelligence/questionnaire-engine.ts` |
| 成长度量 | `src/intelligence/learning-benchmark.ts` |
| LLM 路由（Ollama 接入点） | `src/intelligence/model-router.ts` |
| 决策 API | `src/server/routes/decisions.ts` |
| 工具授权管线 | `src/agent/tool-invocation-pipeline.ts` |
