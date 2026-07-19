# 多数字人协同分析框架设计

> 状态：设计已确认（brainstorming 完成），待 Codex 独立复审 + 用户审阅 → writing-plans。
> 日期：2026-07-20
> 关联 ADR：0047（零-LLM 内核 / LLM-as-teacher）、0056（per-persona 内核）、0055（数字员工组织 / 策略辅助）。

## 1. 目标（一句话）

让**多个数字人**（各有独立学习背景 + 价值内核）就同一个问题**协同分析**，各自基于学到的内容 + 自己的价值观给出 grounded 视角，再**确定性汇聚**成一份带「共识 / 分歧 / 综合建议」的专业协同报告——全程运行时零-LLM。

## 2. 架构（可插拔多模式框架，首切「多视角汇聚」）

**核心洞察**：单 persona 分析的**三段基元全已存在且零-LLM**（检索 / 决策打分 / 组织成文；关联 association 是检索的一部分）。本能力的新增部分只是**「对多个 persona 各跑一遍 + 汇聚多视角」的编排薄壳**，不引入任何运行时 LLM。

```
① 发起：分析问题 question（+ 可选候选方案 alternatives[]）+ 参与的 persona 列表
② 每个 persona 独立分析（并行，全零-LLM）：
   · retrieveMemoriesDeterministic / ConversationKnowledgeRetriever.retrieve
       —— 检索该 persona 学到的相关记忆（各 persona 学的不同→检索不同）
   · （带 alternatives 时）AutonomousDecisionEngine.evaluateAutonomous
       —— 按该 persona 的 L0-L3 内核（值/生存锚/决策风格/认知模型）给候选打分排序
          （explorer 偏机会、guardian 偏风险→同问题不同排序）
   · OfflineConversationResponder.respond
       —— 把检索+打分组织成该 persona 的 grounded 视角意见文本
③ 汇聚（确定性，CollaborationMode 策略）：
   MultiPerspectiveAggregation.synthesize(perspectives[]) → CollaborativeReport
   · 归类各 persona 的关注点（关键词提取，复用 tokenize/关键词重叠）
   · 共识 = 多个 persona 都提到的点（重叠 ≥ 阈值）；分歧 = 仅少数提到 / 打分排序相反
   · 综合建议 = 按一致性 + persona 价值权重确定性排序呈现（非 LLM 生成新观点）
④ 产出：CollaborativeReport —— 每 persona 视角意见 + 共识点 + 分歧点 + 综合建议，全 grounded
```

## 3. 技术栈

Node.js + TypeScript。复用（全零-LLM 现成基元）：
- `src/conversation/deterministic-memory-retrieval.ts`（`retrieveMemoriesDeterministic`）+ `conversation-knowledge-retriever.ts`（`ConversationKnowledgeRetriever.retrieve`，导出 `tokenize`/`scoreTextByKeyword`）+ `deterministic-memory-association.ts`
- `src/intelligence/decision-engine.ts`（`AutonomousDecisionEngine.evaluateAutonomous`——ADR-0047 F8 窄接口，只确定性不触发 LLM）+ `rule-engine.ts` / kernel `structural-scorer.ts`（按 L0-L3 打分）
- `src/conversation/offline-conversation-responder.ts`（`OfflineConversationResponder.respond`）
- `src/multi-tenant/tenant-os-factory.ts`（per-persona 内核解析）
- 参照 `src/workforce/strategy-advisory-service.ts`（同款「确定性多 lens 重排 + requiresHumanApproval」输出形态范式）

## 4. 全局约束（每个实现任务隐含遵守）

