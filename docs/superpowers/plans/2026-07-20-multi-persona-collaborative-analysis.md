# 多数字人协同分析框架 Implementation Plan

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
7. **未知/跨租户 persona fail-closed**：`getCore(personaId)` 对任意字符串新建空 core 无校验（`chrono-synth-os.ts:446`）——必须先 `getPersonaDetail(tenantId, ownerUserId, personaId)` 校验存在+归属，返回 null（不存在/他 owner/跨租户，不可区分）→ 统一拒 `PersonaUnavailable`（不区分 NotFound/Forbidden，防跨租户存在性泄露），拒绝发生在 getCore 之前。
8. **确定性**：同输入同输出——不得用 `Date.now()`/`Math.random()`（如需时钟走注入的 clock）。
9. **中文注释**（项目规范）；SOLID/DRY；函数缩进 ≤3 层。

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
- Test: 无（纯类型；由后续 task 的实现测试间接覆盖——类型错编译期即挂）

**Interfaces:**
- Consumes: `BehaviorBoundary`（`src/conversation/offline-conversation-responder.ts` 导出）、`OfflineResponseKind`（同）。
- Produces: `AnalysisRequest` / `PerspectiveEvidence` / `PersonaPerspective` / `CollaborationMode` / `CollaborativeReport` 供 Task 2/3/4/5 import。

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

## Task 2: 导出 `tokenize` + keyPoints 提取工具

**Files:**
- Modify: `src/conversation/deterministic-memory-retrieval.ts`（给内部 `tokenize` 加 `export`）
- Create: `src/collaboration/key-points.ts`（从 evidence.excerpt 提 keyPoints）
- Test: `src/collaboration/key-points.test.ts`

**Interfaces:**
- Consumes: `tokenize`（本 task 导出）、`PerspectiveEvidence`（Task 1）。
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

- [ ] **Step 3: 给 `tokenize` 加 export**

在 `src/conversation/deterministic-memory-retrieval.ts` 找到 `function tokenize(`（约 line 94 之下的定义处），在其定义前加 `export`：

```typescript
// 改前：function tokenize(...)
// 改后：
export function tokenize(text: string): string[] {  // 保持原签名与实现不变，只加 export
  // ...原实现不动...
}
```
（若 `tokenize` 是 `const tokenize = ...` 形式，则改为 `export const tokenize = ...`；只加导出，不改逻辑。）

- [ ] **Step 4: 写 key-points 实现**

```typescript
// src/collaboration/key-points.ts
/** 从 grounded 证据 excerpt 提取 keyPoints（确定性、零-LLM）：tokenize + 剥样板前缀 + 去重 + 稳定排序。
 * 约束：只从 evidence.excerpt 提，不从 opinion/alternatives（spec §5.1 / 约束 3/4）。 */
import { tokenize } from '../conversation/deterministic-memory-retrieval.js';
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

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test src/collaboration/key-points.test.ts`
Expected: PASS（3 测试）

- [ ] **Step 6: 回归确认 tokenize 导出未破坏检索**

Run: `npx tsx --test src/conversation/deterministic-memory-retrieval.test.ts`
Expected: PASS（若存在该测试文件；只加了 export，逻辑未变）

- [ ] **Step 7: Commit**

