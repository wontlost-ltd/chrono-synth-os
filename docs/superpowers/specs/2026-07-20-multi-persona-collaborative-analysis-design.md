# 多数字人协同分析框架设计

> 状态：第 3 轮修订 + 3.1 校正（采纳 Codex 76/100 8 项 → Codex 再审 86/100 又退 2 项，均核验真实代码后修）。待 Codex 确认 → 用户审阅 → writing-plans。
> 日期：2026-07-20
> 关联 ADR：0047（零-LLM 内核 / LLM-as-teacher）、0056（per-persona 内核）、0055（数字员工组织 / 策略辅助）。

> **第 3.1 轮校正（采纳 Codex 86/100 再审的 2 项定稿修正 + 2 项非阻塞注意）**——第 3 轮的 2 处仍不准，核验代码后修：
> - **排序归因再校正**：第 3 轮说「constraints 没接」**仍不全对**。`rule-engine.ts:196` 有**第二套** `computeConstraintPenalty(alternative, decisionCase.constraints)`（与 structural-scorer 那套 anchors×violations 不同函数），**若传 `decisionCase.constraints` 会逐候选扣分改排序**。正确结论：排序由 **L1 alignmentScore + （若传）decisionCase.constraints** 驱动；rules 确认 inert（`compilePersonaState` 无 rules 字段，`persona.rules` undefined）。**首版设计选择：DecisionCase 不传 constraints → 排序只由 L1 驱动**（是设计选择，非代码唯一可能）。
> - **错误码不可区分 NotFound/Forbidden**：`getPersonaDetail` 对 {不存在/他 owner/跨租户} **统一 null**（不可区分）；且返回 Forbidden 会**泄露跨租户存在性**。改为**统一拒 `PersonaUnavailable`（等价 404）**，不区分、不泄露。
> - 非阻塞：① 显式 `isAssociation ?? false → evidence.association`；② `readonly BehaviorBoundary[]` 传 responder 可变参前复制/统一 readonly。

> **第 3 轮修订（采纳 Codex 76/100 定稿级退回 8 项，逐项核验真实代码）**：
> 1. **boundaries 来源**：不在 core（`CoreRhythmLayer.getState()`/compilePersonaState 只 L0-L4 无 boundaries）——照 `conversation-service.ts:600-610` 从 `getPersonaDetail().profile.behaviorBoundaries` 取，由 service 注入 analyzer（§5.1/§5.3）。
> 2. **删「rules 驱动排序」**：核验 `structural-scorer.ts` 公式 + `compilePersonaState` 只取 L0-L4 不注入 RuleStore——**相对排序实际只由 L1 值（alignmentScore）驱动**，constraints（源恒空 violations）/rules（根本没接）两说都错，全文改正；若要 rules 真参与列为 kernel 独立 wiring（范围外）（§2/§3）。
> 3. **keyPoints 只来自 grounded 证据**：不含 alternatives（同组候选跨 persona 必重合造伪话题），只从 evidence.excerpt tokenize（§5.1）。
> 4. **PersonaPerspective 加结构化 evidence**：`{ memoryId, excerpt, relevance, association }[]`，供 keyPoints 提取 + evidenceBrief 可追溯（§5.1）。
> 5. **status 统一判据**：只两态，门槛 = grounded 视角数 G；G===0→insufficient_grounding、G≥1→analyzed，「多数不足」经 groundingNote 表达（不用 status 兼表）（§5.2）。
> 6. **未知/跨租户 persona 一律拒**：`getCore(personaId)` 对任意字符串新建空 core（`chrono-synth-os.ts:446` 无校验）——须先 `getPersonaDetail(tenantId, ownerUserId, personaId)` 校验存在+归属，查不到即拒，绝不静默产空内核视角（§5.3/§7）。
> 7. **单 persona 由 service 降级**（不在端点特判）：降级语义收敛一处（§5.3/§5.4）。
> 8. **groundedCount→retrievedCount**：responder 内部会再过滤，检索数≠采用数，命名如实（§5.1）。

