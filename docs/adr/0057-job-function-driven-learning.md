# 0057 — 数字员工按职能进修：缺口驱动的请教式深度学习，沉淀成自己的知识体系

**Status:** Accepted（架构；分阶段——L0 本 ADR 仅定学习模型 + 红线 + 分片路线，L1-L8 后续实现）
**Date:** 2026-06-22
**Scope:** `src/intelligence`（蒸馏门 / LLM 老师 / 新增 GapDetector / TeacherReviewGate / ExamScorer）、
`src/knowledge`（文档导入 / 知识体系沉淀）、`src/core`（影子内核验收 / consolidation 接通）、
`src/workforce`（roleCode/jobFamily/requiredCapabilities 职能信息源 / 缺口处置=委派降级挂起 / capability-learned 唤醒重跑，D0.8）、
`packages/kernel`（确定性评分/缺口判定纯逻辑）、
`src/server/routes`（学习请求 / 验收 / 审计端点）、`packages/schema-dsl`（学习账本 / 能力索引迁移）。
**Relates to:** [0047](0047-llm-as-distillable-teacher.md)（**根基**——运行时零-LLM，LLM 只当老师经蒸馏门变确定性；
本 ADR 是其自然延伸：把「老师只在学习期出现」扩到「上岗遇缺口时按需请教」），
[0051](0051-external-perception-as-sensory-teacher.md)（感知老师——又一条经蒸馏门的学习通道），
[0054](0054-proactive-persona-self-initiated-contact.md)（主动性=对既有信号的**确定性门控**，非新推理循环——
缺口发现沿用同一纪律），[0055](0055-digital-workforce-execution-governance.md)（执行治理——任务能力/`requiredCapabilities`
是缺口与职能相关性的来源），[0056](0056-per-persona-cognitive-core-isolation.md)（per-persona 全维度隔离——
学习落各员工**自己**的内核，K5b 已就绪的前提）。

## Context（背景）

数字员工组织（ADR-0056 + K5b）已能让一个组织里多个数字员工各有**独立**的全维度认知内核。现有学习设施也已齐全：
三条学习通道（LLM 老师反思 `LlmReflectionDistiller` / 文档导入 `KnowledgeIngestionService` / 感知老师
`PerceptionDistiller`）都汇聚到同一个**蒸馏门**（`DistillationService`：ingest → validate → `canAutoCompile`
→ 不确定性预算 → 快照编译 / 回滚），且 K5b 后都落各员工**自己**的隔离内核。

但有一个能力缺口——学习目前**不按职能、不自主、不验收、不成体系**：

- **不按职能**：archetype/roleCode 只在出生时定性格（一句叙事 + 决策风格），**不驱动学什么**。researcher 和
  reviewer 的学习路径完全一样。
- **不自主发现缺口**：`/reflect` 要 persona 被动触发，没有「我这个任务不会做 → 我得去学这块」的机制。
- **无验收**：学到的东西直接（或经人工审批）进核心，没有「学会了没有」的考核。
- **不成体系**：`memory consolidation`（episodic→semantic 升华）代码在 kernel 里但**无调度触发**（dormant），
  知识停留在扁平记忆图，never 组织成结构化知识体系。

### 用户意图（已澄清，对话 5 轮）

数字员工应**像人类进修一样**深入学习：

1. **缺口驱动的按需进修（请教式）**：上岗干活时，若**确定性内核答不了 / 不会做**（知识缺口），数字员工
   **自主发现**缺口 → **申请**向 LLM 老师请教 → 在老师指导下完成工作的知识经蒸馏门**积累沉淀**。
   **下次遇同类问题 → 已沉淀，零-LLM 直接干，不再请教。**
2. **双 LLM 老师 + 互审**：两个独立 LLM 老师，**互相审核**对方教的内容，保证学的是**能提高生产力**的知识。
3. **生产力判定 = 绑职能相关性**：双老师互审准则 = 与该 persona 的 roleCode/jobFamily/requiredCapabilities
   相关 + 能落到可执行能力 + 与已有知识不矛盾。两老师都认可才进学习；一老师否决（偏题/无关）则退回。
4. **拟题验收 ≥95**：双老师拟题 → 数字员工作答 → ≥95 分才算「学会」→ 过蒸馏门沉淀；不到 95 补学。
5. **沉淀成知识体系**：消化成**结构化知识体系**而非一堆扁平记忆。
6. 全程 **per-persona**（各员工学进各自隔离内核）。

## Decision（决策）

**新增「数字员工按职能进修」能力：缺口驱动 → 双老师互审 → 影子内核验收（≥95）→ 蒸馏门沉淀 → 结构化知识体系。
全程严格区分「学习期」与「运行时」——LLM 只在学习期/请教期当老师，运行时干活始终零-LLM（用已沉淀的确定性内核）。**

这是 ADR-0047 的自然延伸而非推翻：ADR-0047 说「LLM 只在学习期出现，经蒸馏门变确定性」；本 ADR 把「学习期」
的触发从「定期自省 / 人工导入」扩成「**上岗遇缺口时按需请教**」，并补上「**双老师质量门 + 验收考试 + 知识体系沉淀**」。

