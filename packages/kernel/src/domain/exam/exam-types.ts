/**
 * 考试规格与评分类型（ADR-0057 L3）——纯类型，零依赖。
 *
 * ExamSpec 是双老师拟题**一次性 LLM 生成后冻结**的不可变规格（红线 4/17）：评分时只执行冻结规则、不再调
 * LLM。一份 ExamSpec 冻结后就是该次学习验收的**唯一标准**（同作答+同 ExamSpec+同 scorerVersion → 同分）。
 */

/** 当前评分器版本（冻结进 ExamSpec，保可重放——升级评分逻辑须 bump 此版本，老 ExamSpec 仍按旧版本评）。 */
export const EXAM_SCORER_VERSION = 'v1' as const;
/** 文本规范化器版本（冻结进 ExamSpec）。 */
export const EXAM_NORMALIZER_VERSION = 'v1' as const;
/** 分词器版本（冻结进 ExamSpec）。 */
export const EXAM_TOKENIZER_VERSION = 'v1' as const;

/** ≥95 合格门：加权要点命中率 ≥ 此值（且禁忌命中=0）。 */
export const EXAM_PASS_THRESHOLD = 0.95;

/** 一个要点的匹配规则（命中即该要点得分）。aliases=规范化后精确子串；patterns=受限 regex 源串。 */
export interface ExamKeypoint {
  /** 要点 id（稳定，供失分回报）。 */
  readonly id: string;
  /** 要点权重（>0；加权命中率分母 = 全部权重和）。 */
  readonly weight: number;
  /** 同义词/短语（规范化后精确子串匹配，任一命中即该要点命中）。 */
  readonly aliases: readonly string[];
  /** 受限 regex 源串（任一匹配即命中；受 lint 约束，禁 `.*`/贪婪通配/回溯）。 */
  readonly patterns?: readonly string[];
}

/** 禁忌点（命中任一 → 整卷不过，无论命中率多高）。 */
export interface ExamForbiddenClaim {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly patterns?: readonly string[];
}

/** 结构化答案字段（要求作答含某结构化键值，确定性精确匹配）。 */
export interface ExamStructuredField {
  readonly key: string;
  /** 期望值（规范化后精确匹配）。 */
  readonly expected: string;
  readonly weight: number;
}

/** 一道题（仅作答方可见 question + 结构化字段形状提示；rubric 不可见，红线 16）。 */
export interface ExamQuestion {
  readonly id: string;
  readonly question: string;
}

/** 反例：构造的「应判不过」的作答（lint 用——空答案/泛答案/禁忌答案/答案塞 alias，红线 19）。 */
export interface ExamNegativeCase {
  readonly id: string;
  readonly answer: string;
  /** 该反例不过的原因（审计/可读）。 */
  readonly reason: string;
}

/** 考试规格（冻结不可变）。 */
export interface ExamSpec {
  readonly examId: string;
  /** 验收的能力（与 LearningRequest.capability 对应）。 */
  readonly capability: string;
  readonly questions: readonly ExamQuestion[];
  readonly keypoints: readonly ExamKeypoint[];
  readonly forbiddenClaims: readonly ExamForbiddenClaim[];
  readonly structuredFields: readonly ExamStructuredField[];
  /** 反例集（lint 验证 scorer 不被骗；红线 19）。 */
  readonly negativeCases: readonly ExamNegativeCase[];
  /** 冻结的版本三元组（保可重放）。 */
  readonly scorerVersion: string;
  readonly normalizerVersion: string;
  readonly tokenizerVersion: string;
}

/** 单要点命中明细（评分回报 + 失分回报供补学）。 */
export interface KeypointHit {
  readonly keypointId: string;
  readonly weight: number;
  readonly hit: boolean;
}

/** 评分结果（确定性，可复现可审计）。 */
export interface ExamResult {
  /** 加权要点命中率 [0,1]（含结构化字段权重）。 */
  readonly coverage: number;
  /** 是否合格 = coverage ≥ 阈值 且 forbiddenHits=0。 */
  readonly passed: boolean;
  /** 各要点命中明细（含未命中，供补学定位）。 */
  readonly keypointHits: readonly KeypointHit[];
  /** 命中的禁忌点 id（非空 → 必不过）。 */
  readonly forbiddenHits: readonly string[];
  /** 命中的结构化字段 key。 */
  readonly structuredHits: readonly string[];
  /** 评分用的版本（回放校验）。 */
  readonly scorerVersion: string;
}