> **第 2 轮修订（采纳 Codex 独立复审）**——核验真实代码后修正初版基于探针摘要的臆造/夸大：
> ① **契约错配**：`OfflineResponse` 只有 `{content, kind, ...}`，**无 groundedCount**、**不消费 rankedOptions**；`OfflineResponderInput.boundaries` **必填**。初版说「responder 组织检索+打分成意见」不成立——responder 不消费决策排序，groundedCount 须 analyzer 自算。
> ② **零-LLM 不闭合**：`ConversationKnowledgeRetriever` 注入 embedding provider 会 `provider.embed()`——**非天然零-LLM**。首版**只用 `retrieveMemoriesDeterministic`**（纯关键词+图遍历），类型层禁 embedding provider。
> ③ **卖点收窄（第 3 轮再校正——采纳 Codex：rule-engine 有第二套 constraints 路径）**：核验 `rule-engine.ts:evaluateDecisionCase` 完整打分链：每候选 `structural.overallScore`（来自 `structural-scorer.ts` 公式 `alignmentScore(L1) − constraintPenalty(anchors×violations) − stylePenalty(riskScore×L2) + cognitiveBias(riskScore×L3)`）**再减** `computeConstraintPenalty(alternative, decisionCase.constraints)`（`rule-engine.ts:196`，**第二套 constraints，与 structural-scorer 那套 anchors×violations 是不同函数**）**再经** `applyRuleAdjustment(..., persona.rules)`（`rule-engine.ts:198`）。逐字段判定：
> - **L0**：`violations:[]` 恒空（`rule-engine.ts:183/189`）→ structural constraintPenalty 恒 0 → **不参与**。
> - **L2/L3**：`riskScore=0.5` 恒定 → stylePenalty/cognitiveBias 对**同一 persona 的每个候选同值** → **只整体平移、不改相对次序**。
> - **rules**：`persona.rules` 来自 `compilePersonaState(core)` 返回的 `PersonaOSState`（`persona-state.ts:14-24` 只 L0-L4，**无 rules 字段**）；`RuleEnginePersonaState.rules` 是**可选**（`rule-engine.ts:30`），运行时为 `undefined` → `applyRuleAdjustment` **inert（不生效）**。
> - **L1 alignmentScore**：与候选文本关键词匹配，**逐候选变化 → 改排序**。
> - **`decisionCase.constraints`**：`computeConstraintPenalty` **确实生效**（`rule-engine.ts:109-117`：非空即逐候选扣分）——**若本能力构造 DecisionCase 时传了 constraints，也会改排序**。
> 
> **故正确结论**：相对排序由 **① L1 alignmentScore ② （若传）decisionCase.constraints** 两者驱动；L0/L2/L3/rules 现状均不改相对次序。**本能力首版决定：构造 DecisionCase 时 `constraints` 留空**（候选仅 alternatives 文本，无额外硬约束）→ 首版排序**只由 L1 驱动**（这是「首版设计选择」不是「代码只能这样」）。若将来传 constraints，须在 spec/文档同步说明排序多一维。初版及第 2 轮「排序来自 L1 + constraints + rules」的错在：把 structural 那套恒 0 的 constraint 当成生效、且漏了 rule-engine 第二套真生效的 constraints、又把 rules 说成生效——**三处措辞都不准**，本轮全部校正。若要 L0/L2/L3/rules 真参与，须先改 kernel rule-engine（本 spec 范围外，列为独立 wiring）。
> ④ **命名夸大**：关键词重叠只能做「**共同话题**」不能证「观点共识」（支持 vs 反对关键词高度重合却是分歧）；确定性拼装只能出「**证据摘要/decision brief**」不能称「综合建议」（不产生新综合观点）。全文改名。
> ⑤ **归因错误**：persona 内核解析是 `TenantOSFactory.getTenantOS(tenantId).getCore(personaId)`（factory 无 persona 参数）。
> ⑥ **补边界**：boundary_block/escalate kinds、单/零/未知/跨租户/重复 persona、全 honest_offline→`insufficient_grounding`、honest_offline 排除出话题计算、`requiresHumanApproval` 入数据契约。

## 1. 目标（一句话）

让**多个数字人**（各有独立学习背景 + 价值内核）就同一个问题各自基于**自己学到的内容**给出 grounded 视角（+ 对人类给定候选方案的可审计排序），再**确定性汇总**成一份带「**共同话题 / 排序分歧 / 各视角证据摘要**」的参考报告——全程运行时零-LLM。**诚实边界**：这是「多个已蒸馏内核的检索差异 + 证据聚合」，**不是**运行时语义理解/论证比较/新观点综合（那需 LLM，违铁律）。专业度 = 各 persona **学习期蒸馏的深度**。