### D0.1 — 学习期 vs 运行时：零-LLM 铁律的守法（最关键）

```
运行时（干活，零-LLM 铁律）：
  任务到来 → 用**已沉淀的确定性内核**作答/执行
    ├─ 内核覆盖 → 直接干（零-LLM）                    ← 绝大多数情况
    └─ 内核**缺口**（GapDetector 确定性判定）→ 不当场调 LLM 硬答；缺口处置（D0.8，尽量不卡死）：
        ├─ 能委派 → 交给会这块的同事/上级（org chart 委派链），任务**继续**
        ├─ 能降级 → 出保守版 + 标注待补，任务**有产出**
        └─ 都不行 → 任务**挂起**(pending, 绑学习请求) + **登记一次学习请求**（进异步学习期）

学习期（请教，可用 LLM 老师——离线、异步、不在运行时关键路径）：
  学习请求 → ①双老师互审门（职能相关? 提高生产力?）
           → ②双老师教学（产出候选知识 artifact）
           → ③双老师拟题 + 冻结 ExamSpec（标准答案要点 + 禁忌点，一次性 LLM 生成后固化）
           → ④**影子内核验收**：候选知识临时编译进 shadow core，
               用**确定性内核**作答考题 → 确定性评分器算命中率
           → ⑤≥95 → 过**蒸馏门**正式落主内核 + 记 LearningRecord；<95 → 补学（回 ②）

挂起任务的复活：学习期 ⑤≥95 落主内核 → 发 `capability-learned(X)` 事件 → 标记缺口 X resolved → 任务全部缺口
清零后**确定性 GapDetector 复检** → 无缺口则**零-LLM 重跑干完**（学完马上投入，见 D0.8；仍缺则 fail-closed 不假完成）。
下次遇同类任务 → 内核已覆盖 → 零-LLM 直接干（不再请教）
```

**铁律守法的本质**：运行时**永不**为了「答这道题」而同步调 LLM。LLM 只在异步学习期出现。验收考的是
「**确定性内核**能不能答」（影子内核作答，零-LLM），证明真学会了——而非「LLM 能不能答」。学习产物
**必须**经蒸馏门才进主内核。这样 ADR-0047 的核心论点（数字人可蒸馏成确定性内核、不依赖 LLM 运行）
在「按职能进修」下**完整成立**。

### D0.2 — 缺口发现：确定性 GapDetector（非新 LLM 推理循环）

沿用 ADR-0054 纪律：缺口发现是对**既有确定性信号**的门控，**不是**一个后台 LLM「思考我会不会」的循环。
确定性缺口信号（按可靠性/可解释性排序）：

1. **职能能力覆盖缺失**（最结构化）：任务/岗位声明的 `requiredCapabilities`（ADR-0055）与 persona 已沉淀
   能力索引（D0.5）的差集——「这任务要求能力 X，我没学过 X」。
2. **确定性检索弱命中**：offline retrieval（记忆/规则/模板）对任务的命中数/relevance 低于阈值。
3. **离线应答 honest_offline / 低 grounding**：`OfflineConversationResponder` 对任务问句返回 honest_offline
   或 grounding score 低于门槛——「我诚实地不知道」。
4. **执行弱点信号**：任务 rejected / blocked / overdue（ADR-0055 执行治理已有这些状态）反复出现在某能力域。
5. **知识体系空洞**（最弱/兜底）：知识体系（D0.5）某职能域节点稀疏。

GapDetector 是**纯函数门控**：输入这些确定性信号 → 输出 `LearningRequest{ personaId, capability, evidence,
priority }`。门控阈值可配置（per-persona/per-tenant governance，复用 ADR-0048 治理配置模式）。

**确定性来源硬约束（Codex 复审：堵暗门）**：运行时 gap 信号**只能**用——
- 检索相关性/grounding：**已冻结的本地索引 + 确定性检索（关键词/精确匹配）+ 固定阈值**；
  **禁止**运行时调用 cloud LLM / 云 embedding / LLM reranker 算相关性（那会把运行时 LLM 依赖偷渡回来，破铁律）。
- 能力归因（执行弱点 → 哪块能力缺）：**必须**来自任务字段 / `requiredCapabilities` / 确定性映射，
  **禁止** LLM 归因「这个失败是因为缺能力 X」。
- 整个 GapDetector **禁止**调用任何 LLM/teacher endpoint（它是运行时纯函数门控，非学习期）。

### D0.3 — 双老师互审门（在蒸馏门之前）

两个**独立** LLM 老师（复用 BYOK `ModelRouter`）。**独立性按可审计 independence tuple 判定**（Codex 独立复审：
统一前后口径）：`{ providerId, modelId, baseUrl, apiKeyId, account/orgId }`——**至少禁止同 provider + 同
account + 同 key 冒充双老师**。强独立 = 不同 provider；若部署只能同 provider（不同 account/key），须**明示为「弱独立」**
并相应提高人工复核/审计要求（弱独立时单老师误导风险更高）。

