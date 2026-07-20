// src/collaboration/persona-perspective-analyzer.ts
/** 单 persona 视角分析：复用「确定性检索 → 决策打分 → 离线组织成文」三段零-LLM 基元（spec §5.1）。
 * 检索/决策/组织三依赖注入，便于测试用桩替换、也让类型层禁 embedding provider（零-LLM 闭合）。 */
import type { RelevantKnowledge } from '../conversation/conversation-types.js';
import type { AutonomousDecisionEngine } from '../intelligence/decision-engine.js';
import type { OfflineConversationResponder } from '../conversation/offline-conversation-responder.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';   // 真实定义处（:23），非 responder
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
