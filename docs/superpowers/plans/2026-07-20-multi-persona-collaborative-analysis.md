# 多数字人协同分析框架 Implementation Plan

> **状态：已过 Codex 独立复审**（plan 68 退→82 退→**96 通过「达到通过线，可交 subagent 实现」**，每轮核验真实代码后修）。spec 亦已过（94）。
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）or superpowers:executing-plans 逐 task 实现。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 让多个数字人（各自独立学习背景 + 价值内核）就同一问题各自基于自己学到的记忆给出 grounded 视角（+ 对给定候选方案的可审计排序），再确定性汇聚成一份带「共同话题 / 排序分歧 / 各视角证据摘要」的参考报告——全程运行时零-LLM。

**Architecture:** 三层薄壳复用既有零-LLM 基元：`PersonaPerspectiveAnalyzer`（单 persona 跑「确定性检索 → 决策打分 → 离线组织成文」三段基元）；可插拔 `CollaborationMode` 接口 + 首实现 `MultiPerspectiveAggregation`（确定性关键词归类 + 排序分歧 + 模板拼装证据摘要）；`CollaborativeAnalysisService` 编排（经 `getTenantOS().getCore(personaId)` 逐 persona 解析、fail-closed 校验、单 persona 降级）+ `POST /api/v1/collaboration/analyze` 端点。不新增运行时 LLM、不持久化。

**Tech Stack:** Node.js + TypeScript。复用 `retrieveMemoriesDeterministic`（纯关键词+图遍历零-LLM）、`AutonomousDecisionEngine.evaluateAutonomous`（ADR-0047 F8 窄接口）、`OfflineConversationResponder.respond`、`PersonaCoreService.getPersonaDetail`、`TenantOSFactory.getTenantOS().getCore()`。测试沿用既有 `node:test` + `tsx`（同 `src/**/*.test.ts` 惯例）。

## Global Constraints

（每个 task 隐含遵守；出自 spec §4）

1. **运行时零-LLM 铁律（ADR-0047）**：整条 analyze 链不得调用 LLM。检索只用 `retrieveMemoriesDeterministic`（禁 `ConversationKnowledgeRetriever`——它会 `provider.embed()`）；决策只用 `evaluateAutonomous`（窄接口，无 mode 参数，不可能退回 growth/LLM）；汇聚是确定性关键词归类 + 模板拼装，绝不 LLM 综合新观点。构造 `DecisionEngine` 时 `llm` 传 `undefined`（autonomous-only 构造，ADR-0047 D1）。
2. **per-persona 隔离（ADR-0056）**：每个 persona 用**自己的** `os.getCore(personaId)` 的 memory/edges/narrative/decisionStyle 分析。A 的记忆（memoryId）不得出现在 B 的 perspective.evidence。
3. **grounded 不编造**：无相关记忆 → `honest_offline`，不产 keyPoints/evidence；不用离线套话拼伪话题。
4. **排序归因诚实**：现状排序只由 L1 alignmentScore 驱动（L0 violations=[] 恒空、L2/L3 riskScore=0.5 固定不改相对次序、rules inert）；**首版构造 DecisionCase 时 `constraints` 留空** → 排序只由 L1 驱动（设计选择）。不得夸「L0-L3/rules/原型标签驱动排序」。
5. **诚实降级命名**：产出「共同话题 commonTopics」非「共识」、「证据摘要 evidenceBrief」非「综合建议」。专业度 = 各 persona 学习期蒸馏深度，非现场推理。
6. **人工性质**：`requiresHumanApproval: true` 入数据契约（报告是参考，含动作须人工采纳）。
7. **未知/跨租户 persona fail-closed**：`getCore(personaId)` 对任意字符串新建空 core 无校验（`chrono-synth-os.ts:446`）——必须先 `getPersonaDetail(tenantId, ownerUserId, personaId)` 校验存在+归属，返回 null（不存在/他 owner/跨租户，不可区分）→ 统一抛 `NotFoundError(..., ErrorCode.NOT_FOUND_PERSONA)`（照 `earning.ts:40` 先例，映射 404，不区分 NotFound/Forbidden，防跨租户存在性泄露），拒绝发生在 getCore 之前。
8. **确定性**：同输入同输出——不得用 `Date.now()`/`Math.random()`（如需时钟走注入的 clock）。
9. **中文注释**（项目规范）；SOLID/DRY；函数缩进 ≤3 层。
10. **测试位置与运行惯例（覆盖各 task 里的 Test 路径/Run 命令——已核实仓库真实惯例）**：
    - **所有测试文件放 `src/test/unit/`（扁平，无子目录）**，命名 `collaboration-<topic>.test.ts`（如 `collaboration-key-points.test.ts` / `collaboration-analyzer.test.ts` / `collaboration-aggregation.test.ts` / `collaboration-service.test.ts` / `collaboration-no-op-embedding-index.test.ts`；route 测试放 `src/test/integration/collaboration-route.test.ts`）。**不要 co-located**（`src/collaboration/*.test.ts` 不会被 `test:unit`/`test:integration` 的 `dist/test/**` glob 捡到——全仓 395 个测试无一 co-located）。
    - **测试 import 被测源码用相对路径**（如 `../../collaboration/key-points.js`）。
    - **快跑单文件（TDD 红/绿迭代）**：`npx tsx --test src/test/unit/collaboration-<topic>.test.ts`（tsx 已装，直接跑 src 免 build，快）。各 task 里写的 `npx tsx --test <path>` 一律换成 `src/test/unit/...` 真实路径。
    - **最终确认走真实惯例**（收尾 test:golden 会做）：`npm run build` 后 `node --test --test-force-exit dist/test/unit/collaboration-*.test.js`（route 走 `dist/test/integration/`）——与 `test:unit`/`test:integration` 同源，保证 golden 门捡得到。
    - 被测**源码**仍在 `src/collaboration/` / `src/server/routes/` / `src/conversation/`（只有测试文件挪到 `src/test/`）。

---

## File Structure

- `src/collaboration/collaboration-types.ts` — 共享类型（`AnalysisRequest` / `PerspectiveEvidence` / `PersonaPerspective` / `CollaborationMode` / `CollaborativeReport`），无逻辑，被三层共享。
- `src/collaboration/persona-perspective-analyzer.ts` — `PersonaPerspectiveAnalyzer`（单 persona，三段基元）。
- `src/collaboration/collaboration-mode.ts` — `CollaborationMode` 接口（re-export from types 亦可，但独立文件放接口 doc）。
- `src/collaboration/modes/multi-perspective-aggregation.ts` — `MultiPerspectiveAggregation`（首实现）。
- `src/collaboration/collaborative-analysis-service.ts` — `CollaborativeAnalysisService`（编排 + 校验）。
- `src/server/routes/collaboration.ts` — `POST /api/v1/collaboration/analyze` 端点。
- 测试与被测同目录（`*.test.ts`）；端点/编排 E2E 放 `src/collaboration/collaborative-analysis-service.test.ts` + route 测试。
- **修改**：`src/conversation/deterministic-memory-retrieval.ts` — 导出 `tokenize`（keyPoints 提取复用，Task 2 需要）。
- **修改**：`src/server/app.ts` — 注册新路由（Task 5）。

---

## Task 1: 共享类型 `collaboration-types.ts`

**Files:**
- Create: `src/collaboration/collaboration-types.ts`
- Test: 无（**纯类型文件，无运行时行为，故无 red→green TDD 循环**——这是唯一的例外 task；正确性由 `tsc --noEmit`（Step 2）+ 后续 task 消费这些类型时编译期强制。Codex 复审 #「Task 1 无失败测试」：类型定义没有可断言的运行时行为，强造空跑测试才是 grader-gaming；此处诚实标注例外）。

**Interfaces:**
- Consumes: 无（本 task 纯类型；`kind` 联合字面量直接内联，不 import `OfflineResponseKind`——避免耦合，且它是字面量子集）。
- Produces: `AnalysisRequest` / `PerspectiveEvidence` / `PersonaPerspective` / `CollaborationMode` / `CollaborativeReport` 供 Task 2/3/4/5 import。
> **注（Codex 复审 #2）**：`BehaviorBoundary` **定义并导出在 `src/enterprise/persona-template-catalog.ts:23`**（`offline-conversation-responder.ts` 只 import 不 re-export）——Task 3/5 需要时从 `persona-template-catalog.js` import，**不是** responder。本 Task 1 类型不引用 BehaviorBoundary。

- [ ] **Step 1: 写类型文件**