- **互审模式**：两老师**各自独立**产出对「该不该学这块、是否职能相关、是否可执行落地」的 **verdict**
  （`TeacherVerdict{ approve, reason, productivityRelevance, conflictsWithExisting }`），再**交叉审核**对方的教学
  内容草案。**两者都 approve 且都判「职能相关」才进学习；任一否决（偏题/无关/与已有知识矛盾）则退回。**
  **独立性强化（Codex 复审）**：初审阶段两老师**互不可见**对方草案（避免趋同/串通）；各自 verdict **固化后**
  才进入交叉审。最低独立性 = independence tuple 不冲突（红线 6），更强独立性 = 初审 blind + verdict 冻结再交叉。
- **职能相关性部分确定性化**：互审门**前置**一道**确定性筛**——候选知识必须能映射到 persona 的
  roleCode/jobFamily/requiredCapabilities（关键词/能力映射），过不了确定性筛的直接退回，**减少纯 LLM 主观**。
  LLM 老师只在确定性筛通过后判更细的相关性/生产力价值。
- **位置**：互审门在**蒸馏门之前**，负责「**该不该学**」（教学层质量）；蒸馏门继续负责「**怎么安全进核心**」
  （schema 校验 / 不确定性预算 / 快照编译 / 回滚）。两层**不冗余**——互审门判内容价值，蒸馏门判落地安全。

### D0.4 — 拟题验收：冻结 ExamSpec + 确定性评分器（≥95 可复现）

「≥95 分合格」**必须可复现可审计**，不能靠 LLM 现场主观打分。

- **拟题（LLM，一次性）**：双老师拟题，**同时冻结**完整 `ExamSpec`，固化进考试账本**不可变**——必须包含
  （Codex 复审：scorer 规格化，否则「≥95 可审计」只成立一半）：
  `{ questions, keypoints(含权重), aliases/regex(每个要点的同义词与匹配模式), structuredAnswerFields(结构化答案字段),
  forbiddenClaims(禁忌点匹配规则), scorerVersion, normalizerVersion, tokenizerVersion }`。
  **「LLM 生成规则」不破确定性**：aliases/regex/keypoints 由 LLM 学习期生成，但**一旦冻结即不可变**——评分时只
  执行冻结规则、不再调 LLM。LLM 两次拟题给不同 rubric ≠ 评分不确定，而是「不同考试版本」；**一份 ExamSpec 冻结后
  就是该次学习验收的唯一标准，不得为同一作答临时重拟题或重写 aliases**（Codex 复审确认此论证成立）。
- **ExamSpec 质量门（冻结前确定性 lint，Codex 两轮复审：防作弊 + 防过拟合）**：冻结前必须确定性校验 rubric 健康。
  lint 只拦明显作弊不够（挡不住 LLM 生成的超宽同义词/答案短语塞 alias/题与 artifact 互相过拟合的灰区），故还须：
  - **受限 regex DSL / 白名单语法**：禁 `.*` / 贪婪通配 / 任意回溯——只允许受限匹配原语（防超宽 regex 假命中）。
  - **alias/keypoint 配额上限**：每 keypoint 的 alias 数、alias 长度、单要点权重占比有上限；keypoint 必须有信息量
    （非空泛/非整句答案塞入）；权重分布不得架空（单要点权重 ≤ 阈值）。
  - **holdout / negative cases**：ExamSpec 须自带反例集——「空答案 / 泛答案 / 禁忌答案 / 把答案塞进 alias 的作答」
    **必须判不过**；lint + L3 golden 用这些反例验证 scorer 不被骗（假过率守门）。
  - **一次性主验收**：同一份 frozen ExamSpec **只允许一次主验收作答**（answerHash 绑定）；不得对同一作答反复刷分。
  lint 不过不得冻结。
- **作答（影子内核，零-LLM）**：见 D0.6——用确定性内核作答；冻结 `answerHash` + `coreSnapshotHash`（作答时的影子内核指纹）。
- **评分（确定性 scorer，纯函数，严格规格）**：`ExamScorer` 只用——**确定性文本规范化（按冻结的 normalizer/tokenizer
  版本）+ 精确 alias/regex 匹配 + 结构化字段匹配**——算**加权要点命中率** + 禁忌点检查。
  **≥95 定义** = `weighted keypoint coverage ≥ 0.95 且 forbiddenClaims 命中数 = 0`。
  **禁止**评分时做运行时语义判分 / 调 LLM / 云 embedding 算相似度（那会把 LLM 依赖偷渡回评分层，破铁律 + 不可复现）。
  同一份作答 + 同一 ExamSpec + 同 scorerVersion → 同一分数（可复现、可重放审计）。
  **代价诚实标注**：要点命中是 NLP 近似（确定性匹配非语义全等），L3 实现须谨慎设计 aliases/regex/权重 + 用真实
  题库校准假过/假不过率，必要时多要点冗余降低单点误判——但**绝不**为提升「语义准确」而引入运行时模型依赖。
- 不到 95 → 不合格 → 回 D0.3 补学（老师据失分要点补教）→ 重新验收。连续 N 次不过 → 升人工 / 放弃该能力（治理配置）。