## 2. 架构（可插拔多模式框架，首切「多视角汇聚」）

**核心洞察**：单 persona 分析的**三段基元全已存在且零-LLM**（检索 / 决策打分 / 组织成文；关联 association 是检索的一部分）。本能力的新增部分只是**「对多个 persona 各跑一遍 + 汇聚多视角」的编排薄壳**，不引入任何运行时 LLM。

```
① 发起：分析问题 question（+ 可选候选方案 alternatives[]）+ 参与的 persona 列表
② 每个 persona 独立分析（全零-LLM）：
   · retrieveMemoriesDeterministic（**仅此**，纯关键词+图遍历零-LLM；不用会调 embedding 的 ConversationKnowledgeRetriever）
       —— 检索该 persona 学到的相关记忆（各 persona 学的不同→检索不同=差异化主要来源）
   · （带 alternatives 时）AutonomousDecisionEngine.evaluateAutonomous（该 persona 的 core）
       —— 给候选打分排序。**诚实**：现状 violations=[]→structural constraintPenalty 恒 0（L0 不参与）、riskScore=0.5→
          stylePenalty/cognitiveBias 对每候选同值（L2/L3 对相对次序无差别）、compilePersonaState 不注入 rules（inert）；
          逐候选变化的是 ① L1 alignmentScore ② decisionCase.constraints（rule-engine.ts:196 第二套 constraints，若传则生效）。
          **首版设计选择：构造 DecisionCase 时不传 constraints** → **相对排序只由 L1 值关键词（alignmentScore）驱动**——
          故不同 persona 若 L1 值不同→可能不同排序。（若要 L0/L2/L3/rules 真参与须先改 kernel rule-engine，范围外。）
   · OfflineConversationResponder.respond({ narrative, boundaries, userInput:question, relevantKnowledge })
       —— 把 narrative + 检索到的记忆组织成 grounded 视角文本。**responder 不消费打分**；rankedAlternatives 由 analyzer
          单独从 evaluateAutonomous 结果映射进 PersonaPerspective（与 opinion 文本并列，不混入）。
③ 汇总（确定性，CollaborationMode 策略）：
   MultiPerspectiveAggregation.aggregate(perspectives[]) → CollaborativeReport
   · 共同话题（非「共识」）：多 persona 都提到的关键词点（重叠系数）——只证「共同关注」不证「观点一致」
   · 排序分歧（带 alternatives 时的强信号）：同一候选被不同 persona 排到相反位置（A 第一 vs B 末位）
   · honest_offline 的 persona **排除出话题/排序计算**（不让离线套话形成伪话题）
④ 产出：CollaborativeReport —— 每 persona 视角+证据引用 + 共同话题 + 排序分歧 + 确定性证据摘要（decision brief，非新综合观点）+ 充分性/边界说明 + requiresHumanApproval
```

## 3. 技术栈

Node.js + TypeScript。复用（现成基元）：
- **检索（仅零-LLM 路径）**：`src/conversation/deterministic-memory-retrieval.ts`（`retrieveMemoriesDeterministic`——纯关键词+图遍历，无 embedding/无 provider）。**不用** `ConversationKnowledgeRetriever`（它注入 embedding provider 会 `provider.embed()`，非零-LLM）。可用其导出的 `tokenize` 做 keyPoints 提取（纯函数）。
- `src/intelligence/decision-engine.ts`（`AutonomousDecisionEngine.evaluateAutonomous`——ADR-0047 F8 窄接口，只确定性不触发 LLM，已核实无 growth 分支；`evaluateAutonomous(decisionCase, options?): DecisionResult`）。**诚实（打分链逐字段核验）**：`evaluateAutonomous`→`ruleEngine.evaluate(decisionCase, compilePersonaState(core))`。kernel `rule-engine.ts:evaluateDecisionCase` 对每候选：`structural.overallScore`（`structural-scorer.ts`：alignmentScore(L1) − 恒 0 的 anchors×violations penalty − riskScore=0.5 固定的 stylePenalty/cognitiveBias）**再减** `computeConstraintPenalty(alternative, decisionCase.constraints)`（`rule-engine.ts:196`，第二套 constraints）**再经** `applyRuleAdjustment(..., persona.rules)`（`:198`）。因 violations=[] → L0 不参与；riskScore 固定 → L2/L3 每候选同值不改次序；`compilePersonaState` 返回 `PersonaOSState` 只 L0-L4（`persona-state.ts:14-24` 无 rules）→ `persona.rules` undefined → applyRuleAdjustment inert。**逐候选变化的是 L1 alignmentScore 与（若传的）decisionCase.constraints**。**本能力首版构造 DecisionCase 时不传 constraints → 排序只由 L1 驱动**（首版设计选择，非代码唯一可能；见 §2/§5.1）。
- `src/conversation/offline-conversation-responder.ts`（`OfflineConversationResponder.respond(input): OfflineResponse`——input `boundaries` 必填；返回 `{content, kind}`，**无 groundedCount**）。
- **persona 内核解析**：`TenantOSFactory.getTenantOS(tenantId)`（`src/multi-tenant/tenant-os-factory.ts`，只 tenant 参数）→ `.getCore(personaId)`（`src/chrono-synth-os.ts`，ADR-0056 per-persona core 按需建+缓存）。
- 参照 `src/workforce/strategy-advisory-service.ts`（同款「确定性多 lens 重排 + `requiresHumanApproval:true`」输出形态范式）。