```typescript
// src/collaboration/collaboration-types.ts
/** 多数字人协同分析——共享数据契约（spec §5.1/§5.2）。全部零-LLM 产物，可序列化。 */

/** 分析请求（单次协同分析的输入问题 + 可选候选方案）。 */
export interface AnalysisRequest {
  readonly question: string;
  /** 可选候选方案：有则每 persona 走决策引擎打分排序（首版不传 constraints，排序只由 L1 驱动）。 */
  readonly alternatives?: readonly string[];
}

/** 结构化证据引用（供 evidenceBrief 可追溯，非仅复述 opinion 文本）。 */
export interface PerspectiveEvidence {
  readonly memoryId: string;
  readonly excerpt: string;     // 记忆 content 片段
  readonly relevance: number;   // 0..1
  readonly association: boolean; // true=图遍历联想到的（非查询直接命中）
}

/** 某 persona 对问题的单视角（= OfflineResponseKind 全集，不丢边界语义）。 */
export interface PersonaPerspective {
  readonly personaId: string;
  readonly opinion: string;     // OfflineResponder.respond 的 content
  readonly kind: 'knowledge_grounded' | 'honest_offline' | 'boundary_block' | 'boundary_escalate';
  /** analyzer 自算 = 检索到并喂进 responder 的记忆条数（responder 内部会再过滤，故命名 retrieved 非 grounded）。 */
  readonly retrievedCount: number;
  /** 检索到的结构化证据；honest_offline/boundary 视角为空数组。 */
  readonly evidence: readonly PerspectiveEvidence[];
  /** 仅从 evidence.excerpt 提取（tokenize + 剥样板）；不含 alternatives、不从 opinion 提取；honest_offline/boundary 为空。 */
  readonly keyPoints: readonly string[];
  /** 带 alternatives 时 evaluateAutonomous 的排序（与 opinion 并列，不混入 opinion，不进 keyPoints）。 */
  readonly rankedAlternatives?: readonly { alternative: string; score: number; rank: number }[];
}

/** 汇聚报告（spec §5.2）。 */
export interface CollaborativeReport {
  readonly question: string;
  readonly modeId: string;
  /** 唯一门槛=grounded 视角数 G：G===0→insufficient_grounding，G≥1→analyzed（细粒度经 groundingNote）。 */
  readonly status: 'analyzed' | 'insufficient_grounding';
  readonly perspectives: readonly PersonaPerspective[];
  /** 多 persona 共同**关注的话题**（非「观点共识」）。 */
  readonly commonTopics: readonly { topic: string; raisedBy: readonly string[] }[];
  /** 同一候选被不同 persona 排到不同/相反位置（带 alternatives 时）。 */
  readonly rankingDivergences: readonly {
    alternative: string;
    rankings: readonly { personaId: string; rank: number }[];
  }[];
  /** 确定性**证据摘要**（decision brief）：纯模板拼装，明确不产生新综合观点。 */
  readonly evidenceBrief: string;
  /** 能力边界/积累充分性说明。 */
  readonly groundingNote: string;
  /** 报告是参考，含动作须人工采纳（约束 6，入数据契约非仅 prose）。 */
  readonly requiresHumanApproval: true;
}

/** 可插拔协同模式策略（首实现 MultiPerspectiveAggregation）。 */
export interface CollaborationMode {
  readonly modeId: string;
  aggregate(question: string, perspectives: readonly PersonaPerspective[]): CollaborativeReport;
}
```

- [ ] **Step 2: 编译验证**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS（无新错；新文件仅类型，无实现）

- [ ] **Step 3: Commit**

```bash
git add src/collaboration/collaboration-types.ts
git commit -m "feat(collab): 协同分析共享数据契约类型"
```

---

## Task 2: keyPoints 提取工具（复用已导出的 `tokenize`）

> **修正（Codex 复审 #1）**：`tokenize` **已在 `conversation-knowledge-retriever.ts:185` 定义并导出**（`deterministic-memory-retrieval.ts:18` 只是 import 它）——**无需也不能给 deterministic 文件加 export**。直接从 `conversation-knowledge-retriever.js` import。

**Files:**
- Create: `src/collaboration/key-points.ts`（从 evidence.excerpt 提 keyPoints）
- Test: `src/collaboration/key-points.test.ts`

**Interfaces:**
- Consumes: `tokenize`（**已导出** `src/conversation/conversation-knowledge-retriever.ts:185`）、`PerspectiveEvidence`（Task 1）。
- Produces: `extractKeyPoints(evidence: readonly PerspectiveEvidence[]): string[]` 供 Task 3 analyzer 用；`stripBoilerplate(text: string): string`（剥样板前缀，照 memory `companion-associative-memory`）。

- [ ] **Step 1: 写 key-points 失败测试**

```typescript
// src/collaboration/key-points.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeyPoints } from './key-points.js';
import type { PerspectiveEvidence } from './collaboration-types.js';

const ev = (excerpt: string): PerspectiveEvidence => ({ memoryId: 'm', excerpt, relevance: 0.5, association: false });

test('extractKeyPoints 只从 excerpt 提取内容词、去重、稳定排序', () => {
  const points = extractKeyPoints([ev('市场扩张 需要 更多 预算'), ev('预算 是 关键 约束')]);
  // 内容词进入（去停用词后），跨证据去重（预算只出现一次），稳定序（无 Date/random）
  assert.ok(points.includes('预算'));
  assert.ok(points.includes('市场扩张') || points.includes('市场'));
  assert.equal(points.filter((p) => p === '预算').length, 1);
  assert.deepEqual(points, [...points].sort()); // 稳定：按字典序
});

test('extractKeyPoints 空证据 → 空', () => {
  assert.deepEqual(extractKeyPoints([]), []);
});

test('extractKeyPoints 剥样板前缀（据我记得/我认为 等不进 keyPoints）', () => {
  const points = extractKeyPoints([ev('据我记得 客户 很 重视 交付速度')]);
  assert.ok(!points.includes('据我记得'));
  assert.ok(points.includes('客户') || points.includes('交付速度') || points.includes('交付'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/collaboration/key-points.test.ts`
Expected: FAIL（`extractKeyPoints` 未定义 / 模块不存在）

- [ ] **Step 3: 写 key-points 实现（从已导出的 tokenize import）**

```typescript
// src/collaboration/key-points.ts
/** 从 grounded 证据 excerpt 提取 keyPoints（确定性、零-LLM）：tokenize + 剥样板前缀 + 去重 + 稳定排序。
 * 约束：只从 evidence.excerpt 提，不从 opinion/alternatives（spec §5.1 / 约束 3/4）。 */
import { tokenize } from '../conversation/conversation-knowledge-retriever.js';  // 已导出（:185）；不改该文件
import type { PerspectiveEvidence } from './collaboration-types.js';

/** 样板前缀词（离线套话/记忆引导语），不作为话题信号。照 memory companion-associative-memory。 */
const BOILERPLATE = new Set<string>(['据我记得', '我认为', '我觉得', '据我了解', '如我所学', '就我所知']);

/** 剥掉 excerpt 开头的样板引导（返回剥离后的文本）。 */
export function stripBoilerplate(text: string): string {
  let out = text.trim();
  for (const prefix of BOILERPLATE) {
    if (out.startsWith(prefix)) out = out.slice(prefix.length).trim();
  }
  return out;
}

/** 停用词（tokenize 若已去部分虚词则此处兜底）。 */
const STOPWORDS = new Set<string>(['需要', '是', '的', '了', '和', '与', '很', '更多', '关键', '约束']);

export function extractKeyPoints(evidence: readonly PerspectiveEvidence[]): string[] {
  const seen = new Set<string>();
  for (const e of evidence) {
    for (const tok of tokenize(stripBoilerplate(e.excerpt))) {
      if (tok.length <= 1) continue;          // 单字噪音
      if (STOPWORDS.has(tok) || BOILERPLATE.has(tok)) continue;
      seen.add(tok);
    }
  }
  return [...seen].sort();                     // 稳定：字典序（约束 8 确定性）
}
```
> 注：`STOPWORDS`/`BOILERPLATE` 是首版启发式，实现者可按测试预期调整词表；核心不变式是「只从 excerpt 提 + 去重 + 稳定排序 + 不含样板」。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/collaboration/key-points.test.ts`
Expected: PASS（3 测试）

- [ ] **Step 5: Commit**（只新增文件，未改任何既有文件）

```bash
git add src/collaboration/key-points.ts src/collaboration/key-points.test.ts
git commit -m "feat(collab): keyPoints 从 grounded 证据提取（复用已导出 tokenize，去样板/去重/稳定序）"
```

---

## Task 3: `PersonaPerspectiveAnalyzer`（单 persona 三段基元）

**Files:**
- Create: `src/collaboration/persona-perspective-analyzer.ts`
- Test: `src/collaboration/persona-perspective-analyzer.test.ts`

**Interfaces:**
- Consumes: `retrieveMemoriesDeterministic` + `RelevantKnowledge`（`src/conversation/deterministic-memory-retrieval.ts` / `conversation-types.ts`）、`AutonomousDecisionEngine` + `DecisionCase`（`src/intelligence/decision-engine.ts` / kernel `decision-types.ts`）、`OfflineConversationResponder`（`src/conversation/offline-conversation-responder.ts`）、`BehaviorBoundary`、`extractKeyPoints`（Task 2）、类型（Task 1）。
- Produces: `class PersonaPerspectiveAnalyzer`，`analyze(personaId: string, req: AnalysisRequest): PersonaPerspective`。

**关键真实契约（实现须严格遵守）：**
- 检索：`retrieveMemoriesDeterministic(question, memories, edgesFor, undefined, contentFor?)` 返回 `RelevantKnowledge[]`（`{id, title, content, relevance, isAssociation?}`）——见 `chat.ts:144-152` 复用模式。
- evidence 映射：`memoryId=k.id`、`excerpt=k.content`、`relevance=k.relevance`、`association = k.isAssociation ?? false`。
- 决策：`decisionEngine.evaluateAutonomous({ id, title, description, alternatives, context })` **不传 constraints**（约束 4）——见 `persona-earning-service.ts:227`。返回 `DecisionResult.rankedOptions:[{alternative, rank, overallScore}]` → 映射 `rankedAlternatives:[{alternative, score: overallScore, rank}]`。
- 组织：`responder.respond({ narrative, boundaries: [...boundaries], userInput: question, relevantKnowledge })` → `{content, kind}`。**boundaries 传前 spread `[...boundaries]`**（`OfflineResponderInput.boundaries` 是可变 `BehaviorBoundary[]`，analyzer 持 readonly，见 responder line 51）。opinion=content、kind 原样透传。
- kind 为 `honest_offline`/`boundary_block`/`boundary_escalate` 时：`evidence=[]`、`keyPoints=[]`（约束 3）；`retrievedCount` 仍如实（检索到几条就是几条，即使 responder 判定 offline）。

- [ ] **Step 1: 写失败测试（用轻量 fake 依赖，零真 DB）**

```typescript
// src/collaboration/persona-perspective-analyzer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaPerspectiveAnalyzer } from './persona-perspective-analyzer.js';
import type { RelevantKnowledge } from '../conversation/conversation-types.js';