### D0.5 — 知识体系沉淀（接通 dormant consolidation + 薄能力索引）

学到的知识要**消化成结构化体系**，而非扁平记忆：

- **L1 复用现有**：验收通过的知识落 memory（episodic）+ edges；接通 dormant 的 `consolidateAll`
  （episodic→semantic 升华），由**确定性事件**触发（`exam-passed` / `artifact-compiled`），**非随机时钟**。
- **薄能力索引（新）**：新增 `CapabilityIndex` / `LearningRecord` 元数据层（per-persona），记录
  `{ personaId, capability, jobFamily, examScore, artifactIds, memoryIds, learnedAt, teacherVerdicts }`——把
  「学过哪些能力、考了多少分、由哪些 artifact/记忆构成」结构化，供 GapDetector（D0.2）查覆盖、供审计、供
  「同类问题已学过 → 不再请教」的命中判定。**不**新造重型知识图谱——memory+edges+semantic 升华 + 这层薄索引即够。

### D0.6 — 影子内核验收（验收闭环零-LLM 运行时论点）

验收时数字员工用**确定性内核**作答（证明真学会、零-LLM 能答），而非用刚学的临时知识或调 LLM：

- 候选知识 artifact **先临时编译进 shadow core**（影子内核）——复用 K5 的 snapshot/coreSelfOnly 机制：
  对该 persona 内核做快照 → 把候选 artifact 经编译器写入 → 用**确定性内核**（OfflineConversationResponder 等）
  作答考题 → 确定性评分 → **无论过不过都回滚到快照**（shadow 不污染主内核）。
- **rubric 不可见（Codex 复审：防泄漏作弊）**：作答时影子内核**只能看到** `questions`（+ 必要的
  `structuredAnswerFields` 形状提示），**绝不可见** `keypoints` / `aliases` / `regex` / `forbiddenClaims` / 权重 /
  标准答案——否则等于把答案喂给作答方，验收失真。评分（ExamScorer）才用完整 rubric。
- **shadow compile 不绕校验（Codex 复审）**：shadow 阶段写入候选**必须**走与正式编译**同一条** `DistillationService`
  校验链（validate / canAutoCompile / 不确定性预算）的 **dry-run / sandbox 模式**——只是**不推进 artifact 状态、
  不写主内核**。否则不合格 artifact 能先污染影子作答路径（假过）。
- **并发 lease（Codex 复审）**：ADR-0047 的 compile mutex 是**租户级全局**（因 restore snapshot 会覆盖全租户多
  persona 状态——见 [0047](0047-llm-as-distillable-teacher.md)）。shadow 验收期间（快照→shadow 编译→作答→回滚）
  **必须**持有 compatible compile lease，避免 shadow 回滚误伤并发的正式编译或另一个 shadow 验收。
- **副作用完全隔离（Codex 独立复审：最关键）**：回滚主内核**不够**——shadow 阶段**禁止**触发任何**主路径副作用**：
  不发 `artifact-compiled` / `exam-passed` 等正式事件、不推进学习账本(LearningRequestLedger)状态、不写 CapabilityIndex /
  LearningRecord、不触发 consolidation、不更新任何可被运行时读取的 projection / cache、不经 EventBus 外发。shadow 必须是
  **完全 side-effect-isolated 沙箱**（仅写专用 shadow 审计），否则候选虽回滚了主内核，却经事件/索引/缓存/consolidation
  污染主路径（绕过回滚的隐蔽泄漏）。
- **≥95** → 候选 artifact 才**正式**经蒸馏门落主内核（D0.4 → 蒸馏门，此时才发正式事件/写索引/触发 consolidation）。
  **<95** → 丢弃候选，回滚已是快照态。
- 这样验收的是「**确定性内核能不能答**」，闭环了「学会后运行时零-LLM」论点。影子内核**绝不污染主内核**（红线）。

### D0.7 — 向后兼容

- 不改任何现有学习通道行为（`/reflect` / `/perceive` / 文档导入仍可直接用，经蒸馏门）。
- 进修能力是**新增的上层编排**（GapDetector → 互审门 → 影子验收 → 蒸馏门），复用现有蒸馏门 / ModelRouter /
  memory / K5 snapshot，**不动**这些底座的既有语义。
- legacy 单 persona（companion / manager-persona）经 default persona 不受影响（不触发职能进修除非显式接入）。

### D0.8 — 任务连续性：缺口处置 + 学习唤醒重跑（任务不无限干等）

「运行时遇缺口只登记异步学习请求」**不等于**「任务停下来干等到学完」——那会卡死任务、体验极差。关键区分：
「异步」约束的是**运行时关键路径不同步阻塞调 LLM**（保零-LLM 铁律），**不是**「任务必须等学完」。任务是否「等」
取决于**缺口处置策略**，默认**尽量不卡死**——只有「不能委派、不能降级」的硬缺口才挂起，且挂起的是**那一个任务**
（不阻塞组织其他工作 / 其他数字员工）。