## 4. 全局约束（每个实现任务隐含遵守）

1. **运行时零-LLM 铁律（ADR-0047）**：整条协同分析链**不得调用 LLM**。每 persona 分析走的三段基元都是零-LLM（decision-engine 用 `evaluateAutonomous` 窄接口）；汇聚是确定性关键词归类/排序，**不得**用 LLM 现综合新观点。LLM 只在各 persona 的**学习期**当老师（既有 perception/learn 路径），本能力不碰。
2. **per-persona 隔离（ADR-0056）**：每个 persona 用**自己的**内核（记忆/值/决策风格/认知模型）分析——经 `factory.getTenantOS(tenantId).getCore(personaId)` 解析各自 core（factory 无 persona 参数，persona 解析在 getCore）。A 的记忆不串进 B 的分析。跨 persona 只在**汇总层**读各自产出的视角（视角是分析结果，非 core 内部）。
3. **grounded 不编造**：每 persona 视角基于其检索到的记忆（`knowledge_grounded`）；无相关记忆→该 persona 诚实报（`honest_offline`），不瞎给意见。汇总如实反映——honest_offline/boundary perspective **排除出话题计算**；全部/多数无积累→`status='insufficient_grounding'`/groundingNote 显式说明「参与者对此问题积累不足」，**而非用离线套话拼出伪共同话题**。
4. **CollaborationMode 可插拔**：`CollaborationMode` 接口 + `MultiPerspectiveAggregation` 首个实现。角色分工 / 辩论共识后续各加实现，编排壳不变。
5. **能力边界诚实标注**：产出的专业度 = 各 persona **学习期蒸馏的深度**，非运行时现场推理新洞见。报告/文档须明确这一点，不夸大为「AI 现场专业推理」。
6. **人工性质**：协同报告是**建议/参考**，非自动执行（延续 strategy-advisory 的 requiresHumanApproval 精神——若报告含可执行动作，标注需人工采纳，不自动触发）。
7. **新表双登记**（若持久化分析会话）：登记进 `tenant-database.ts` `TENANT_TABLES` + `privacy-service.ts`；迁移同步 schema-dsl 全部同步点（见 memory `schema-dsl-migration-sync-points` + `merge-gate-must-run-test-golden`）。

## 5. 组件设计

### 5.1 `PersonaPerspectiveAnalyzer`（单 persona 分析，复用三段基元）

**文件（新建）**：`src/collaboration/persona-perspective-analyzer.ts`

