/**
 * 感官老师（PerceptionProvider）— 多模态内容理解的「老师」抽象（ADR-0051 感知层 Phase 1）。
 *
 * 论点定位（与 ADR-0047 一致）：多模态模型是**感官老师**，不是人格运行时的一部分。它只把
 * 音视频翻译成**结构化感知分析**（PerceptionAnalysis）。这份分析**视为不可信**——由
 * PerceptionDistiller 硬校验后才可能沉淀为记忆/成长候选，绝不直接进确定性核。
 *
 * 边界：
 *   - provider 只在**摄取/成长阶段**被调用（上传一段媒体时），绝不在人格每次决策/对话时同步调用。
 *   - 第一阶段 provider 接收的是「媒体的可分析表征」（transcript / 关键帧描述 / 元数据），不在本层
 *     做编解码/抽帧——那是采集层（client/edge）的事。本层只定义「表征 → 语义分析」的老师契约。
 *   - 真实 provider（云多模态 / 本地 ollama-llava + ASR）走 BYOK，是 Phase 2；本阶段提供
 *     MockPerceptionProvider（确定性、可测、无需外部 key）证明全链路。
 */

/** 媒体模态。第一阶段聚焦 audio；video 预留（Phase 2 抽帧后复用同契约）。 */
export type PerceptionModality = 'audio' | 'video';

/**
 * 送入感官老师的「媒体可分析表征」。本层不持有原始媒体二进制（高敏 PII 不进业务流），
 * 只接收采集层已提取的可分析表征 + 元数据。
 */
export interface PerceptionInput {
  readonly modality: PerceptionModality;
  /** 媒体内容哈希（provenance / 去重；不含原始媒体本身）。 */
  readonly mediaSha256: string;
  /** 时长（毫秒），用于配额/范围校验。 */
  readonly durationMs: number;
  /**
   * 采集层提供的可分析表征：audio 为 transcript 文本；video 为关键帧场景描述序列。
   * 这是「已脱离原始媒体」的中间表征——感官老师据此产出语义分析。
   */
  readonly representation: string;
}

/** 老师识别到的一个事实型观察（低推断、可核验）。会沉淀为 episodic/semantic 记忆。 */
export interface PerceivedFact {
  /** 事实摘要（人格第一人称之前的中性事实层）。 */
  readonly summary: string;
  /** 记忆类型。 */
  readonly memoryKind: 'episodic' | 'semantic';
  /** 情感效价 [-1,1]（老师的初判，仍是候选）。 */
  readonly valence: number;
  /** 显著度 [0,1]。 */
  readonly salience: number;
  /** 媒体内时间范围（毫秒）provenance；可选。 */
  readonly timeRangeMs?: readonly [number, number];
}

/**
 * 老师对「这段感知是否暗示人格身份层变化」的**提案**（高风险，默认人工审批）。
 * 例如「用户反复在压力后需要独处空间」→ 可能微调某 value。绝不自动改核——交蒸馏门。
 */
export interface PerceivedIdentityHint {
  /** 提案类型：仅支持已存在的低风险蒸馏目标。 */
  readonly kind: 'value_shift' | 'narrative_patch';
  /** value_shift：目标 value id（老师只能在已存在 value 上提）；narrative_patch 留空。 */
  readonly valueId?: string;
  /** value_shift：建议漂移方向与幅度（会被 distiller 封顶 + 过门）；narrative：叙事补丁文本。 */
  readonly delta?: number;
  readonly narrative?: string;
  /** 人读理由。 */
  readonly reason: string;
}

/** 感官老师的结构化输出（**整体视为不可信**，进 distiller 前不被信任）。 */
export interface PerceptionAnalysis {
  /** 事实型观察（会成为记忆）。 */
  readonly facts: readonly PerceivedFact[];
  /** 身份层提案（可选；默认走人工审批）。 */
  readonly identityHints?: readonly PerceivedIdentityHint[];
  /** 老师对整体分析的置信度 [0,1]。 */
  readonly confidence: number;
}

/** 老师调用选项。 */
export interface PerceptionAnalyzeOptions {
  /** 单次最多产出的事实数（控成本 + 防老师刷屏）。 */
  readonly maxFacts?: number;
}

/**
 * 感官来源类别：
 *   - `teacher`：真多模态 LLM 老师（真语义理解）。
 *   - `deterministic`：确定性本地实现（mock 回退，无 LLM，可本地验证但非真语义）。
 * 用于向上游/用户**如实透出**「这段感知是真老师教的还是确定性回退」，避免把 mock 误当真老师。
 */
export type PerceptionProviderKind = 'teacher' | 'deterministic';

/**
 * 感官老师契约：把媒体表征翻译成结构化感知分析。
 * 实现可以是 mock（确定性）、本地 ollama-llava、云多模态。失败应抛错由调用方降级。
 */
export interface PerceptionProvider {
  readonly name: string;
  /** 感官来源类别（真老师 vs 确定性回退）——透明度，路由据此回填响应 perceivedBy。 */
  readonly kind: PerceptionProviderKind;
  analyze(input: PerceptionInput, options?: PerceptionAnalyzeOptions): Promise<PerceptionAnalysis>;
}