**缺口处置策略（优先级，确定性，沿用 org chart / 执行治理）**：
1. **委派**（首选）：缺口能力 X 在组织里有会的同事/上级（workforce org chart 委派链 + ADR-0055 执行治理）→ 委派给会 X 的 worker，
   原任务**继续推进**（换人做，不等）。委派合法性确定性判定（直接下属/能力匹配）。
2. **降级完成**（次选）：用现有确定性内核能力做「保守版 / 部分完成」+ 显式标注「这块待补（缺 X）」→ 任务**有产出**
   （不阻塞交付，缺口异步补）。降级须确定性可解释（哪块降了、为什么），不得静默假装完成（ADR-0055 D 链铁律）。
3. **挂起 + 异步学习**（兜底）：上两者都不行 → 任务进 `pending`，记**全部缺口** `blockedOnCapabilities: string[]`
   （非单个——一个任务可能同时缺 review + compliance）；为每个缺口登记/复用学习请求 → **后台异步学习期**跑
   （在独立学习线程/队列，**不占运行时**，**不阻塞**其他任务/员工）→ 逐个学完，全部清零才唤醒重跑（下条）。

**学完唤醒重跑（「学完马上投入」，多能力 fail-closed，Codex 复审防误唤醒/死循环）**：
- 学习期 ⑤≥95 经蒸馏门落主内核后，发**确定性事件**
  `capability-learned{ tenantId, personaId, capability, learningRecordId, capabilityVersion }`（沿用 ADR-0054
  EventBus 确定性门控纪律，非新推理循环）。
- 该事件把候选 pending 任务的 `blockedOnCapabilities` 中**对应 capability 标记 resolved**（按 `(tenantId, personaId)`
  精确匹配 + fail-closed，红线 15）——**不直接执行**。
- **执行前确定性复检（关键守卫）**：仅当某 pending 任务的 `blockedOnCapabilities` **全部清零**（剩余缺口 = ∅），
  才进入重跑入口；重跑入口**必须再跑一次确定性 GapDetector 复检** remaining gaps——
  - 复检无缺口 → **零-LLM 重跑干完**（内核已覆盖全部所需能力）。**这就是「学完马上投入工作」**。
  - 复检仍有缺口（学的能力与任务实际需要不完全匹配 / 归因过粗 / 新暴露缺口）→ **不假定干完**：保持 pending /
    改委派 / 降级 / 为新缺口登记幂等学习请求（**fail-closed，绝不静默执行**）。
- **防死循环**：pending 任务记 `resumeAttemptCount` + `lastWakeEventId`；唤醒-复检-仍缺-再挂起的循环受
  `resumeAttemptCount` 上限约束，超限 → 走 SLA 兜底（升人工/改委派/标 blocked）。学完后该能力是 persona **自己的
  确定性能力**，后续同类任务零-LLM 不再请教。

**SLA / 超时兜底（防无限挂起）**：
- 挂起任务复用 **workforce 的 `due_at` 时间感知 + ADR-0055 执行治理**——挂起有**学习超时上限**（治理配置）：超时仍未学会（连续验收
  不过 / 老师退回 / 预算耗尽）→ **升级人工 / 改委派 / 标记 `blocked(reason=learning_timeout)`**，**不无限挂起**。
- 学习请求**幂等去重**（红线 9 + L2 账本）：同一 `(personaId, capability)` 的多个挂起任务共享**一次**学习，
  学完一并唤醒（不为每个任务重复请教，防请教风暴）。

**L8 实现期可靠性注意（Codex 复审，非冻结阻塞）**：
- `capabilityVersion` 作为**单调新鲜度守卫**——忽略低于当前 CapabilityIndex 版本的陈旧 `capability-learned` 事件
  （防陈旧/乱序事件误标 resolved）。
- 加**确定性 reconciler**：定期/事件触发从 `LearningRecord`/`CapabilityIndex` **反扫** pending 任务补触发 wake——
  即便 `capability-learned` 事件丢失，任务也不会永久挂起（事件丢失只影响「学完马上投入」的及时性，不造成假完成：
  任务仍 pending + 有学习超时兜底）。

**与铁律的一致性**：委派/降级/挂起判定 + 唤醒重跑全程**零-LLM**（确定性策略 + 确定性事件门控）；唯一的 LLM
出现仍只在后台异步学习期。任务连续性靠**组织机制（委派/降级）+ 异步学习唤醒**实现，**不靠**运行时调 LLM 硬答。

## 红线（MUST，实现各片必须守）

1. **运行时零-LLM**：运行时干活**永不**为答题/执行同步调 LLM；遇缺口只登记学习请求（异步学习期）。LLM 仅学习期出现。
2. **蒸馏门不绕过**：任何老师教学产物**必须**经 `DistillationService`（validate/canAutoCompile/预算/快照/回滚）才进主内核。
3. **缺口发现确定性**：GapDetector 是对既有确定性信号的纯函数门控，**禁止**新增后台 LLM 推理循环判「我会不会」。
4. **验收评分确定性可复现**：ExamSpec（题+要点+禁忌）一次性 LLM 生成后**冻结**；`ExamScorer` 是纯函数命中率，
   **禁止** LLM 现场打分。同作答+同 ExamSpec → 同分。