```typescript
export interface AnalysisRequest {
  question: string;
  alternatives?: readonly string[];  // 可选候选方案（有则走决策引擎打分）
}
export interface PerspectiveEvidence {  // 结构化证据引用（供 evidenceBrief 可追溯，非仅复述 opinion）
  memoryId: string;
  excerpt: string;                    // content 片段
  relevance: number;
  association: boolean;               // 直接命中 vs 图遍历联想
}
export interface PersonaPerspective {
  personaId: string;
  opinion: string;                    // OfflineResponder.respond 的 content（grounded 视角文本）
  kind: 'knowledge_grounded' | 'honest_offline' | 'boundary_block' | 'boundary_escalate';  // = OfflineResponseKind 全集，不丢边界语义
  retrievedCount: number;             // analyzer 自算 = 检索到并喂进 responder 的 relevantKnowledge 条数（responder 会再过滤，故命名 retrieved 非 grounded，避免误指「实际采用」）
  evidence: readonly PerspectiveEvidence[];  // 检索到的结构化证据（memoryId/excerpt/relevance/association），供 keyPoints 提取 + evidenceBrief 引用
  keyPoints: readonly string[];       // analyzer **仅从 evidence 的 excerpt** 提取（tokenize + 剥样板前缀）——**不含 alternatives**（同组候选跨 persona 天然重合会造伪话题）、不从 opinion 展示文本提取（避免 narrative/mood/离线套话噪音）
  rankedAlternatives?: readonly { alternative: string; score: number; rank: number }[];  // 带 alternatives 时 evaluateAutonomous 的排序（与 opinion 并列，不混入 opinion，不进 keyPoints）
}
export class PersonaPerspectiveAnalyzer {
  constructor(deps: { retriever: DeterministicRetriever; decisionEngine: AutonomousDecisionEngine; responder: OfflineConversationResponder; core; boundaries: readonly BehaviorBoundary[] });  // retriever 类型层禁 embedding provider（零-LLM 闭合）；boundaries 由编排层从 persona profile 取后注入（见 5.3）
  analyze(personaId: string, req: AnalysisRequest): PersonaPerspective;  // 全零-LLM 同步/确定性
}
```
- 检索：`retrieveMemoriesDeterministic(question, personaMemories, edgesFor, params, contentFor)` → `RelevantKnowledge[]`（`conversation-types.ts:24-32`：`{id, title, content, relevance, isAssociation?}`）→ **显式映射** evidence：`memoryId=k.id`、`excerpt=k.content`（截片段）、`relevance=k.relevance`、`association = k.isAssociation ?? false`（Codex 非阻塞注意点：显式落 `isAssociation → association`，缺省当 false）。**只此路径**（不注入 embedding provider）。
- 打分（带 alternatives）：构造 `DecisionCase`（alternatives 作候选，**`constraints` 首版留空**——留空则排序只由 L1 alignmentScore 驱动；若传 constraints 会多一维扣分，见 §2/§3）→ `evaluateAutonomous` → rankedOptions 映射 rankedAlternatives。
- 组织：`responder.respond({ narrative, boundaries, userInput: question, relevantKnowledge })` → `{content, kind}` → opinion=content、kind 原样透传（含 boundary kinds）。**responder 不接 rankedAlternatives**——排序另存。**类型注意（Codex 非阻塞）**：analyzer 构造参数 `boundaries: readonly BehaviorBoundary[]`，若 `OfflineResponderInput.boundaries` 是可变 `BehaviorBoundary[]`，传入前复制（`[...boundaries]`）或统一为 readonly，避免只读→可变的类型不匹配。
- retrievedCount：检索并喂进 responder 的条数（responder 内部会按 relevance 再过滤+限量，故不叫 grounded/actual，命名如实）。
- keyPoints：**仅从 evidence.excerpt** 用 `tokenize` 提取 + 剥样板前缀（照 memory `companion-associative-memory`）。**不含 alternatives**（Codex 复审：同组候选跨 persona 必重合→伪话题；排序分歧已由 rankingDivergences 独立表达）。honest_offline/boundary perspective **不产 keyPoints**（不进汇总话题计算）。

### 5.2 `CollaborationMode` 策略接口 + `MultiPerspectiveAggregation`

**文件（新建）**：`src/collaboration/collaboration-mode.ts`（接口）+ `src/collaboration/modes/multi-perspective-aggregation.ts`（首实现）

