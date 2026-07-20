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