5. **影子内核作答 + 不污染**：验收用**确定性内核**作答（零-LLM）；候选先进 shadow（K5 snapshot/coreSelfOnly），
   过 95 才正式落主内核；shadow **绝不**污染主内核（无论过不过都回滚）。
6. **双老师独立**：独立性按可审计 independence tuple `{providerId, modelId, baseUrl, apiKeyId, account/orgId}` 判定；
   **至少禁止**同 provider+同 account+同 key 冒充双老师；同 provider 不同 account/key = 弱独立须提高人工/审计要求；
   两者都 approve 且都判职能相关才学。
7. **职能相关性硬绑**：候选知识**必须**先过确定性筛（映射 roleCode/jobFamily/requiredCapabilities），过不了直接退回，
   再由老师判更细价值——**禁止**学与职能无关的偏题知识。
8. **per-persona 全链隔离**：缺口/学习请求/考试/知识沉淀/能力索引全部 per-persona（K5b 已就绪），各员工学进**自己**内核。
9. **学会后不再请教**：同类问题命中已学能力（CapabilityIndex）→ 运行时零-LLM 直接干，**禁止**重复请教同一缺口。
10. **学习预算/节流**：学习请求有 per-persona 预算/速率上限（防请教风暴 / LLM 滥用），复用 ADR-0048 不确定性预算 + 治理配置。
11. **禁忌输入隔离 + 审计可重放**：老师教学/拟题/作答/评分全程留可重放审计（ExamSpec/verdict/score/artifactIds），
    禁忌输入（敏感/越权）隔离不进学习。
12. **shadow dry-run 不绕校验**（Codex 复审）：影子内核编译候选**必须**走与正式编译同一条蒸馏校验链
    （validate/canAutoCompile/预算）的 dry-run 模式——只不推进状态、不写主内核；**禁止** shadow 阶段绕过校验。
13. **shadow / compile lease 互斥**（Codex 复审）：shadow 验收期间必须持 compatible compile lease（ADR-0047 租户级
    全局 mutex），避免 shadow 快照回滚误伤并发的正式编译或另一个 shadow 验收。
14. **scorer 禁语义模型依赖**（Codex 复审）：`ExamScorer` 只用确定性文本规范化 + 精确 alias/regex + 结构化字段匹配；
    **禁止**评分时调 LLM / 云 embedding / 语义相似度。冻结 scorerVersion/normalizerVersion/tokenizerVersion 保可重放。
15. **跨 persona 索引 fail-closed**（Codex 复审）：能力索引 / 学习账本 / 缺口去重的所有查询**必须**带
    `(tenantId, personaId)` 且 fail-closed——查不到归属即拒，**禁止**跨 persona 读到别人的已学能力/学习记录。
16. **rubric 不可见作答**（Codex 复审）：作答方（影子内核）**只**可见 `questions` + 结构化字段形状提示；
    **禁止**作答时可见 keypoints/aliases/regex/forbiddenClaims/权重/标准答案（否则答案泄漏给作答方，验收失真）。
17. **ExamSpec 冻结前 lint + 不可变**（Codex 复审）：ExamSpec 冻结前必须过确定性 rubric lint（禁 `.*`/超宽 regex/
    答案塞 alias/零信息 keypoint/权重异常）；冻结后**不可变**，同一作答**禁止**重拟题/重写 rubric。
18. **shadow 副作用完全隔离**（Codex 独立复审）：影子验收**禁止**触发任何主路径副作用——不发正式事件
    （artifact-compiled/exam-passed）、不推进学习账本、不写 CapabilityIndex/LearningRecord、不触发 consolidation、
    不更新运行时可读的 projection/cache、不经 EventBus 外发。回滚主内核**不等于**隔离——必须完全 sandbox（仅专用 shadow 审计）。
19. **ExamSpec 防过拟合/反作弊**（Codex 独立复审）：regex 用受限 DSL/白名单（禁贪婪通配/回溯）；alias 数/长度/单要点权重
    有上限；ExamSpec 自带 negative cases（空答案/泛答案/禁忌答案/答案塞 alias **必须判不过**）且 L3 golden 验证；
    同一 frozen ExamSpec 只许**一次主验收作答**（answerHash 绑定，不得反复刷分）。
20. **任务连续性 + 唤醒零-LLM + 复检 fail-closed**（D0.8）：遇缺口**优先委派/降级**（确定性），**不**为答题同步调 LLM、
    **不**无限干等；挂起任务记**全部缺口** `blockedOnCapabilities` 进 pending，后台异步学习（不占运行时/不阻塞他人）。
    `capability-learned` 事件只标记对应缺口 resolved，**不直接执行**——任务全部缺口清零后**必须再跑确定性 GapDetector
    复检**，无缺口才零-LLM 重跑；**仍有缺口则 fail-closed**（保持 pending/改委派/降级/登记新学习，**绝不静默执行或假完成**）。
    `resumeAttemptCount` 上限 + 学习超时上限防死循环/无限挂起（超限升人工/改委派/标 blocked）；同 `(personaId, capability)`
    学习幂等去重。委派/降级/挂起/唤醒/复检判定全程零-LLM。