1. **运行时零-LLM 铁律（ADR-0047）**：整条协同分析链**不得调用 LLM**。每 persona 分析走的三段基元都是零-LLM（decision-engine 用 `evaluateAutonomous` 窄接口）；汇聚是确定性关键词归类/排序，**不得**用 LLM 现综合新观点。LLM 只在各 persona 的**学习期**当老师（既有 perception/learn 路径），本能力不碰。
2. **per-persona 隔离（ADR-0056）**：每个 persona 用**自己的**内核（记忆/值/决策风格/认知模型）分析——经 `tenant-os-factory` 按 `(tenant, persona)` 解析各自内核。A 的记忆不串进 B 的分析。跨 persona 只在**汇聚层**读各自产出的视角（视角是分析结果，非内核内部）。
3. **grounded 不编造**：每 persona 视角基于其检索到的记忆（`knowledge_grounded`）；无相关记忆→该 persona 诚实报「就此问题我无相关积累」（`honest_offline`），不瞎给意见。汇聚如实反映——若多数 persona 无积累，报告应显式说明「参与者对此问题积累不足」而非编造共识。
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
export interface PersonaPerspective {
  personaId: string;
  opinion: string;                    // OfflineResponder 组织的 grounded 视角文本
  kind: 'knowledge_grounded' | 'honest_offline';
  groundedCount: number;
  keyPoints: readonly string[];       // 从 opinion 提取的关注点（tokenize/关键词），供汇聚归类
  rankedAlternatives?: readonly { alternative: string; score: number; rank: number }[];  // 带 alternatives 时的决策引擎排序
}
export class PersonaPerspectiveAnalyzer {
  constructor(deps: { retriever; decisionEngine; responder; core });  // 注入既有三段基元（无 distiller——分析不做 distill，distill 属学习期）
  analyze(personaId: string, req: AnalysisRequest): PersonaPerspective;  // 全零-LLM 同步/确定性
}
```
- 检索：`retrieveMemoriesDeterministic(question, personaMemories, ...)` → relevantKnowledge。
- 打分（带 alternatives）：构造 `DecisionCase`（alternatives 作候选）→ `evaluateAutonomous` → rankedOptions 映射 rankedAlternatives。
- 组织：`OfflineConversationResponder.respond({ narrative: persona.narrative, userInput: question, relevantKnowledge })` → opinion + kind + groundedCount。
- keyPoints：从 opinion + 命中记忆用 `tokenize`/关键词提取（复用 conversation-knowledge-retriever 导出的 tokenize），供 5.3 汇聚。

### 5.2 `CollaborationMode` 策略接口 + `MultiPerspectiveAggregation`

**文件（新建）**：`src/collaboration/collaboration-mode.ts`（接口）+ `src/collaboration/modes/multi-perspective-aggregation.ts`（首实现）

```typescript
export interface CollaborationMode {
  readonly modeId: string;  // 'multi_perspective'
  synthesize(question: string, perspectives: readonly PersonaPerspective[]): CollaborativeReport;
}
export interface CollaborativeReport {
  question: string;
  modeId: string;
  perspectives: readonly PersonaPerspective[];        // 各 persona 视角（原样保留，可追溯）
  consensus: readonly { point: string; supportedBy: readonly string[] }[];   // 多 persona 都提到
  divergences: readonly { point: string; raisedBy: readonly string[] }[];    // 仅少数提 / 排序相反
  synthesis: string;                                   // 确定性综合（按一致性+价值权重排序呈现，非 LLM 新观点）
  groundingNote: string;                               // 能力边界/积累充分性说明（约束 3/5）
}
```
- **consensus/divergence 判定（确定性）**：跨 persona 的 keyPoints 做关键词重叠（复用 co_occurrence 那套重叠系数思路，memory `companion-associative-memory` 记的重叠系数非 Jaccard）；重叠 ≥ 阈值的点 = 共识（记 supportedBy）；仅 1 个 persona 提 = 该 persona 独特视角（记 divergences）；带 alternatives 时排序相反（A 排第一 vs B 排末位）= 显式分歧。**具体阈值 + keyPoints 提取的关键词启发式在 writing-plans/Task 定义并测**（spec 层给判据：重叠系数、非 Jaccard、样板前缀剥离——照 companion-associative-memory 既有做法）。
- **synthesis（确定性拼装，非 LLM）**：先列共识点（多视角支撑=强信号），再列关键分歧（供人工权衡），末尾按 persona 一致性/价值对齐度排序综合——纯模板拼装，不生成新观点。
- **groundingNote**：若 ≥ 半数 persona 是 honest_offline → 明确「参与者对此问题积累不足，以下多为一般性视角」；否则标注「基于 N 位数字人各自学习积累」。

### 5.3 `CollaborativeAnalysisService`（编排）

**文件（新建）**：`src/collaboration/collaborative-analysis-service.ts`

```typescript
export class CollaborativeAnalysisService {
  constructor(deps: { tenantOSFor: (tenantId) => ChronoSynthOS; mode: CollaborationMode; });
  analyze(tenantId: string, personaIds: readonly string[], req: AnalysisRequest): CollaborativeReport;
}
```
- 对 `personaIds` 每个：经 `tenant-os-factory` 解析该 (tenant, persona) 内核 → 构造 `PersonaPerspectiveAnalyzer`（注入该 persona 的 retriever/decisionEngine/responder/core）→ `analyze` → 收集 PersonaPerspective。
- 全部收集后 → `mode.synthesize(question, perspectives)` → CollaborativeReport。
- **per-persona 隔离**：每 persona 用自己的内核（约束 2）；编排层只聚合视角产出。

### 5.4 端点

**文件（新建）**：`src/server/routes/collaboration.ts`（或并入 companion，按注册惯例）
- `POST /api/v1/collaboration/analyze`，body `{ question, alternatives?, personaIds }` → CollaborativeReport。
- 鉴权/租户隔离照既有路由骨架；参与的 personaIds 须属该租户（跨租户拒）。
- 首版 personaIds 由调用方指定（如「让 explorer + guardian + analyst 三个原型分析」）。

## 6. 数据模型

首版**可不持久化**（分析是即时计算，报告返回即用）——最简。若需留存分析历史（审计/复看），新表 `collaborative_analyses`（id/tenant_id/question/mode_id/report_json/created_at），双登记（约束 7）。**首版决定：不持久化**（YAGNI；留存作后续增强）。故本 spec 无迁移。

## 7. 可验证性

- **多视角真不同**：seed 两个不同原型 persona（explorer/guardian）学不同内容 → 同问题分析 → 断言两 opinion 不同、keyPoints 不同、（带 alternatives 时）rankedAlternatives 排序不同（体现内核多样性）。
- **零-LLM**：整条 analyze 不注入 LLM provider 也能跑（纯确定性）；同输入同输出（无 Date.now/random 影响结论）。
- **汇聚正确**：构造两 persona 提同一点 → 断言进 consensus + supportedBy 含两者；仅一个提 → 进 divergences。
- **grounded 诚实**：无相关记忆的 persona → honest_offline；≥半数 honest_offline → groundingNote 说明积累不足（不编造共识）。
- **per-persona 隔离**：A 的记忆不出现在 B 的 perspective（B 只用自己内核检索）。
- **CollaborationMode 可插拔**：mode 注入式，换一个 mock mode 断言编排壳不变。

## 8. 分片（供 writing-plans）

- **Plan 1**：`PersonaPerspectiveAnalyzer`（单 persona 复用三段基元）——最核心、可独立验（一个 persona 就能测）。
- **Plan 2**：`CollaborationMode` 接口 + `MultiPerspectiveAggregation`（汇聚：共识/分歧/synthesis/groundingNote）。
- **Plan 3**：`CollaborativeAnalysisService` 编排（多 persona 经 tenant-os-factory）+ `/collaboration/analyze` 端点 + E2E（多视角真不同 + 汇聚 + 隔离 + 零-LLM）。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 汇聚被误做成 LLM 综合（破零-LLM） | synthesize 是确定性关键词归类+模板拼装，无 LLM；测试断言零 LLM 可跑（约束 1） |
| 跨 persona 记忆串味（破隔离） | 每 persona 经 tenant-os-factory 用自己内核检索；汇聚只读视角产出非内核（约束 2） |
| 夸大为「AI 现场专业推理」 | groundingNote + 文档明确专业度=学习深度（约束 5） |
| 多数 persona 无积累却编造共识 | ≥半数 honest_offline → groundingNote 显式标注积累不足（约束 3） |
| 报告含动作被当自动执行 | 报告是建议，可执行动作标注需人工采纳（约束 6，延续 strategy-advisory） |

## 10. 非目标（YAGNI）

- 首版不做角色分工 / 辩论共识模式（CollaborationMode 策略化后续加，本 spec 只首切多视角汇聚）。
- 首版不持久化分析历史（即时计算返回）。
- 不做运行时 LLM 综合（违零-LLM 铁律）。
- 不自动执行报告里的动作（人工采纳）。
- 不做 persona 自动选择（首版调用方指定 personaIds）。