```typescript
export interface CollaborationMode {
  readonly modeId: string;  // 'multi_perspective'
  aggregate(question: string, perspectives: readonly PersonaPerspective[]): CollaborativeReport;
}
export interface CollaborativeReport {
  question: string;
  modeId: string;
  status: 'analyzed' | 'insufficient_grounding';       // 唯一门槛=grounded 视角数 G：G===0→insufficient_grounding，G≥1→analyzed（细粒度经 groundingNote，见下）
  perspectives: readonly PersonaPerspective[];          // 各 persona 视角（原样保留，可追溯，含 boundary kinds）
  commonTopics: readonly { topic: string; raisedBy: readonly string[] }[];   // 多 persona 共同**关注的话题**（非「观点共识」）
  rankingDivergences: readonly { alternative: string; rankings: readonly { personaId: string; rank: number }[] }[];  // 同一候选被排到不同/相反位置（带 alternatives 时）
  evidenceBrief: string;                                // 确定性**证据摘要**（decision brief）：列共同话题+排序分歧+各视角证据引用，纯模板拼装，**明确不产生新综合观点**
  groundingNote: string;                               // 能力边界/积累充分性说明（约束 3/5）
  requiresHumanApproval: true;                          // 报告是参考，含动作须人工采纳（约束 6，入数据契约非仅 prose）
}
```
- **commonTopics 判定（确定性）**：只对 `kind==='knowledge_grounded'` 的 perspective 的 keyPoints 做关键词重叠（honest_offline/boundary 排除）；重叠系数（非 Jaccard，照 memory `companion-associative-memory`）≥ 阈值 = 共同话题（记 raisedBy）。**诚实命名**：这是「共同**关注的话题**」，不是「观点共识」——关键词重叠证明不了立场一致（「支持扩投」vs「反对扩投」话题重合却对立）。具体阈值 + keyPoints 提取启发式在 writing-plans/Task 定义并测。
- **rankingDivergences（带 alternatives 时的强信号）**：同一 alternative 被不同 persona 的 rankedAlternatives 排到不同位置——这是**可审计的结构化分歧信号**（比关键词可靠）。列出每候选各 persona 的 rank，相反排序（一个排首、一个排末）显式标注。
- **evidenceBrief（确定性拼装，非 LLM，非新综合）**：模板拼装——列共同话题（多视角关注=值得注意）+ 排序分歧（供人工权衡）+ 各 persona 的 grounded 证据引用。**不生成新观点/新结论**，只是把已有证据结构化呈现供人工决策（Codex 复审要求：不称「综合建议」）。
- **status / groundingNote（统一判据）**：唯一门槛 = **有几个 `kind==='knowledge_grounded'` 的 perspective**（下称 grounded 视角数 G；honest_offline/boundary 不计入）。
  - **G === 0**（无任一 grounded 视角）→ `status='insufficient_grounding'`、commonTopics/rankingDivergences 空、groundingNote 明确「参与者对此问题均无相关积累」。
  - **G ≥ 1** → `status='analyzed'`（**只要有一个视角有据即算已分析**，避免「多数离线就整体判失败」误伤那个真有据的视角）。
    - `G < 参与者半数` → groundingNote 追加「多数参与者积累不足，仅 G 个视角有依据」。
    - 否则 → groundingNote「基于 N 位数字人各自学习积累（G 个视角有据）」。
  - 即 status 只有两态，边界不足的细粒度全部经 groundingNote 表达（Codex 复审：状态与文字分层，别用 status 兼表「多数不足」）。
- **单/零 persona**：**端点不特判**——一律交本层（约束校验 + 单视角降级都在 service/mode，见 5.3）。零 grounded 走上面 insufficient_grounding；单 persona 亦正常产报告（commonTopics/rankingDivergences 天然空，groundingNote 说明「仅一位参与者，无跨视角对比」）。

### 5.3 `CollaborativeAnalysisService`（编排）

**文件（新建）**：`src/collaboration/collaborative-analysis-service.ts`