## 分片路线（L0-L8，依赖排序，每片独立 PR + Codex 审 + golden 验证）

```
L0 ADR 冻结（本片，纯规划）：学习模型 + 学习期/运行时边界 + 20 红线 + 分片路线
  │
  ▼
L1 能力分类法 + GapDetector：capability taxonomy（绑 roleCode/jobFamily/requiredCapabilities）
   + 确定性缺口检测（纯函数门控既有信号），输出 LearningRequest
  │
  ▼
L2 学习请求账本（LearningRequestLedger）：缺口 → 登记学习请求（幂等、per-persona、预算/节流、可审计）
  │
  ▼
L3 ExamSpec + 确定性 ExamScorer：考试规格（题+要点+禁忌+权重）数据结构 + 纯函数加权命中率评分（≥95 判定）
  │
  ▼
L4 影子内核验收：复用 K5 snapshot/coreSelfOnly，候选编译进 shadow → 确定性内核作答 → 评分 → 回滚（不污染）
  │
  ▼
L5 双老师互审门：两 teacher route（independence tuple 不冲突）独立产出 verdict + 交叉审 + 确定性职能相关性前置筛（蒸馏门之前）
  │
  ▼
L6 蒸馏门正式接入：验收通过的候选经现有 DistillationService 落主内核 + 记 LearningRecord
  │
  ▼
L7 结构化知识体系沉淀：接通 consolidateAll（确定性事件触发 episodic→semantic）+ CapabilityIndex 元数据层
  │
  ▼
L8 缺口→处置→学习唤醒→重跑闭环（D0.8）+ 端到端验收：遇缺口优先委派/降级、否则挂起后台异步学 →
   capability-learned 唤醒挂起任务零-LLM 重跑 → 学会后同类任务零-LLM 直接干（不再请教）；学习超时兜底
```

| # | 切片 | 前置 | 产出 | 验收要点 | 复杂度 | 风险 | 新 ADR |
|---|---|---|---|---|---|---|---|
| L0 | ADR 冻结 | 无 | 本 ADR（学习模型 + 边界 + 红线 + 路线） | 学习期/运行时边界、20 红线、确定性化设计冻结 | 低 | 中 | 是（本片）|
| L1 | 能力分类法 + GapDetector | L0 | capability taxonomy + 确定性缺口检测 → LearningRequest | 缺口判定纯函数可复现；绑 requiredCapabilities；无 LLM 循环 | 中 | 中 | L0 覆盖 |
| L2 | 学习请求账本 | L1 | LearningRequestLedger（幂等/预算/节流/审计）+ **unknown capability lint/标记**（`!isKnownCapability` 给确定性 warning + LearningRequest 标 unknown，便于人工归并；防 typo 如 'reserch' 污染账本——L1 GapDetector **不**自动猜，留此层确定性处理，Codex L1 复审） | 同缺口幂等不重复请教；per-persona；预算上限 fail-closed；未知能力有 warning/标记不静默 | 中 | 中 | L0 覆盖 |
| L3 | ExamSpec + ExamScorer | L1 | 考试规格（含 scorer/normalizer/tokenizer 版本+aliases/regex+结构化字段+answerHash+冻结前 lint）+ 确定性加权命中率评分 | 同作答+同 ExamSpec+同 scorerVersion→同分；≥95=命中≥0.95 且禁忌=0；**评分无 LLM/embedding**；rubric lint 过才冻结 | 中 | 中高 | L0 覆盖 |
| L4 | 影子内核验收 | L3 | shadow 编译候选（**dry-run 过同蒸馏校验**）→ 确定性内核作答 → 回滚 | shadow 不污染主内核（过/不过都回滚）；作答零-LLM；**持 compile lease**；dry-run 不绕校验 | 高 | 高 | L0 覆盖 |
| L5 ✅ | 双老师互审门（blind 初审 + AND 合并，**完成**） | L1 | 两 teacher route（independence tuple）blind 初审 verdict + 确定性相关性前置筛（绑 requiredCapabilities；role/family 审计上下文）+ 确定性 AND 合并（独立性>相关性>verdict）；fail-closed（老师失败/非法 verdict→reject）；审计 verdict 回传（对齐 L2 由 L6 落库） | 两都 approve 才学；independence tuple 不冲突（禁同 apiKeyId / 同 provider+account+model）；偏题前置退回不调 LLM | 中高 | 中高 | L0 覆盖 |
| L5b | 交叉审第二轮（后续） | L5 | verdict 固化后让每位老师再审对方教学内容草案（额外鲁棒层，ADR D0.3 第二轮）；可选 role→capability 确定性 registry | 交叉审分歧可观测；伪共识进一步降低 | 中 | 中 | L0 覆盖 |
| L6 ✅ | 蒸馏门正式接入（端到端编排，**完成**） | L4,L5 | LearningOrchestratorL6 串 L5 互审→L4 验收→**蒸馏门 DistillationService.ingest 正式落主内核**→L2 账本推进 pending→learning→passed/failed（CAS）→发 capability-learned（供 L8 唤醒）；确定性绑定校验 examSpec.capability=账本 capability（防错题误判 learned，Codex L6 复审）；监听器异常隔离（已提交不翻转结局）；LearningRecord = L2 passed 行（L7 正式化 CapabilityIndex 前的习得记录来源） | 不绕蒸馏门（同 validateArtifact/编译门）；落各自 persona；运行时零-LLM（LLM 只在 L5 老师审）；任一阶段退回置 failed 释放幂等槽；审计留痕 | 中 | 中 | L0 覆盖 |
| L7 ✅ | 知识体系沉淀（CapabilityIndex，**完成**；Part A 撤回） | L6 | **Part A 撤回**：原写「接通 dormant consolidateAll」是笔误——consolidateAll **早已在生产接通**（avatar-autorun runCognitionCycle + /memories 路由都在调，已发 core:memory-consolidated），造冗余触发器=过度设计（Codex 复审确认事实+撤回正确）。**Part B 实现**：capability_index 薄元数据层（迁移 v109/pg v111）+ CapabilityIndexStore（upsert ON CONFLICT/listLearnedCapabilities/getByCapability）+ CapabilityIndexProjector（订阅 capability-learned → 确定性投影；失败隔离+tenantId-drop）+ LearningRequestService.listLearnedCapabilities 迁移为「索引 ∪ L2 passed 兜底」（向后兼容，不引入假阳性）；新租户表全触点注册（隔离集+GDPR A 类） | 已学能力 O(索引)可查覆盖（替代 L2 status 全表扫）；投影 fail-safe（只 L6 落核后写，滞后只致重登记安全方向）；per-persona；零-LLM（事件投影确定性）；真闭环（L6 落核→投影→GapDetector 不再当缺口） | 中高 | 中 | L0 覆盖 |
| L8 | 缺口→处置→学习唤醒→重跑闭环（D0.8） | L2,L6,L7 | 缺口处置（委派/降级/挂起）+ pending 任务 blockedOnCapabilities 扩展 + capability-learned 唤醒（标记 resolved，非直接执行）+ **重跑前 GapDetector 复检** + 零-LLM 重跑 + resumeAttemptCount/学习超时兜底 + wake 幂等 | 任务不无限干等（优先委派/降级）；多能力缺口全清零才重跑；复检仍缺则 fail-closed（不误唤醒/不假完成）；超时升人工/改委派；resumeAttemptCount 防死循环；同能力学习幂等去重 | 中高 | 中 | L0 覆盖 |