```bash
git add src/conversation/deterministic-memory-retrieval.ts src/collaboration/key-points.ts src/collaboration/key-points.test.ts
git commit -m "feat(collab): 导出 tokenize + keyPoints 从 grounded 证据提取（去样板/去重/稳定序）"
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
import type { OfflineConversationResponder, BehaviorBoundary } from '../conversation/offline-conversation-responder.js';
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
> 注：若 `BehaviorBoundary` 未从 `offline-conversation-responder.ts` 导出，实现者从其真实导出模块 import（Task 前置已核实该文件用 `BehaviorBoundary[]`；若类型来自 `conversation-types.ts` 则从那里 import）。

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
- **commonTopics**：只对 `kind==='knowledge_grounded'` 的 perspective 的 `keyPoints` 做关键词重叠（honest_offline/boundary 排除）。用**重叠系数**（`|A∩B| / min(|A|,|B|)`，非 Jaccard——照 memory `companion-associative-memory`）；某 topic 被 ≥2 个 grounded persona 提到即入 commonTopics（首版：`raisedBy` = 提到该 topic 的 personaId 列表，长度 ≥2）。稳定排序（topic 字典序）。
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

## Task 5: `CollaborativeAnalysisService` 编排 + 端点 + E2E

**Files:**
- Create: `src/collaboration/collaborative-analysis-service.ts`
- Create: `src/server/routes/collaboration.ts`
- Modify: `src/server/app.ts`（注册路由，仿既有 `registerXxxRoutes` 惯例）
- Test: `src/collaboration/collaborative-analysis-service.test.ts`（编排 + 校验 + 隔离 + E2E）

**Interfaces:**
- Consumes: `TenantOSFactory`（`getTenantOS(tenantId)` → `getCore(personaId)`）、`PersonaCoreService`（`getPersonaDetail(tenantId, ownerUserId, personaId)`）、`CollaborationMode`（Task 4）、`PersonaPerspectiveAnalyzer`（Task 3）、`RuleEngine` + `DecisionEngine`（`src/intelligence/`）、`OfflineConversationResponder`、`RetrievalService`。
- Produces: `class CollaborativeAnalysisService`，`analyze(tenantId, ownerUserId, personaIds, req): CollaborativeReport`。

**真实契约（Global Constraint 7）：**
- 校验先行：`personaIds` 空 → `ValidationError`；去重保序；每个 personaId 先 `getPersonaDetail(tenantId, ownerUserId, personaId)`，返回 `null` → 抛 `PersonaUnavailable`（不区分 NotFound/Forbidden）**在 getCore 之前**。
- boundaries：从 `getPersonaDetail(...).profile.behaviorBoundaries`（`filter(isValidBoundary)`，照 `conversation-service.ts:600-610`）。
- **决策引擎经注入的工厂拿（关键设计——照 earning 先例，让 zero-LLM 特性代码不 import LLMProvider）**：`DecisionEngine` 的 ctor 硬性要求 `RetrievalService`（→ 要 `EmbeddingIndex` → 要 `LLMProvider`），即使 autonomous 路径**永不调** `this.retrieval`（`decision-engine.ts:140` `this.retrieval.getContext` 只在 growth）。为不把 LLM 管线拖进本 zero-LLM 特性，**service 不自己 new DecisionEngine**，而是接收一个注入的工厂 `decisionEngineFor: (core: CoreRhythmLayer) => AutonomousDecisionEngine`——LLM/embedding 装配全留在组合根 `app.ts`（照 `PersonaEarningService` 用注入的 `decisionEngine: AutonomousDecisionEngine` 先例，`app.ts:679`）。**app.ts 里工厂内部**：`(core) => new DecisionEngine(core, new RetrievalService(core.memories, earningEmbeddingIndex 或同款 InMemoryEmbeddingIndex), llmRouter, clock, logger, simConfig, new RuleEngine(...))`（embeddingIndex/llmRouter「仅为构造满足、autonomous 路径不查询」，注释照 `app.ts:674-675`）。service 只经 `AutonomousDecisionEngine` 窄接口调 `evaluateAutonomous`（约束 1 类型层保证不退回 LLM）。
- 每 persona 造 analyzer：`const core = os.getCore(personaId)`；`retrieve = (q) => retrieveMemoriesDeterministic(q, core.memories.getAllMemories(), (id) => core.memories.getEdgesFor(id), undefined)`；`decisionEngine = this.deps.decisionEngineFor(core)`；`responder = new OfflineConversationResponder()`；**`narrative` 来自 `profile.narrative`（不是 `core.narrative.get()`）**——照 `conversation-service.ts:606` 真实取法：`typeof profile.narrative === 'string' ? profile.narrative : ''`（与 boundaries 同源 profile，一处 getPersonaDetail 全取）。
- **isValidBoundary（已核实）**：`isValidBoundary` 是 `conversation-service.ts` 的**局部函数未导出**。实现二选一：① 从 `conversation-service.ts` 导出它复用；② 在 collaboration 内写等价的最简 `isValidBoundary`（校验 `rule ∈ {never_discuss, always_escalate, ...}` + 必要字段）。推荐 ① 复用，避免逻辑二份。boundaries 取法照 `conversation-service.ts:608-610`：`Array.isArray(profile.behaviorBoundaries) ? (profile.behaviorBoundaries as BehaviorBoundary[]).filter(isValidBoundary) : []`。
- 单 persona：正常执行（mode 天然出空 commonTopics/divergences）；不在端点特判。

- [ ] **Step 1: 写失败测试（隔离 + 校验 + E2E，用真 TenantOSFactory + 内存 DB）**

```typescript
// src/collaboration/collaborative-analysis-service.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollaborativeAnalysisService } from './collaborative-analysis-service.js';
import { MultiPerspectiveAggregation } from './modes/multi-perspective-aggregation.js';
// 复用既有测试夹具建租户 OS + persona core（照 persona-core-service.test.ts / chat.test.ts 的建库+seed 惯例）。
// 实现者：用与既有集成测试同款 in-memory sqlite + TenantOSFactory + PersonaCoreService 装配。