/** 极简 fake：把注入的检索/决策/组织三基元替换为可控桩，聚焦 analyzer 的映射与门控逻辑。 */
function makeAnalyzer(opts: {
  knowledge: RelevantKnowledge[];
  kind?: 'knowledge_grounded' | 'honest_offline' | 'boundary_block' | 'boundary_escalate';
  ranked?: { alternative: string; rank: number; overallScore: number }[];
}) {
  return new PersonaPerspectiveAnalyzer({
    retrieve: () => opts.knowledge,                                   // 注入检索桩
    decisionEngine: { evaluateAutonomous: () => ({ caseId: 'c', recommendedAlternative: opts.ranked?.[0]?.alternative ?? '', rankedOptions: opts.ranked ?? [], simulatedAt: 0 }) },
    responder: { respond: () => ({ content: 'op', kind: opts.kind ?? 'knowledge_grounded' }) } as any,
    narrative: 'n',
    boundaries: [],
  });
}

test('grounded：映射 evidence（id→memoryId, content→excerpt, isAssociation→association）+ retrievedCount + keyPoints', () => {
  const a = makeAnalyzer({ knowledge: [
    { id: 'm1', title: '', content: '预算 约束 收紧', relevance: 0.7 },
    { id: 'm2', title: '', content: '市场 需求 上升', relevance: 0.4, isAssociation: true },
  ]});
  const p = a.analyze('persona-x', { question: '要不要扩张' });
  assert.equal(p.kind, 'knowledge_grounded');
  assert.equal(p.retrievedCount, 2);
  assert.equal(p.evidence.length, 2);
  assert.deepEqual(p.evidence.map((e) => e.memoryId), ['m1', 'm2']);
  assert.equal(p.evidence[0].excerpt, '预算 约束 收紧');
  assert.equal(p.evidence[0].association, false);   // 缺省 isAssociation → false
  assert.equal(p.evidence[1].association, true);
  assert.ok(p.keyPoints.length > 0);
});

test('honest_offline：evidence/keyPoints 为空，retrievedCount 仍如实', () => {
  const a = makeAnalyzer({ knowledge: [{ id: 'm1', title: '', content: '无关内容', relevance: 0.1 }], kind: 'honest_offline' });
  const p = a.analyze('persona-y', { question: 'q' });
  assert.equal(p.kind, 'honest_offline');
  assert.deepEqual(p.evidence, []);
  assert.deepEqual(p.keyPoints, []);
  assert.equal(p.retrievedCount, 1);   // 检索到 1 条，只是 responder 判定离线
});

test('带 alternatives：rankedAlternatives 从 rankedOptions 映射（overallScore→score）', () => {
  const a = makeAnalyzer({ knowledge: [{ id: 'm1', title: '', content: '扩张 有利', relevance: 0.8 }], ranked: [
    { alternative: '扩张', rank: 1, overallScore: 0.9 },
    { alternative: '收缩', rank: 2, overallScore: 0.3 },
  ]});
  const p = a.analyze('persona-z', { question: 'q', alternatives: ['扩张', '收缩'] });
  assert.deepEqual(p.rankedAlternatives, [
    { alternative: '扩张', score: 0.9, rank: 1 },
    { alternative: '收缩', score: 0.3, rank: 2 },
  ]);
});