### 可并行（很少）
- L0 后 L1（能力分类/缺口）与 L3（考试规格/评分）可局部并行（前者信号源、后者验收器，弱耦合）；L3 可先用 fixture 起步。
- L4 影子验收依赖 L3 评分器；L6 依赖 L4+L5；L8 是总闭环依赖 L2/L6/L7。
- L5 双老师互审的审计/幂等**须对齐 L2 LearningRequestLedger**（verdict/teacher 调用记同一账本，幂等键复用学习请求 id），
  避免 L5 自建一套账本与 L2 漂移（Codex 独立复审）。

## Consequences（影响）

**正面**：
- 「数字员工像人类进修」真正成立——上岗遇不会的就去（异步）请教双老师、考过 95 才算学会、沉淀进自己的知识体系，
  下次零-LLM 直接干。
- 学习**按职能定向**（绑 requiredCapabilities），researcher 与 reviewer 学不同的东西；**自主发现**缺口，不靠人写大纲。
- 双老师互审 + 确定性验收 + 影子内核，把「LLM 进修」与「零-LLM 运行时」的张力**机制性**化解——铁律完整保住。
- 知识从扁平记忆升级为结构化能力体系，可审计「这个员工会什么、怎么学会的」。

**负面/代价**：
- 多切片、高风险（动认知核心学习路径 + 影子内核 + 双 LLM 编排）。每片必须独立可审、可回滚、向后兼容。
- 学习期引入 LLM 成本（双老师 + 拟题）——靠 per-persona 学习预算/节流 + 缺口幂等控制。
- ExamSpec/确定性评分的「要点命中率」是近似（NLP 命中非语义全等）——L3 需谨慎设计 aliases/权重，避免假过/假不过。

## 冻结声明

L0（本 ADR）完成即**冻结**：学习期/运行时边界、缺口发现确定性纪律（含 retrieval/归因确定性来源约束）、
双老师互审门位置（蒸馏门之前）+ 独立性（blind 初审）、ExamSpec 冻结 + 确定性评分（scorer 无语义模型依赖）、
影子内核验收（dry-run 过同蒸馏校验 + compile lease）、知识体系沉淀方式、**任务连续性（缺口处置 + 学习唤醒零-LLM
重跑，D0.8）**、**20 红线**、L1-L8 分片路线。
后续各片在此框架内实现，不得各自发明学习语义或绕过红线；如某片需偏离需追 amendment。