test('未知 personaId → PersonaUnavailable（不静默产空核）', async () => {
  const { service } = await setup();
  await assert.rejects(
    () => Promise.resolve(service.analyze('t1', 'user_1', ['does-not-exist'], { question: 'q' })),
    /PersonaUnavailable|不可用|不存在/,
  );
});

test('per-persona 隔离：A 学的记忆不出现在 B 的 evidence', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '甲学到的独有内容 关键词ALPHA');
  seedMemory('t1', 'user_1', 'pb', '乙学到的独有内容 关键词BETA');
  const report = service.analyze('t1', 'user_1', ['pa', 'pb'], { question: '关键词ALPHA' });
  const pbView = report.perspectives.find((p) => p.personaId === 'pb')!;
  assert.ok(!pbView.evidence.some((e) => e.excerpt.includes('ALPHA')));  // B 不含 A 的记忆
});

test('多视角真不同：两 persona 学不同内容 → opinion/keyPoints/evidence 不同', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '扩张 有利 市场');
  seedMemory('t1', 'user_1', 'pb', '风险 收紧 谨慎');
  const report = service.analyze('t1', 'user_1', ['pa', 'pb'], { question: '要不要扩张' });
  const [va, vb] = ['pa', 'pb'].map((id) => report.perspectives.find((p) => p.personaId === id)!);
  const aIds = new Set(va.evidence.map((e) => e.memoryId));
  assert.ok(!vb.evidence.some((e) => aIds.has(e.memoryId)));  // evidence memoryId 集不相交
});

test('零-LLM：service 不注入任何 LLM provider 也能跑（纯确定性）+ 同输入同输出', async () => {
  const { service, seedMemory } = await setup();  // setup 不配 llm
  seedMemory('t1', 'user_1', 'pa', '预算 约束');
  const r1 = service.analyze('t1', 'user_1', ['pa'], { question: '预算够吗' });
  const r2 = service.analyze('t1', 'user_1', ['pa'], { question: '预算够吗' });
  assert.deepEqual(r1, r2);
});

test('单 persona：正常产报告，commonTopics/rankingDivergences 空', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '预算 约束');
  const r = service.analyze('t1', 'user_1', ['pa'], { question: '预算够吗' });
  assert.deepEqual(r.commonTopics, []);
  assert.deepEqual(r.rankingDivergences, []);
});

test('空 personaIds → ValidationError；重复去重', async () => {
  const { service, seedMemory } = await setup();
  seedMemory('t1', 'user_1', 'pa', '预算');
  await assert.rejects(() => Promise.resolve(service.analyze('t1', 'user_1', [], { question: 'q' })), /Validation|空/);
  const r = service.analyze('t1', 'user_1', ['pa', 'pa'], { question: '预算' });
  assert.equal(r.perspectives.length, 1);  // 去重
});

// setup()/seedMemory() 由实现者按既有集成测试夹具装配（in-memory sqlite + TenantOSFactory + PersonaCoreService + PersonaCoreService.create seed persona）。
```
> 实现者注：`setup()` 与 `seedMemory()` 沿用既有集成测试建库/建 persona/写记忆惯例（参考 `src/persona-core/persona-core-service.test.ts` 与 companion `chat.test.ts` 如何 seed persona core 与 memories）。必须真建两个 persona 并各写不同记忆，隔离断言才有意义。`setup()` 装配 `CollaborativeAnalysisService` 时的 `decisionEngineFor`：用真实工厂 `(core) => new DecisionEngine(core, new RetrievalService(core.memories, new InMemoryEmbeddingIndex(tx, clock, llmStub, embeddingModel)), llmStub, clock, logger, simConfig, ruleEngine)`——`llmStub` 是「零-LLM 测试」的关键：传一个**调用即抛错**的 LLM 桩（如 `{ complete: () => { throw new Error('零-LLM 测试禁止调 LLM') } }`），这样若 analyze 意外走了 growth/embed 路径测试立刻红（证零-LLM）；autonomous 路径不触达它 → 测试正常绿。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/collaboration/collaborative-analysis-service.test.ts`
Expected: FAIL（`CollaborativeAnalysisService` 未定义）

- [ ] **Step 3: 写 service 实现**