```typescript
export class CollaborativeAnalysisService {
  constructor(deps: { factory: TenantOSFactory; personaCoreService: PersonaCoreService; mode: CollaborationMode; });
  analyze(tenantId: string, ownerUserId: string, personaIds: readonly string[], req: AnalysisRequest): CollaborativeReport;
}
```
- **入参校验（先做，fail-closed）**：personaIds 空 → 拒（ValidationError）；重复 → 去重（保序）。**每个 personaId 必须先经 `personaCoreService.getPersonaDetail(tenantId, ownerUserId, personaId)` 校验存在 + 归属**——因为 `getCore(personaId)` 对**任意字符串**都会新建一个空 core（`chrono-synth-os.ts:446` 无校验），未知/跨租户 personaId 若直接 getCore 会静默产出「空内核视角」而非报错。**错误码（采纳 Codex 第 3 轮）**：`getPersonaDetail` 对 {不存在 / 属他 owner / 属他租户} **统一返回 `null`**（`persona-core-service.ts:627` `!base → null`；查询按 tenantId+ownerUserId 过滤）——**无法也不应区分 NotFound 与 Forbidden**：若对跨租户返回 Forbidden 会**泄露该 persona 在别处存在**（跨租户存在性泄露）。故任一 personaId `getPersonaDetail===null` → **统一拒为 `PersonaUnavailable`（等价 404，不透露它是否在别处存在）**，绝不跳过静默、绝不返回可区分的 Forbidden。**拒绝须发生在 `getCore` 之前**（先全量校验通过再解析 core，避免为无效 persona 建空 core）。
- **boundaries 来源（修正）**：`boundaries` **不在 core**（`CoreRhythmLayer.getState()` 无 boundaries；compilePersonaState 只 L0-L4）——照 `conversation-service.ts:600-610` 的真实路径，从 `getPersonaDetail(...).profile.behaviorBoundaries` 取（`filter(isValidBoundary)`），注入 analyzer 的 `boundaries` 构造参数。
- **persona 解析（修正路径）**：校验通过后 `const os = factory.getTenantOS(tenantId)`（factory 只 tenant 参数）→ 对每个 personaId：`const core = os.getCore(personaId)`（ADR-0056 per-persona core）→ 从 core 拿 memories/edges/decisionStyle/L0-L3/narrative（boundaries 来自上面的 getPersonaDetail，非 core）→ 构造 `PersonaPerspectiveAnalyzer`（retriever 绑其 memory store、decisionEngine 绑其 core、responder 得其 narrative + 注入 boundaries）→ `analyze`。
- **单 persona 由本层降级（不在端点判）**：personaIds 长度 1 时正常执行、产单视角报告（mode 天然出空 commonTopics/rankingDivergences + groundingNote 说明），**不**在端点做「单 persona 走别的路」的特判——降级语义收敛在 service/mode 一处（Codex 复审）。
- 收集全部 PersonaPerspective → `mode.aggregate(question, perspectives)` → CollaborativeReport。
- **per-persona 隔离**（约束 2）：每 persona 用**自己 core** 的 memory/edges 检索——A 的记忆不进 B 的 analyzer；编排层只聚合各自产出的 perspective（视角是分析结果，非 core 内部）。

### 5.4 端点

**文件（新建）**：`src/server/routes/collaboration.ts`（或并入 companion，按注册惯例）
- `POST /api/v1/collaboration/analyze`，body `{ question, alternatives?, personaIds }` → CollaborativeReport。
- 鉴权/租户隔离照既有路由骨架：从鉴权上下文取 `tenantId` + `ownerUserId`，与 body 一起传 `service.analyze(tenantId, ownerUserId, personaIds, req)`。**存在/归属/跨租户校验、单 persona 降级全在 service**（约束校验不在端点重复实现，端点只做 body schema 校验 + 传参）。
- 首版 personaIds 由调用方指定（如「让 explorer + guardian + analyst 三个原型分析」）。

## 6. 数据模型

首版**可不持久化**（分析是即时计算，报告返回即用）——最简。若需留存分析历史（审计/复看），新表 `collaborative_analyses`（id/tenant_id/question/mode_id/report_json/created_at），双登记（约束 7）。**首版决定：不持久化**（YAGNI；留存作后续增强）。故本 spec 无迁移。

## 7. 可验证性