test('boundary_block：evidence/keyPoints 空，kind 透传', () => {
  const a = makeAnalyzer({ knowledge: [], kind: 'boundary_block' });
  const p = a.analyze('persona-b', { question: '禁忌话题' });
  assert.equal(p.kind, 'boundary_block');
  assert.deepEqual(p.evidence, []);
  assert.deepEqual(p.keyPoints, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/collaboration/persona-perspective-analyzer.test.ts`
Expected: FAIL（`PersonaPerspectiveAnalyzer` 未定义）

- [ ] **Step 3: 写实现**

```typescript
// src/collaboration/persona-perspective-analyzer.ts
/** 单 persona 视角分析：复用「确定性检索 → 决策打分 → 离线组织成文」三段零-LLM 基元（spec §5.1）。
 * 检索/决策/组织三依赖注入，便于测试用桩替换、也让类型层禁 embedding provider（零-LLM 闭合）。 */
import type { RelevantKnowledge } from '../conversation/conversation-types.js';
import type { AutonomousDecisionEngine } from '../intelligence/decision-engine.js';
import type { OfflineConversationResponder } from '../conversation/offline-conversation-responder.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';   // 修正：真实定义处（:23），非 responder
import type { AnalysisRequest, PersonaPerspective, PerspectiveEvidence } from './collaboration-types.js';
import { extractKeyPoints } from './key-points.js';

/** 注入的确定性检索器：绑定某 persona 的 memory store（禁 embedding provider）。 */
export type PersonaRetrieve = (question: string) => RelevantKnowledge[];

export interface PersonaPerspectiveAnalyzerDeps {
  readonly retrieve: PersonaRetrieve;
  readonly decisionEngine: AutonomousDecisionEngine;
  readonly responder: OfflineConversationResponder;
  readonly narrative: string;
  readonly boundaries: readonly BehaviorBoundary[];
}

export class PersonaPerspectiveAnalyzer {
  constructor(private readonly deps: PersonaPerspectiveAnalyzerDeps) {}

  analyze(personaId: string, req: AnalysisRequest): PersonaPerspective {
    const knowledge = this.deps.retrieve(req.question);
    const rankedAlternatives = this.rank(req);
    const { content, kind } = this.deps.responder.respond({
      narrative: this.deps.narrative,
      boundaries: [...this.deps.boundaries],   // spread：readonly → 可变参
      userInput: req.question,
      relevantKnowledge: knowledge,
    });
    const grounded = kind === 'knowledge_grounded';
    const evidence: PerspectiveEvidence[] = grounded
      ? knowledge.map((k) => ({ memoryId: k.id, excerpt: k.content, relevance: k.relevance, association: k.isAssociation ?? false }))
      : [];
    return {
      personaId,
      opinion: content,
      kind,
      retrievedCount: knowledge.length,        // 如实：检索条数（responder 内部再过滤不影响此计数）
      evidence,
      keyPoints: grounded ? extractKeyPoints(evidence) : [],
      ...(rankedAlternatives ? { rankedAlternatives } : {}),
    };
  }

  /** 带 alternatives 时走 evaluateAutonomous（不传 constraints，约束 4）；否则不产排序。 */
  private rank(req: AnalysisRequest): { alternative: string; score: number; rank: number }[] | undefined {
    if (!req.alternatives || req.alternatives.length === 0) return undefined;
    const result = this.deps.decisionEngine.evaluateAutonomous({
      id: `collab_${req.question.slice(0, 24)}`,
      title: req.question,
      description: req.question,
      alternatives: req.alternatives,
      // constraints 首版留空（排序只由 L1 驱动，约束 4）
    });
    return result.rankedOptions.map((o) => ({ alternative: o.alternative, score: o.overallScore, rank: o.rank }));
  }
}
```
> 注：`BehaviorBoundary` 从 `src/enterprise/persona-template-catalog.ts`（真实定义+导出处 :23）import；`OfflineResponderInput.boundaries` 是可变 `BehaviorBoundary[]`（responder line 51），故 `respond` 调用处 spread `[...boundaries]`（readonly→可变）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/collaboration/persona-perspective-analyzer.test.ts`
Expected: PASS（4 测试）

- [ ] **Step 5: 编译验证**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/collaboration/persona-perspective-analyzer.ts src/collaboration/persona-perspective-analyzer.test.ts
git commit -m "feat(collab): PersonaPerspectiveAnalyzer 单 persona 三段零-LLM 基元"
```

---

## Task 4: `MultiPerspectiveAggregation`（汇聚模式首实现）

**Files:**
- Create: `src/collaboration/collaboration-mode.ts`（re-export `CollaborationMode` 接口 + doc）
- Create: `src/collaboration/modes/multi-perspective-aggregation.ts`
- Test: `src/collaboration/modes/multi-perspective-aggregation.test.ts`

**Interfaces:**
- Consumes: `CollaborationMode` / `PersonaPerspective` / `CollaborativeReport`（Task 1）。
- Produces: `class MultiPerspectiveAggregation implements CollaborationMode`（`modeId='multi_perspective'`）。

**判定规则（spec §5.2，全确定性）：**
- **commonTopics（首版定义——Codex 复审 #3 校正：规则=代码=测试三者一致）**：只对 `kind==='knowledge_grounded'` 的 perspective 的 `keyPoints`（已是规范化 token，Task 2 tokenize 产）计数（honest_offline/boundary 排除）；**同一 keyPoint token 被 ≥2 个 grounded persona 提到即入 commonTopics**，`raisedBy` = 提到者 personaId 列表（长度 ≥2）。稳定排序（topic 字典序）。**首版不做集合重叠系数/阈值**（keyPoints 已是规范化 token，按 token 相等分组即「共同关注同一话题词」，足够诚实且可测）——不写「重叠系数」字样，避免规则与实现不符。（重叠系数是后续增强，若加须同补阈值测试。）
- **rankingDivergences**：只在带 `rankedAlternatives` 的 perspective 间——同一 alternative 被 ≥2 persona 排到**不同 rank** 即入。列每候选各 persona 的 `{personaId, rank}`。稳定排序（alternative 字典序）。
- **status/groundingNote**：G = grounded 视角数。`G===0` → `insufficient_grounding` + commonTopics/rankingDivergences 空 + groundingNote「参与者对此问题均无相关积累」；`G≥1` → `analyzed`，`G<半数` → groundingNote 追加「多数参与者积累不足，仅 G 个视角有依据」，否则「基于 N 位数字人各自学习积累（G 个视角有据）」。
- **evidenceBrief**：纯模板拼装——列共同话题 + 排序分歧 + 各 grounded persona 的证据引用（memoryId+excerpt 截断）。不产新观点。
- **requiresHumanApproval: true** 恒定。

- [ ] **Step 1: 写失败测试**

```typescript
// src/collaboration/modes/multi-perspective-aggregation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiPerspectiveAggregation } from './multi-perspective-aggregation.js';
import type { PersonaPerspective } from '../collaboration-types.js';

const grounded = (id: string, keyPoints: string[], ranked?: { alternative: string; score: number; rank: number }[]): PersonaPerspective => ({
  personaId: id, opinion: 'o', kind: 'knowledge_grounded', retrievedCount: keyPoints.length,
  evidence: keyPoints.map((k, i) => ({ memoryId: `${id}-${i}`, excerpt: k, relevance: 0.5, association: false })),
  keyPoints, ...(ranked ? { rankedAlternatives: ranked } : {}),
});
const offline = (id: string): PersonaPerspective => ({ personaId: id, opinion: '暂无积累', kind: 'honest_offline', retrievedCount: 0, evidence: [], keyPoints: [] });

const mode = new MultiPerspectiveAggregation();

test('modeId = multi_perspective + requiresHumanApproval 恒 true', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算'])]);
  assert.equal(r.modeId, 'multi_perspective');
  assert.equal(r.requiresHumanApproval, true);
});

test('commonTopics：两 grounded 共提「预算」→ 入 commonTopics，raisedBy 含两者', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算', '市场']), grounded('b', ['预算', '风险'])]);
  const topic = r.commonTopics.find((t) => t.topic === '预算');
  assert.ok(topic);
  assert.deepEqual([...topic!.raisedBy].sort(), ['a', 'b']);
});

test('honest_offline 的套话不进 commonTopics', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算']), offline('b')]);
  assert.equal(r.commonTopics.length, 0);   // 只一个 grounded persona，无共同（需 ≥2）
});

test('全 offline → insufficient_grounding + 空话题/分歧', () => {
  const r = mode.aggregate('q', [offline('a'), offline('b')]);
  assert.equal(r.status, 'insufficient_grounding');
  assert.deepEqual(r.commonTopics, []);
  assert.deepEqual(r.rankingDivergences, []);
  assert.ok(r.groundingNote.length > 0);
});

test('≥1 grounded → analyzed；G<半数 → groundingNote 标积累不足', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算']), offline('b'), offline('c')]);
  assert.equal(r.status, 'analyzed');
  assert.match(r.groundingNote, /不足|仅/);
});

test('rankingDivergences：同候选被排到不同 rank → 入分歧', () => {
  const r = mode.aggregate('q', [
    grounded('a', ['x'], [{ alternative: '扩张', score: 0.9, rank: 1 }, { alternative: '收缩', score: 0.2, rank: 2 }]),
    grounded('b', ['y'], [{ alternative: '扩张', score: 0.3, rank: 2 }, { alternative: '收缩', score: 0.8, rank: 1 }]),
  ]);
  const d = r.rankingDivergences.find((x) => x.alternative === '扩张');
  assert.ok(d);
  assert.deepEqual(d!.rankings.map((r) => r.rank).sort(), [1, 2]);
});