```typescript
// src/collaboration/collaborative-analysis-service.ts
/** 编排：逐 persona 经 getTenantOS().getCore() 解析各自内核 → 单 persona 分析 → mode 汇聚（spec §5.3）。
 * fail-closed：未知/跨租户 persona 先经 getPersonaDetail 校验，拒 PersonaUnavailable（约束 7）。 */
import type { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { AutonomousDecisionEngine } from '../intelligence/decision-engine.js';
import type { CollaborationMode, AnalysisRequest, CollaborativeReport } from './collaboration-types.js';
import { PersonaPerspectiveAnalyzer } from './persona-perspective-analyzer.js';
import { retrieveMemoriesDeterministic } from '../conversation/deterministic-memory-retrieval.js';
import { OfflineConversationResponder, type BehaviorBoundary } from '../conversation/offline-conversation-responder.js';
import { isValidBoundary } from '../conversation/conversation-service.js';   // 复用（须先在该文件加 export）
import { ValidationError } from '../errors/index.js';       // 已核实：src/errors/index.ts 导出

/** persona 不存在/不属该 owner/跨租户（统一，不可区分，防跨租户存在性泄露）。 */
export class PersonaUnavailableError extends Error {
  constructor(personaId: string) { super(`persona 不可用: ${personaId}`); this.name = 'PersonaUnavailable'; }
}

/** 注入的 per-persona autonomous 决策引擎工厂。LLM/embedding 管线装配留在组合根（app.ts），
 * 使本 zero-LLM 特性代码不 import LLMProvider（照 PersonaEarningService 注入 decisionEngine 先例）。 */
export type DecisionEngineFor = (core: CoreRhythmLayer) => AutonomousDecisionEngine;

export interface CollaborativeAnalysisDeps {
  readonly factory: TenantOSFactory;
  readonly personaCoreService: PersonaCoreService;
  readonly mode: CollaborationMode;
  readonly decisionEngineFor: DecisionEngineFor;
}

export class CollaborativeAnalysisService {
  constructor(private readonly deps: CollaborativeAnalysisDeps) {}

  analyze(tenantId: string, ownerUserId: string, personaIds: readonly string[], req: AnalysisRequest): CollaborativeReport {
    const unique = [...new Set(personaIds)];
    if (unique.length === 0) throw new ValidationError('personaIds 不能为空');
    const os = this.deps.factory.getTenantOS(tenantId);

    /* 先全量校验存在+归属（fail-closed），再解析 core——避免为无效 persona 建空核（约束 7）。 */
    const profiles = unique.map((personaId) => {
      const detail = this.deps.personaCoreService.getPersonaDetail(tenantId, ownerUserId, personaId);
      if (!detail) throw new PersonaUnavailableError(personaId);
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
      const analyzer = new PersonaPerspectiveAnalyzer({
        retrieve: (q) => retrieveMemoriesDeterministic(q, core.memories.getAllMemories(), (id) => core.memories.getEdgesFor(id), undefined),
        decisionEngine: this.deps.decisionEngineFor(core),   // 注入工厂：LLM/embedding 装配在 app.ts，此处只用窄接口
        responder: new OfflineConversationResponder(),
        narrative,
        boundaries,
      });
      return analyzer.analyze(personaId, req);
    });

    return this.deps.mode.aggregate(req.question, perspectives);
  }
}
```
> 实现者注：① `ValidationError` / `RuleEngine` / `RetrievalService` / `AppConfig` 的真实导出路径以仓库为准（`decisions.ts:127-129` 是同款装配参考）；② `RetrievalService` 第二参 embeddingIndex 若非可选，传既有测试用的最简替身或 `os` 已有实例——但**绝不注入会触发 embed 的真索引到 autonomous 路径**（autonomous 不读它）；③ `detail.profile.behaviorBoundaries` 的真实字段名/过滤器（`isValidBoundary`）照 `conversation-service.ts:600-610`。

- [ ] **Step 4: 运行 service 测试确认通过**

Run: `npx tsx --test src/collaboration/collaborative-analysis-service.test.ts`
Expected: PASS（6 测试）

- [ ] **Step 5: 写端点 `collaboration.ts`（仿既有 route 骨架）**

```typescript
// src/server/routes/collaboration.ts
/** POST /api/v1/collaboration/analyze —— 多数字人协同分析（spec §5.4）。
 * 鉴权/租户从上下文取，校验/降级全在 service（端点只做 body schema + 传参）。 */
import type { FastifyInstance } from 'fastify';
import type { CollaborativeAnalysisService } from '../../collaboration/collaborative-analysis-service.js';
// 实现者：照既有 route（如 decisions.ts / companion）的注册签名、schema 校验、tenantId/ownerUserId 提取惯例。

export function registerCollaborationRoutes(app: FastifyInstance, service: CollaborativeAnalysisService): void {
  app.post('/api/v1/collaboration/analyze', async (request, reply) => {
    const { question, alternatives, personaIds } = request.body as {
      question: string; alternatives?: string[]; personaIds: string[];
    };
    const tenantId = request.tenantId;                    // 照既有 route 提取
    const ownerUserId = (request.user as { sub: string }).sub;
    const report = service.analyze(tenantId, ownerUserId, personaIds, { question, alternatives });
    return reply.send({ data: report });                  // 照既有信封惯例（单键 {data} 前端自动解包）
  });
}
```
> 实现者注：body schema 校验（question 非空字符串、personaIds 非空数组）用项目既有校验方式（fastify schema 或手动）；错误码映射（PersonaUnavailable→404、ValidationError→400）照既有 error handler 惯例。