- **多视角真不同（收窄到可验的）**：seed 两个 persona 学**不同内容** → 同问题分析 → 断言两 opinion 不同、keyPoints 不同、evidence 的 memoryId 集不相交（**差异化主要来自各自检索到不同记忆**——这是可靠的）。**排序差异**：构造两 persona **L1 值不同**（非仅原型标签、非 rules——现状 rules inert，见 §2/§3），且 **DecisionCase 不传 constraints**（首版）→ 断言 rankedAlternatives 次序不同（由 L1 alignmentScore 驱动）；**不断言「仅靠 explorer/guardian 原型标签就产生不同排序」**、**不断言 L0/L2/L3/rules 驱动排序**（现状恒空 violations + 固定 riskScore + rules inert，见约束/§2 诚实说明）。
- **零-LLM**：整条 analyze 不注入 LLM provider 也能跑（纯确定性，retriever 类型层无 embedding provider）；同输入同输出（无 Date.now/random）。
- **共同话题正确**：构造两 knowledge_grounded persona keyPoints 重叠同一话题 → 断言进 commonTopics + raisedBy 含两者；honest_offline persona 的套话 → **不**进 commonTopics。
- **排序分歧**：带 alternatives，两 persona 把同一候选排到相反位 → 断言进 rankingDivergences。
- **grounded 诚实（统一判据 G=grounded 视角数）**：无相关记忆 persona → honest_offline 且不产 keyPoints/evidence；**G===0**（无任一 grounded）→ status=insufficient_grounding、commonTopics/rankingDivergences 空；**G≥1 但 < 半数** → status=analyzed 且 groundingNote 标「仅 G 个视角有据」；**G≥1 即 analyzed**（有一个有据就不整体判失败）。
- **per-persona 隔离**：A 的记忆（memoryId）不出现在 B 的 perspective.evidence（B 只用自己 `os.getCore(B)` 的 memory store 检索）。
- **入参校验**：未知 / 属他 owner / 跨租户 personaId → service **统一拒为 `PersonaUnavailable`**（getPersonaDetail 返回 null，不可区分且区分会泄露跨租户存在性）**而非**静默产空内核视角；断言拒绝发生在 getCore 之前（未为无效 persona 建 core——可断言 `listPersonaCores()` 不含被拒 persona）；空 personaIds → ValidationError；重复 → 去重。
- **evidence 映射**：`isAssociation===true` 的记忆 → evidence.association=true；缺省 → false。
- **单 persona 降级在 service**：personaIds 长度 1 → 正常产单视角报告（commonTopics/rankingDivergences 空 + groundingNote 说明），断言**端点未特判**（service 层处理）。
- **CollaborationMode 可插拔**：mode 注入式，换 mock mode 断言编排壳不变。
- **boundary 透传**：persona 触边界（boundaries 来自 getPersonaDetail().profile.behaviorBoundaries）→ kind=boundary_block/escalate 原样进 perspective（不丢边界语义、不产 keyPoints、不进话题计算）。

## 8. 分片（供 writing-plans）

- **Plan 1**：`PersonaPerspectiveAnalyzer`（单 persona 复用三段基元）——最核心、可独立验（一个 persona 就能测）。
- **Plan 2**：`CollaborationMode` 接口 + `MultiPerspectiveAggregation`（aggregate：commonTopics/rankingDivergences/evidenceBrief/status/groundingNote/requiresHumanApproval）。
- **Plan 3**：`CollaborativeAnalysisService` 编排（多 persona 经 `getTenantOS().getCore()`）+ `/collaboration/analyze` 端点 + E2E（多视角真不同 + 共同话题/排序分歧 + 隔离 + 零-LLM + 边界透传 + insufficient_grounding）。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| aggregate 被误做成 LLM 综合（破零-LLM） | aggregate 是确定性关键词归类+模板拼装，无 LLM；retriever 类型层禁 embedding provider；测试断言零 LLM 可跑（约束 1） |
| 跨 persona 记忆串味（破隔离） | 每 persona 经 getTenantOS().getCore() 用自己 core 检索；汇总只读视角产出非 core（约束 2） |
| 夸大为「AI 现场专业推理/观点共识/新综合」 | 命名诚实降级（共同话题非共识、evidenceBrief 非综合建议）+ groundingNote + 文档明确专业度=学习深度（约束 5，Codex 复审要求） |
| 多数 persona 无积累却拼伪话题 | honest_offline 排除出话题计算；全部→status=insufficient_grounding（约束 3） |
| 关键词重叠误判「共同话题」为「观点一致」 | 命名就叫 commonTopics（话题非立场）；带 alternatives 时用 rankingDivergences（结构化排序）作可靠信号 |
| 报告含动作被当自动执行 | requiresHumanApproval 入数据契约；报告是参考，动作须人工采纳（约束 6，延续 strategy-advisory） |

## 10. 非目标（YAGNI）

- 首版不做角色分工 / 辩论共识模式（CollaborationMode 策略化后续加，本 spec 只首切多视角汇聚）。
- 首版不持久化分析历史（即时计算返回）。
- 不做运行时 LLM 综合（违零-LLM 铁律）。
- 不自动执行报告里的动作（人工采纳）。
- 不做 persona 自动选择（首版调用方指定 personaIds）。