test('确定性：同输入两次 aggregate 结果全等', () => {
  const input: PersonaPerspective[] = [grounded('a', ['预算', '市场']), grounded('b', ['预算'])];
  assert.deepEqual(mode.aggregate('q', input), mode.aggregate('q', input));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/collaboration/modes/multi-perspective-aggregation.test.ts`
Expected: FAIL（`MultiPerspectiveAggregation` 未定义）

- [ ] **Step 3: 写 collaboration-mode.ts（接口 re-export + doc）**

```typescript
// src/collaboration/collaboration-mode.ts
/** 可插拔协同模式策略接口。首实现 MultiPerspectiveAggregation（多视角汇聚）；
 * 后续「角色分工 / 辩论共识」各加 implements，编排壳（CollaborativeAnalysisService）不变。 */
export type { CollaborationMode } from './collaboration-types.js';
```

- [ ] **Step 4: 写 MultiPerspectiveAggregation 实现**

```typescript
// src/collaboration/modes/multi-perspective-aggregation.ts
/** 多视角汇聚（确定性、零-LLM）：共同话题（关键词重叠）+ 排序分歧（结构化）+ 证据摘要（模板拼装）。
 * 诚实命名：commonTopics 是「共同关注的话题」非「共识」；evidenceBrief 是「证据摘要」非「综合建议」（spec §5.2 / 约束 5）。 */
import type { CollaborationMode } from '../collaboration-types.js';
import type { CollaborativeReport, PersonaPerspective } from '../collaboration-types.js';

export class MultiPerspectiveAggregation implements CollaborationMode {
  readonly modeId = 'multi_perspective';

  aggregate(question: string, perspectives: readonly PersonaPerspective[]): CollaborativeReport {
    const groundedViews = perspectives.filter((p) => p.kind === 'knowledge_grounded');
    const g = groundedViews.length;
    const commonTopics = this.computeCommonTopics(groundedViews);
    const rankingDivergences = this.computeRankingDivergences(perspectives);
    const status: CollaborativeReport['status'] = g === 0 ? 'insufficient_grounding' : 'analyzed';
    const groundingNote = this.groundingNote(g, perspectives.length);
    return {
      question,
      modeId: this.modeId,
      status,
      perspectives,
      commonTopics: status === 'insufficient_grounding' ? [] : commonTopics,
      rankingDivergences: status === 'insufficient_grounding' ? [] : rankingDivergences,
      evidenceBrief: this.buildBrief(question, commonTopics, rankingDivergences, groundedViews, status),
      groundingNote,
      requiresHumanApproval: true,
    };
  }

  /** 某 topic 被 ≥2 个 grounded persona 提到即为共同话题（raisedBy 记提到者）。稳定序（topic 字典序）。 */
  private computeCommonTopics(grounded: readonly PersonaPerspective[]): { topic: string; raisedBy: string[] }[] {
    const byTopic = new Map<string, Set<string>>();
    for (const p of grounded) {
      for (const kp of p.keyPoints) {
        if (!byTopic.has(kp)) byTopic.set(kp, new Set());
        byTopic.get(kp)!.add(p.personaId);
      }
    }
    const topics: { topic: string; raisedBy: string[] }[] = [];
    for (const [topic, raisers] of byTopic) {
      if (raisers.size >= 2) topics.push({ topic, raisedBy: [...raisers].sort() });
    }
    return topics.sort((a, b) => a.topic.localeCompare(b.topic));
  }

  /** 同一 alternative 被 ≥2 persona 排到不同 rank → 分歧。稳定序（alternative 字典序）。 */
  private computeRankingDivergences(perspectives: readonly PersonaPerspective[]): CollaborativeReport['rankingDivergences'] {
    const byAlt = new Map<string, { personaId: string; rank: number }[]>();
    for (const p of perspectives) {
      for (const ra of p.rankedAlternatives ?? []) {
        if (!byAlt.has(ra.alternative)) byAlt.set(ra.alternative, []);
        byAlt.get(ra.alternative)!.push({ personaId: p.personaId, rank: ra.rank });
      }
    }
    const out: { alternative: string; rankings: { personaId: string; rank: number }[] }[] = [];
    for (const [alternative, rankings] of byAlt) {
      const ranks = new Set(rankings.map((r) => r.rank));
      if (rankings.length >= 2 && ranks.size >= 2) {
        out.push({ alternative, rankings: [...rankings].sort((a, b) => a.personaId.localeCompare(b.personaId)) });
      }
    }
    return out.sort((a, b) => a.alternative.localeCompare(b.alternative));
  }

  private groundingNote(g: number, total: number): string {
    if (g === 0) return '参与者对此问题均无相关积累，无法给出有据视角。';
    if (g < Math.ceil(total / 2)) return `多数参与者对此问题积累不足，仅 ${g} 个视角有依据。`;
    return `基于 ${total} 位数字人各自学习积累（${g} 个视角有据）。`;
  }

  /** 纯模板拼装证据摘要——不产新观点/新结论（约束 5）。 */
  private buildBrief(
    question: string,
    commonTopics: { topic: string; raisedBy: string[] }[],
    divergences: CollaborativeReport['rankingDivergences'],
    grounded: readonly PersonaPerspective[],
    status: CollaborativeReport['status'],
  ): string {
    if (status === 'insufficient_grounding') return `问题「${question}」：参与者均无相关积累，无证据摘要。`;
    const parts: string[] = [`问题「${question}」证据摘要（确定性汇总，非综合建议）：`];
    if (commonTopics.length > 0) parts.push(`共同关注话题：${commonTopics.map((t) => `${t.topic}（${t.raisedBy.join('、')}）`).join('；')}。`);
    if (divergences.length > 0) parts.push(`排序分歧：${divergences.map((d) => `${d.alternative}[${d.rankings.map((r) => `${r.personaId}=第${r.rank}`).join(',')}]`).join('；')}。`);
    for (const p of grounded) {
      const refs = p.evidence.slice(0, 3).map((e) => `${e.memoryId}:${e.excerpt.slice(0, 20)}`).join(' / ');
      parts.push(`- ${p.personaId} 依据：${refs}`);
    }
    return parts.join('\n');
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test src/collaboration/modes/multi-perspective-aggregation.test.ts`
Expected: PASS（7 测试）

- [ ] **Step 6: 编译验证**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/collaboration/collaboration-mode.ts src/collaboration/modes/
git commit -m "feat(collab): MultiPerspectiveAggregation 确定性汇聚（共同话题/排序分歧/证据摘要）"
```

---

## Task 5: `CollaborativeAnalysisService` 编排 + service E2E

> **拆分（Codex 复审 #7）**：原 Task 5 同时含 service + HTTP route + 组合根，范围过大无法独立 review。拆为 **Task 5（service + 真实隔离/零-LLM/校验测试）** + **Task 6（NoOpEmbeddingIndex 已在此 Step 0、boundary-utils、route、组合根、HTTP 测试）**。

**Files:**
- Create: `src/collaboration/no-op-embedding-index.ts`（+ test）——零-LLM 结构保证
- Create: `src/conversation/boundary-utils.ts`（提取 `isValidBoundary`，供 conversation-service + collaboration 共享）
- Modify: `src/conversation/conversation-service.ts`（改为从 `boundary-utils.js` import `isValidBoundary`，删本地定义——纯搬迁，行为不变）
- Create: `src/collaboration/collaborative-analysis-service.ts`
- Test: `src/collaboration/collaborative-analysis-service.test.ts`（编排 + 校验 + 隔离 + 零-LLM E2E）

**Interfaces:**
- Consumes: `TenantOSFactory`（`getTenantOS(tenantId)` → `getCore(personaId)`）、`PersonaCoreService`（`getPersonaDetail(tenantId, ownerUserId, personaId)`）、`CollaborationMode`（Task 4）、`PersonaPerspectiveAnalyzer`（Task 3）、`RuleEngine` + `DecisionEngine` + `RetrievalService`（`src/intelligence/`）、`OfflineConversationResponder`、`NotFoundError`/`ErrorCode`（`errors/index`）、`BehaviorBoundary`（`enterprise/persona-template-catalog`）、`isValidBoundary`（`conversation/boundary-utils`）。
- Produces: `class CollaborativeAnalysisService`，`analyze(tenantId, ownerUserId, personaIds, req): CollaborativeReport`；`class NoOpEmbeddingIndex implements EmbeddingIndex`。

**真实契约（Global Constraint 7）：**
- 校验先行：`personaIds` 空 → 校验错；`question` 空 → 校验错；去重保序；每个 personaId 先 `getPersonaDetail(tenantId, ownerUserId, personaId)`，返回 `null` → 抛 `NotFoundError(..., ErrorCode.NOT_FOUND_PERSONA)`（不区分 NotFound/Forbidden）**在 getCore 之前**。
- boundaries：从 `getPersonaDetail(...).profile.behaviorBoundaries`（`filter(isValidBoundary)`，照 `conversation-service.ts:604-610`）。
- **决策引擎 service 自建（Codex 复审 #5/#6 校正——用 no-op EmbeddingIndex + llm=undefined，最直接且结构性零-LLM）**：`DecisionEngine` ctor 的 `llm` 参数**是可选的**（`decision-engine.ts:67` `llm: LLMProvider | undefined`）；`RetrievalService(memories, embeddingIndex)` 的 `embeddingIndex` 必填但 **autonomous 路径永不调 `this.retrieval`**（`decision-engine.ts:140` getContext 只在 growth）。故最简装配 = **传一个 `NoOpEmbeddingIndex`（search 返 `[]`、indexMemory 返 `false`，零 LLM，Task 5 Step 0 新建）+ `llm: undefined`**——这样**构造链里没有任何 LLMProvider**，零-LLM 是结构性保证（非「不调就行」）。service 自建 DecisionEngine（不需注入工厂），只经 `AutonomousDecisionEngine` 窄接口调 `evaluateAutonomous`（约束 1 类型层保证不退回 growth/LLM）。
- 每 persona 造 analyzer：`const core = os.getCore(personaId)`；`retrieve = (q) => retrieveMemoriesDeterministic(q, core.memories.getAllMemories(), (id) => core.memories.getEdgesFor(id), undefined)`；`decisionEngine = new DecisionEngine(core, new RetrievalService(core.memories, noOpIndex), undefined /*llm*/, clock, logger, simConfig, ruleEngine)`；`responder = new OfflineConversationResponder()`；**`narrative` 来自 `profile.narrative`（不是 `core.narrative.get()`）**——照 `conversation-service.ts:606` 真实取法：`typeof profile.narrative === 'string' ? profile.narrative : ''`（与 boundaries 同源 profile，一处 getPersonaDetail 全取）。
- **isValidBoundary（已核实 `conversation-service.ts:758` 局部未导出）**：实现二选一：① 从 `conversation-service.ts` 加 `export` 复用；② **推荐**——把 `isValidBoundary` + `BehaviorBoundary` 相关校验提取到轻量共享模块（如 `src/conversation/boundary-utils.ts`），conversation-service 与 collaboration 都 import（Codex 建议：避免 collaboration import 整个 conversation-service 造成模块耦合）。boundaries 取法照 `conversation-service.ts:608-610`。
- **错误码（Codex 复审 #6）**：persona 校验失败**不用自定义 `Error`**（会被全局 handler 当未知 500）——**复用 `NotFoundError(msg, ErrorCode.NOT_FOUND_PERSONA)`**（照 `earning.ts:40` 先例 `assertOwner`），映射 404，且「不存在或非 owner」统一措辞天然不区分 NotFound/Forbidden、不泄露跨租户存在性（正是约束 7 要的）。删除计划里自定义的 `PersonaUnavailableError`。
- 单 persona：正常执行（mode 天然出空 commonTopics/divergences）；不特判。

- [ ] **Step 0a: 建 `NoOpEmbeddingIndex`（零-LLM 结构保证）+ 其失败测试**

```typescript
// src/collaboration/no-op-embedding-index.ts
/** 空实现 EmbeddingIndex：search 恒空、indexMemory 恒 false，无任何 LLM/embedding 调用。
 * 用于 autonomous 决策路径（永不查询 embedding，decision-engine.ts:140 只在 growth 用），
 * 让 DecisionEngine 构造链完全不含 LLMProvider——零-LLM 是结构性保证（约束 1）。 */
import type { EmbeddingIndex, EmbeddingMatch } from '../intelligence/embedding-index.js';

export class NoOpEmbeddingIndex implements EmbeddingIndex {
  async indexMemory(_memoryId: string, _text: string): Promise<boolean> { return false; }
  search(_queryEmbedding: readonly number[], _topK: number): EmbeddingMatch[] { return []; }
  readonly cacheSize = 0;
  readonly partitionCount = 0;
}
```
```typescript
// src/collaboration/no-op-embedding-index.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoOpEmbeddingIndex } from './no-op-embedding-index.js';

test('NoOpEmbeddingIndex：search 恒空、indexMemory 恒 false、无 LLM 依赖', async () => {
  const idx = new NoOpEmbeddingIndex();
  assert.deepEqual(idx.search([0.1, 0.2], 5), []);
  assert.equal(await idx.indexMemory('m', 'x'), false);
  assert.equal(idx.cacheSize, 0);
});
```
Run: `npx tsx --test src/collaboration/no-op-embedding-index.test.ts`（先红后绿）
> 实现者注：`EmbeddingIndex` 接口方法以 `src/intelligence/embedding-index.ts:27` 为准（若还有别的成员，NoOp 补齐最简空实现）；`EmbeddingMatch` 从同文件 import。

- [ ] **Step 0b: 提取 `isValidBoundary` 到 `boundary-utils.ts`（避免 collaboration 耦合整个 conversation-service）**

把 `conversation-service.ts:758` 的局部 `isValidBoundary`（及它依赖的 `BehaviorBoundary` 校验逻辑）**搬**到新文件 `src/conversation/boundary-utils.ts` 并 `export`；`conversation-service.ts` 改为从 `boundary-utils.js` import（删本地定义）。纯搬迁，行为不变。
Run（回归 conversation-service 未破坏）：`npx tsx --test src/conversation/conversation-service.test.ts`
Expected: PASS（只搬函数位置，逻辑不变）

- [ ] **Step 1: 写 service 失败测试（隔离 + 校验 + 零-LLM E2E，用真 TenantOSFactory + 内存 DB）**

```typescript
// src/collaboration/collaborative-analysis-service.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollaborativeAnalysisService } from './collaborative-analysis-service.js';
import { MultiPerspectiveAggregation } from './modes/multi-perspective-aggregation.js';
import { NotFoundError } from '../errors/index.js';
// 复用既有测试夹具建租户 OS + persona core（照 src/test/unit/persona-core-service.test.ts + src/test/integration/persona-core-isolation-k1.test.ts 的建库+seed 惯例）。
// 实现者：用与既有集成测试同款 in-memory sqlite + TenantOSFactory + PersonaCoreService 装配。

test('未知/他 owner personaId → NotFoundError NOT_FOUND_PERSONA（不静默产空核）', async () => {
  const { service } = await setup();
  assert.throws(
    () => service.analyze('t1', 'user_1', ['does-not-exist'], { question: 'q' }),
    (e: unknown) => e instanceof NotFoundError && /不存在或调用者非 owner/.test((e as Error).message),
  );
});

test('跨租户/他 owner persona：owner=user_2 请求 user_1 的 persona → NotFoundError（不泄露存在性）', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '投资 预算');   // 属 user_1
  assert.throws(
    () => service.analyze('t1', 'user_2', ['pa'], { question: 'q' }),   // user_2 借不到
    (e: unknown) => e instanceof NotFoundError,
  );
});

test('per-persona 隔离：两 persona 均 grounded、evidence 均非空、memoryId 集不相交、A 内容不入 B', async () => {
  const { service, seedMemory } = await setup();
  // 查询用共同主题词「投资」，两边各含它 + 各自独有词，确保两边都命中（非空）才能真验隔离。
  seedMemory('t1', 'user_1', 'pa', '投资 扩张 关键词ALPHA');
  seedMemory('t1', 'user_1', 'pb', '投资 收紧 关键词BETA');
  const report = service.analyze('t1', 'user_1', ['pa', 'pb'], { question: '投资 怎么看' });
  const [va, vb] = ['pa', 'pb'].map((id) => report.perspectives.find((p) => p.personaId === id)!);
  assert.equal(va.kind, 'knowledge_grounded');           // 两边都真 grounded（非空集假绿）
  assert.equal(vb.kind, 'knowledge_grounded');
  assert.ok(va.evidence.length > 0 && vb.evidence.length > 0);  // 两边 evidence 非空
  const aIds = new Set(va.evidence.map((e) => e.memoryId));
  const bIds = new Set(vb.evidence.map((e) => e.memoryId));
  assert.ok([...aIds].every((id) => !bIds.has(id)));     // memoryId 集不相交（各自 seed）
  assert.ok(!vb.evidence.some((e) => e.excerpt.includes('ALPHA')));  // A 独有内容不进 B
  assert.ok(!va.evidence.some((e) => e.excerpt.includes('BETA')));   // B 独有内容不进 A
});

test('多视角真不同：两 persona 学不同内容 → 两边 grounded、keyPoints 不同、evidence memoryId 不相交', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '投资 扩张 有利 市场');
  seedMemory('t1', 'user_1', 'pb', '投资 风险 收紧 谨慎');
  const report = service.analyze('t1', 'user_1', ['pa', 'pb'], { question: '投资 要不要扩张' });
  const [va, vb] = ['pa', 'pb'].map((id) => report.perspectives.find((p) => p.personaId === id)!);
  assert.equal(va.kind, 'knowledge_grounded');
  assert.equal(vb.kind, 'knowledge_grounded');
  assert.ok(va.evidence.length > 0 && vb.evidence.length > 0);
  const aIds = new Set(va.evidence.map((e) => e.memoryId));
  assert.ok(!vb.evidence.some((e) => aIds.has(e.memoryId)));       // memoryId 不相交
  assert.notDeepEqual([...va.keyPoints].sort(), [...vb.keyPoints].sort());  // keyPoints 真不同
});

test('零-LLM：构造链无 LLMProvider（NoOpEmbeddingIndex + llm=undefined），带 alternatives 真走 DecisionEngine + 确定性', async () => {
  const { service, seedMemory } = await setup();  // setup 全程不配任何 LLM provider
  seedMemory('t1', 'user_1', 'pa', '投资 预算 约束');
  // 带 alternatives → analyzer 调 evaluateAutonomous → RuleEngine（真走决策路径，证零-LLM 下决策也跑得通）
  const req = { question: '投资 预算够吗', alternatives: ['继续投资', '暂缓投资'] };
  const r1 = service.analyze('t1', 'user_1', ['pa'], req);
  const r2 = service.analyze('t1', 'user_1', ['pa'], req);
  assert.equal(r1.perspectives[0].kind, 'knowledge_grounded');       // 真跑出 grounded（非空假绿）
  assert.equal(r1.perspectives[0].rankedAlternatives?.length, 2);    // DecisionEngine→evaluateAutonomous 真执行
  assert.deepEqual(r1, r2);                                          // 确定性（无 Date/random）
});

test('单 persona：正常产报告，commonTopics/rankingDivergences 空', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '预算 约束');
  const r = service.analyze('t1', 'user_1', ['pa'], { question: '预算够吗' });
  assert.deepEqual(r.commonTopics, []);
  assert.deepEqual(r.rankingDivergences, []);
});

test('空 personaIds → 校验错；空 question → 校验错；重复去重', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '投资 预算');
  assert.throws(() => service.analyze('t1', 'user_1', [], { question: 'q' }));       // 空 personaIds
  assert.throws(() => service.analyze('t1', 'user_1', ['pa'], { question: '  ' }));  // 空 question
  const r = service.analyze('t1', 'user_1', ['pa', 'pa'], { question: '投资 预算' });
  assert.equal(r.perspectives.length, 1);  // 去重
});

// setup()/seedMemory() 由实现者按既有集成测试夹具装配（in-memory sqlite + TenantOSFactory + PersonaCoreService）。
```
> 实现者注：`setup()` 与 `seedMemory()` 沿用既有集成测试建库/建 persona/写记忆惯例（参考 `src/test/unit/persona-core-service.test.ts` 与 `src/test/integration/persona-core-isolation-k1.test.ts` 如何 seed persona core 与 memories）。**必须真建两 persona 各写不同记忆并各含共同主题词**（如「投资」），否则查询命不中、evidence 为空、隔离/多视角断言假绿——上面的测试已强制断言 `kind==='knowledge_grounded'` + `evidence.length>0` 堵这个假绿。`setup()` 装配 `CollaborativeAnalysisService` 时**只传 `{factory, personaCoreService, mode: new MultiPerspectiveAggregation(), config}`，不传任何 LLM provider**——service 内部用 `NoOpEmbeddingIndex` + `llm=undefined`，构造链无 LLMProvider，零-LLM 是结构性保证（不再需要 llmStub 计数验证，因为根本没有 LLM 依赖可调）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/collaboration/collaborative-analysis-service.test.ts`
Expected: FAIL（`CollaborativeAnalysisService` 未定义）

- [ ] **Step 3: 写 service 实现**

```typescript
// src/collaboration/collaborative-analysis-service.ts
/** 编排：逐 persona 经 getTenantOS().getCore() 解析各自内核 → 单 persona 分析 → mode 汇聚（spec §5.3）。
 * fail-closed：未知/跨租户 persona 先经 getPersonaDetail 校验，抛 NotFoundError NOT_FOUND_PERSONA（约束 7）。 */
import type { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { CollaborationMode, AnalysisRequest, CollaborativeReport } from './collaboration-types.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';   // 真实定义处 :23
import type { AppConfig } from '../config/index.js';                                  // 实现者核实真实导出
import { PersonaPerspectiveAnalyzer } from './persona-perspective-analyzer.js';
import { retrieveMemoriesDeterministic } from '../conversation/deterministic-memory-retrieval.js';
import { OfflineConversationResponder } from '../conversation/offline-conversation-responder.js';
import { DecisionEngine } from '../intelligence/decision-engine.js';
import { RuleEngine } from '../intelligence/rule-engine.js';
import { RetrievalService } from '../intelligence/retrieval-service.js';
import { NoOpEmbeddingIndex } from './no-op-embedding-index.js';   // Task 5 Step 0 新建（零-LLM 结构保证）
import { isValidBoundary } from '../conversation/boundary-utils.js';   // 推荐：提取到共享模块（见上）
import { NotFoundError, ValidationError, ErrorCode } from '../errors/index.js';   // 已核实：errors.ts:91 ValidationError + ErrorCode.NOT_FOUND_PERSONA/VALIDATION_REQUIRED；earning.ts:40 同款用法

export interface CollaborativeAnalysisDeps {
  readonly factory: TenantOSFactory;
  readonly personaCoreService: PersonaCoreService;
  readonly mode: CollaborationMode;
  readonly config: AppConfig;   // 取 ruleEngine / intelligence.simulation 配置
}

export class CollaborativeAnalysisService {
  constructor(private readonly deps: CollaborativeAnalysisDeps) {}

  analyze(tenantId: string, ownerUserId: string, personaIds: readonly string[], req: AnalysisRequest): CollaborativeReport {
    const question = req.question?.trim();
    if (!question) throw new ValidationError('question 不能为空', ErrorCode.VALIDATION_REQUIRED);
    const unique = [...new Set(personaIds)];
    if (unique.length === 0) throw new ValidationError('personaIds 不能为空', ErrorCode.VALIDATION_REQUIRED);
    const os = this.deps.factory.getTenantOS(tenantId);
    const clock = os.getClock();
    const logger = os.getLogger();
    const noOpIndex = new NoOpEmbeddingIndex();   // 零-LLM：构造链无 LLMProvider（autonomous 不查询它）

    /* 先全量校验存在+归属（fail-closed），再解析 core——避免为无效 persona 建空核（约束 7）。
     * 统一 NotFoundError（照 earning.ts:40），不区分 NotFound/Forbidden，不泄露跨租户存在性。 */
    const profiles = unique.map((personaId) => {
      const detail = this.deps.personaCoreService.getPersonaDetail(tenantId, ownerUserId, personaId);
      if (!detail) throw new NotFoundError(`persona ${personaId} 不存在或调用者非 owner`, ErrorCode.NOT_FOUND_PERSONA);
      return { personaId, detail };
    });

    const perspectives = profiles.map(({ personaId, detail }) => {
      const core = os.getCore(personaId);
      /* narrative + boundaries 同源 profile（照 conversation-service.ts:604-610 真实取法）。 */
      const profile = (detail.profile ?? {}) as Record<string, unknown>;
      const narrative = typeof profile.narrative === 'string' ? profile.narrative : '';
      const boundaries: BehaviorBoundary[] = Array.isArray(profile.behaviorBoundaries)
        ? (profile.behaviorBoundaries as BehaviorBoundary[]).filter(isValidBoundary)
        : [];
      /* 必须 always-enabled RuleEngine：autonomous 无 ruleEngine 抛错（decision-engine.ts:114），
       * disabled ruleEngine 的 evaluate 也抛「Rule engine disabled」（rule-engine.ts:42）。
       * collaboration 的决策是确定性零-LLM 一等主路径，无理由随 tenant config 关掉 → 强制 enabled:true。 */
      const ruleEngine = new RuleEngine(clock, { ...this.deps.config.ruleEngine, enabled: true }, logger);
      /* llm=undefined + noOpIndex → 构造链零 LLMProvider（结构性零-LLM，约束 1）。 */
      const decisionEngine = new DecisionEngine(
        core, new RetrievalService(core.memories, noOpIndex), undefined /* llm */, clock, logger,
        this.deps.config.intelligence.simulation, ruleEngine,
      );
      const analyzer = new PersonaPerspectiveAnalyzer({
        retrieve: (q) => retrieveMemoriesDeterministic(q, core.memories.getAllMemories(), (id) => core.memories.getEdgesFor(id), undefined),
        decisionEngine,
        responder: new OfflineConversationResponder(),
        narrative,
        boundaries,
      });
      return analyzer.analyze(personaId, req);
    });

    return this.deps.mode.aggregate(question, perspectives);
  }
}
```
> 实现者注：`RuleEngine`/`RetrievalService`/`DecisionEngine`/`AppConfig` 装配以 `app.ts:679`（earning autonomous）为参考；`detail.profile.{narrative,behaviorBoundaries}` 字段+`isValidBoundary` 照 `conversation-service.ts:604-610`。

- [ ] **Step 4: 运行 service 测试确认通过**

Run: `npx tsx --test src/collaboration/collaborative-analysis-service.test.ts src/collaboration/no-op-embedding-index.test.ts`
Expected: PASS（service 全部 + NoOp）

- [ ] **Step 5: 编译 + Commit**

Run: `npx tsc -p tsconfig.json --noEmit`（PASS）

```bash
git add src/collaboration/collaborative-analysis-service.ts src/collaboration/collaborative-analysis-service.test.ts src/collaboration/no-op-embedding-index.ts src/collaboration/no-op-embedding-index.test.ts src/conversation/boundary-utils.ts src/conversation/conversation-service.ts
git commit -m "feat(collab): CollaborativeAnalysisService 编排（隔离/校验/结构性零-LLM）+ NoOpEmbeddingIndex + 提取 boundary-utils"
```

---

## Task 6: HTTP 端点 `/collaboration/analyze` + 组合根注册 + route 测试

**Files:**
- Create: `src/server/routes/collaboration.ts`
- Modify: `src/server/app.ts`（装配 service + 注册路由）
- Test: `src/server/routes/collaboration.test.ts`（HTTP 层：鉴权门 + body 校验 + 404 映射 + 成功信封）

**Interfaces:**
- Consumes: `CollaborativeAnalysisService`（Task 5）、`MultiPerspectiveAggregation`（Task 4）、既有 fastify 注册/鉴权骨架（照 `decisions.ts` / companion route）。
- Produces: `registerCollaborationRoutes(app, service)` + 已注册的 `POST /api/v1/collaboration/analyze`。

**鉴权/身份（照既有 companion/decisions route 真实惯例）：**
- 从鉴权上下文取 `tenantId` + `ownerUserId`（`request.user.sub`）；**必须复用既有「仅个人用户会话」访问门**（照 `chat.ts:118 assertCompanionAccess`：拒 `apikey:`/`role==='service'` 主体）——否则 API-key 主体可越权。
- body schema：`question` 非空字符串、`personaIds` 非空字符串数组、`alternatives?` 字符串数组——用项目既有 fastify schema 校验方式。
- 错误码映射走既有全局 error handler：`NotFoundError`→404、校验错→400（service 已抛 `NotFoundError`/校验错，端点不重复判）。

- [ ] **Step 1: 写 route 失败测试（HTTP 层，用既有 app 测试夹具 inject）**

```typescript
// src/server/routes/collaboration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// 用既有 app/server 测试夹具（照 src/test/integration/persona-core-api.test.ts 等 route 集成测试如何 build app + 发 JWT + inject）。

test('未认证 → 401', async () => {
  const { app } = await buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/collaboration/analyze', payload: { question: 'q', personaIds: ['pa'] } });
  assert.equal(res.statusCode, 401);
});

test('API-key/service 主体 → 403（复用 companion 访问门）', async () => {
  const { app, apiKeyToken } = await buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/collaboration/analyze', headers: { authorization: `Bearer ${apiKeyToken}` }, payload: { question: 'q', personaIds: ['pa'] } });
  assert.equal(res.statusCode, 403);
});

test('空 personaIds / 空 question → 400', async () => {
  const { app, userToken } = await buildTestApp();
  const bad1 = await app.inject({ method: 'POST', url: '/api/v1/collaboration/analyze', headers: { authorization: `Bearer ${userToken}` }, payload: { question: 'q', personaIds: [] } });
  assert.equal(bad1.statusCode, 400);
  const bad2 = await app.inject({ method: 'POST', url: '/api/v1/collaboration/analyze', headers: { authorization: `Bearer ${userToken}` }, payload: { question: '', personaIds: ['pa'] } });
  assert.equal(bad2.statusCode, 400);
});

test('未知 persona → 404', async () => {
  const { app, userToken } = await buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/collaboration/analyze', headers: { authorization: `Bearer ${userToken}` }, payload: { question: 'q', personaIds: ['nope'] } });
  assert.equal(res.statusCode, 404);
});

test('成功 → 200，信封 {data: CollaborativeReport}，requiresHumanApproval=true', async () => {
  const { app, userToken, seedPersonaWithMemory } = await buildTestApp();
  seedPersonaWithMemory('pa', '投资 预算 约束');
  const res = await app.inject({ method: 'POST', url: '/api/v1/collaboration/analyze', headers: { authorization: `Bearer ${userToken}` }, payload: { question: '投资 预算够吗', personaIds: ['pa'] } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.requiresHumanApproval, true);
  assert.equal(body.data.modeId, 'multi_perspective');
});
```
> 实现者注：`buildTestApp()` / `userToken` / `apiKeyToken` / `seedPersonaWithMemory()` 照既有 route 集成测试夹具（如 `src/test/integration/persona-core-api.test.ts`）如何 build 真实 fastify app、签发不同主体 JWT、seed persona——**必须真发 HTTP inject**，非直接调 service（HTTP 层的鉴权门/schema/错误映射只有走 inject 才被验证）。

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test src/server/routes/collaboration.test.ts`
Expected: FAIL（路由未注册 / 未定义）

- [ ] **Step 3: 写端点 `collaboration.ts`**

```typescript
// src/server/routes/collaboration.ts
/** POST /api/v1/collaboration/analyze —— 多数字人协同分析（spec §5.4）。
 * 鉴权/租户从上下文取 + 复用 companion「仅个人用户会话」访问门；校验/降级全在 service。 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CollaborativeAnalysisService } from '../../collaboration/collaborative-analysis-service.js';
import { AuthorizationError, ErrorCode } from '../../errors/index.js';
import type { JwtPayload } from '../../types/auth.js';   // 已核实：types/auth.ts:10（earning.ts:16 同款）

/** 复用 companion 访问门（照 chat.ts:118）：拒 API-key / service 主体。 */
function assertUserSession(request: FastifyRequest): void {
  const user = request.user as JwtPayload | undefined;
  if (user?.sub?.startsWith('apikey:') || user?.role === 'service') {
    throw new AuthorizationError('协同分析仅支持个人用户会话', ErrorCode.AUTH_INSUFFICIENT_ROLE);
  }
}

const bodySchema = {
  type: 'object',
  required: ['question', 'personaIds'],
  properties: {
    question: { type: 'string', minLength: 1 },
    personaIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    alternatives: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function registerCollaborationRoutes(app: FastifyInstance, service: CollaborativeAnalysisService): void {
  app.post('/api/v1/collaboration/analyze', { schema: { body: bodySchema } }, async (request, reply) => {
    assertUserSession(request);
    const { question, alternatives, personaIds } = request.body as { question: string; alternatives?: string[]; personaIds: string[] };
    const tenantId = request.tenantId;
    const ownerUserId = (request.user as JwtPayload).sub;
    const report = service.analyze(tenantId, ownerUserId, personaIds, { question, alternatives });
    return reply.send({ data: report });   // 单键 {data} 信封（前端自动解包）
  });
}
```
> 实现者注：`AuthorizationError`/`ErrorCode.AUTH_INSUFFICIENT_ROLE`/`JwtPayload`/fastify body schema 写法照真实仓库（`chat.ts` + 既有 route）；schema 校验失败由 fastify 映射 400，`AuthorizationError`→403、`NotFoundError`→404 由全局 handler。

- [ ] **Step 4: 在 app.ts 装配 + 注册**

在 `src/server/app.ts` 集中注册处装配 `CollaborativeAnalysisService`：`{ factory: tenantFactory, personaCoreService: <既有实例>, mode: new MultiPerspectiveAggregation(), config }`，然后 `registerCollaborationRoutes(app, collaborativeAnalysisService)`。service 内部自建 per-persona DecisionEngine（NoOpEmbeddingIndex + llm=undefined），**app.ts 无需传 LLM/embedding**——组合根干净。

- [ ] **Step 5: route 测试 + 全 collaboration 测试 + 编译全绿**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsx --test src/collaboration/*.test.ts src/collaboration/modes/*.test.ts src/server/routes/collaboration.test.ts`
Expected: PASS（Task 2-6 全部）

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/collaboration.ts src/server/routes/collaboration.test.ts src/server/app.ts
git commit -m "feat(collab): /collaboration/analyze 端点（个人会话门/body 校验/404 映射）+ 组合根注册 + HTTP 测试"
```

---

## 收尾（全 task 完成后）

- [ ] **本地全量门（约束：merge 前必跑 test:golden 全门，见 memory `merge-gate-must-run-test-golden`）**

Run: `npm run test:golden`
Expected: EXIT 0（typecheck→build→unit+integration→contract→packages→ops→ga:check→licenses→db-access 全绿）。
> 本能力**不新增迁移、不碰 SAFE-EXEMPT 表、不持久化**（约束 7 无触发）——理论上 schema-dsl 同步点/db-access ratchet 无需动；但**必须实际跑全门确认**（route-schema 快照若变需 `UPDATE_SNAPSHOTS=1` 重生，见 memory `digital-org-visualization`）。

- [ ] **最终整片 code review**（subagent-driven-development 终审：最强模型审全分支）。

---

## Self-Review（writing-plans 自检）

**Spec 覆盖**：§5.1 analyzer→Task 3；§5.2 mode+aggregation→Task 4；§5.3 service→Task 5；§5.4 端点→Task 6；§6 不持久化（无迁移 task，正确）；§7 可验证性 8 条→分散在 Task 3/4/5/6 测试；共享类型→Task 1；keyPoints→Task 2。全覆盖。

**Task 拆分（6 task，Codex 复审 #7 采纳）**：Task 1 类型 → 2 keyPoints → 3 analyzer → 4 aggregation → **5 service（+NoOp+boundary-utils，真实隔离/零-LLM 测试）** → **6 route+组合根+HTTP 测试**。依赖顺序 1→2→3→4→5→6，每 task 独立可测/可 review。

**Placeholder 扫描**：无 TBD/TODO；每个 code step 有完整代码；测试有真实断言且**堵了假绿**（隔离/多视角测试强制 `kind==='knowledge_grounded'` + `evidence.length>0`；route 测试真 HTTP inject 验鉴权门/schema/错误映射）。`setup()`/`buildTestApp()` 明确标「照既有集成测试夹具装配」并给参考文件（非占位，是复用既有惯例的合理委托）。

**类型一致性**：`PersonaPerspective`（Task 1）字段贯穿 Task 3 产、Task 4 消；`retrievedCount`/`evidence`/`keyPoints`/`rankedAlternatives{alternative,score,rank}` 命名跨 task 一致；`evaluateAutonomous` 返回 `rankedOptions[{alternative,rank,overallScore}]`→映射 `{alternative,score,rank}` 一致；`CollaborationMode.aggregate(question, perspectives)` 签名 Task 4 实现与 Task 5 调用一致。

**已核实的真实契约（Codex 复审 1-7 全采纳，均对真实代码验证）**：
- `tokenize` 已导出于 `conversation-knowledge-retriever.ts:185`（非 deterministic 文件）→ Task 2 直接 import，不改任何文件。
- `BehaviorBoundary` 定义+导出于 `enterprise/persona-template-catalog.ts:23`（非 responder）→ Task 3/5 从此 import。
- `DecisionEngine.llm` 参数可选（`decision-engine.ts:67` `LLMProvider | undefined`）+ autonomous 不调 `this.retrieval`（`:140` 只 growth）→ 用 `NoOpEmbeddingIndex`（Task 5 Step 0a）+ `llm=undefined` = 构造链零 LLMProvider（结构性零-LLM）。
- persona 校验失败用 `NotFoundError(..., ErrorCode.NOT_FOUND_PERSONA)`（`earning.ts:40` 先例）→ 映射 404，统一不区分 NotFound/Forbidden 天然不泄露跨租户存在性；**不用自定义 Error**（会成 500）。
- narrative/boundaries 同源 `getPersonaDetail().profile.{narrative,behaviorBoundaries}`（`conversation-service.ts:604-610`），非 core。
- `isValidBoundary` 局部于 `conversation-service.ts:758` → Task 5 Step 0b 提取到 `boundary-utils.ts` 共享（避免耦合整个 conversation-service）。
- commonTopics 首版 = 同规范化 keyPoint token 被 ≥2 grounded persona 提及（规则=代码=测试一致，不写「重叠系数」）。

**仍以仓库为准的次要点**（给了参考文件，实现者对齐即可）：`EmbeddingIndex` 接口完整成员（`embedding-index.ts:27`）、`AppConfig`/`AuthorizationError` 导出路径、fastify body-schema 写法、route 测试夹具惯例（`src/test/integration/persona-core-api.test.ts`）。已核实定死的：`JwtPayload`=`types/auth.ts:10`、`ValidationError`/`ErrorCode.{VALIDATION_REQUIRED,NOT_FOUND_PERSONA}`=`errors.ts`、always-enabled RuleEngine、`app.ts:679` autonomous 装配范式。