- [ ] **Step 6: 在 app.ts 注册路由**

在 `src/server/app.ts` 找到其他 `registerXxxRoutes(app, ...)` 集中注册处，仿照装配 `CollaborativeAnalysisService`：
- `factory` = 已有 tenantFactory；`personaCoreService` = 已有实例；`mode = new MultiPerspectiveAggregation()`。
- `decisionEngineFor` = `(core) => new DecisionEngine(core, new RetrievalService(core.memories, earningEmbeddingIndex /* 复用已有 InMemoryEmbeddingIndex，仅为构造满足、autonomous 不查询 */), conversationLlmRouter, deps.os.getClock(), deps.os.getLogger(), config.intelligence.simulation, new RuleEngine(deps.os.getClock(), config.ruleEngine, deps.os.getLogger()))`——**照 `app.ts:679` earning 先例同款构造**（复用同一 `earningEmbeddingIndex` 或新建一个 `InMemoryEmbeddingIndex`）。autonomous 路径不查询 embedding/不调 llmRouter，零 LLM 成立；`DecisionEngine` 实现 `AutonomousDecisionEngine` 结构兼容，工厂返回类型收窄为窄接口即可。
- 注意：`earningEmbeddingIndex` 绑的是 `deps.os.core.memories`（default persona）；协同用的是 `core.memories`（per-persona）——故 `RetrievalService` 须**每 persona 新建**绑 `core.memories`（不能复用 earning 那个绑 default 的 RetrievalService 实例），但 `InMemoryEmbeddingIndex` 本身（autonomous 不查询）可复用或每次新建，均可。
- 最后 `registerCollaborationRoutes(app, service)`。

- [ ] **Step 7: 编译 + service 测试 + 相关 route 测试全绿**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsx --test src/collaboration/*.test.ts src/collaboration/modes/*.test.ts`
Expected: PASS（Task 2-5 全部）

- [ ] **Step 8: Commit**

```bash
git add src/collaboration/collaborative-analysis-service.ts src/collaboration/collaborative-analysis-service.test.ts src/server/routes/collaboration.ts src/server/app.ts
git commit -m "feat(collab): CollaborativeAnalysisService 编排 + /collaboration/analyze 端点 + E2E（隔离/校验/零-LLM）"
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

**Spec 覆盖**：§5.1 analyzer→Task 3；§5.2 mode+aggregation→Task 4；§5.3 service→Task 5；§5.4 端点→Task 5；§6 不持久化（无迁移 task，正确）；§7 可验证性 8 条→分散在 Task 3/4/5 测试；共享类型→Task 1；tokenize/keyPoints→Task 2。全覆盖。

**Placeholder 扫描**：无 TBD/TODO；每个 code step 有完整代码；测试有真实断言。setup()/seedMemory() 明确标「照既有集成测试夹具装配」并给出参考文件（非占位，是复用既有惯例的合理委托）。

**类型一致性**：`PersonaPerspective`（Task 1）字段贯穿 Task 3 产、Task 4 消；`retrievedCount`/`evidence`/`keyPoints`/`rankedAlternatives{alternative,score,rank}` 命名跨 task 一致；`evaluateAutonomous` 返回 `rankedOptions[{alternative,rank,overallScore}]`→映射 `{alternative,score,rank}` 一致；`CollaborationMode.aggregate(question, perspectives)` 签名 Task 4 实现与 Task 5 调用一致。

**已知实现期待核实点**（非占位，是「以仓库为准」的诚实标注）：`ValidationError`/`RuleEngine`/`RetrievalService`/`AppConfig` 导出路径、`detail.profile.behaviorBoundaries` 字段名+`isValidBoundary` 过滤器、`RetrievalService` embeddingIndex 参数可选性、fastify route 注册与 error handler 惯例——均给了参考文件（`decisions.ts:127-129`、`conversation-service.ts:600-610`、`chat.ts:144-152`），实现者照真实签名对齐。
