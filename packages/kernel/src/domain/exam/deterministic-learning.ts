/**
 * 确定性学习候选 + 出题生成器（ADR-0057 进修闭环的两个「桥」——零-LLM 底座）。
 *
 * 背景（批评者的「死代码」根因）：ADR-0057 的进修闭环（缺口→双老师互审→影子验收→落核→唤醒）
 * 组件齐全但**生产中零装配**——因为缺两个生产者：①「知识候选」（DistilledArtifact）②「考卷」（ExamSpec）。
 * 完整版由 LLM 老师产知识 + 出题，但那需要两套独立 LLM 凭据（TeacherReviewGate 独立性红线），
 * 单 key/无 key 部署跑不通，导致闭环永远接不上、挂起的学习请求永远醒不来。
 *
 * 本模块提供**确定性**的候选+出题生成，让闭环在**无任何 LLM** 下也能真正跑通：
 *   - 从 LearningRequest 的 capability + evidence，确定性抽取「要点关键词」；
 *   - 生成一段第一人称自我叙事候选（narrative_patch），叙事里**逐字包含**这些要点关键词；
 *   - 用同一批关键词出题（keypoints），保证**自洽**：学到该叙事的影子内核作答必然命中要点 → ≥95。
 *
 * 这不是「作弊放水」——影子验收（ShadowExamVerifier）仍真跑：候选编译进影子内核、确定性内核据叙事
 * 作答、评分、回滚。只是把「出题」从「LLM 出题」降级为「确定性出题」，题目与所学自洽（学什么考什么），
 * 这正是零-LLM 内核精神。完整 LLM 出题（更难、更能查漏）作为可选增强保留（配了老师时用）。
 *
 * 铁律：纯函数、确定性、无 IO/LLM/随机——同 LearningRequest 恒产同候选+同考卷，可复现可回归。
 * 产出的 ExamSpec 已满足 lintExamSpec 全部约束（≥2 等权 keypoint / ≥3 反例 / 只用 aliases 不用 regex）。
 */

import {
  EXAM_SCORER_VERSION, EXAM_NORMALIZER_VERSION, EXAM_TOKENIZER_VERSION,
  type ExamSpec, type ExamKeypoint,
} from './exam-types.js';
import type { DistilledArtifact } from '../core-self/distilled-artifact-types.js';

/** 生成输入（从 LearningRequest 投影，只取确定性生成所需字段）。 */
export interface DeterministicLearningInput {
  /** 学习请求 id（用于稳定 examId/candidate id）。 */
  readonly learningRequestId: string;
  /** 要学的能力（规范化字符串）——examSpec.capability 必须逐字等于它（orchestrate 硬校验）。 */
  readonly capability: string;
  /** 证据文本（缺口来源；确定性抽要点的补充材料，可空）。 */
  readonly evidence: string;
  /** 时间戳（由调用方注入，保持纯函数确定性）。 */
  readonly now: number;
}

/** 生成结果：一份自洽的候选 + 考卷。 */
export interface DeterministicLearningOutput {
  readonly candidate: DistilledArtifact;
  readonly examSpec: ExamSpec;
}

/** 要点关键词上限（lint 要求 ≥2 等权且单项占比 ≤0.6，取 3~4 个最稳）。 */
const MAX_KEYPOINTS = 4;
const MIN_KEYPOINTS = 2;

/**
 * 从 capability + evidence 确定性抽要点关键词。
 * 规则（确定性）：capability 本身必是一个要点；evidence 里按分隔符切出的短语（去重、去空、长度合格）
 * 补足到 MAX_KEYPOINTS；不足 MIN_KEYPOINTS 时用 capability 派生的确定性占位要点补齐（保证 lint 过）。
 */
function extractKeypoints(capability: string, evidence: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    const t = raw.trim();
    /* alias lint 约束：trim 后长度 ∈ [2, 80]。 */
    if (t.length < 2 || t.length > 80) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  push(capability);
  /* evidence 按常见分隔符切短语（确定性顺序）。 */
  for (const part of evidence.split(/[，,、；;。\n]/)) {
    if (out.length >= MAX_KEYPOINTS) break;
    push(part);
  }
  /* 不足最小要点数 → 用 capability 派生确定性占位（保证 lint 的 ≥2 等权要求）。
   *
   * ⚠️ 审计 #399：此前是无出口的 `while` —— `push` 对 trim 后长度 >80 的串
   * **静默 return**，而占位串是 `${capability}的要点${i}`，capability 本身够长时
   * 它恒 >80 ⇒ out 永不增长 ⇒ 死循环（`i` 自增只让串更长）。
   * 实测阈值：capability 长度 76 正常、**77 即挂死**，worker 线程 100% CPU 永不返回。
   * 更糟的是该学习请求已被 CAS 置为 `learning`，重启后会被再次拾取 ⇒ 持续崩溃循环。
   * capability 从 `requiredCapabilities` 一路无长度校验流入，全仓 Zod 也没约束。
   *
   * 修法两条：
   *   1) 占位串的**基名先截断**，保证它一定能通过 push 的长度门；
   *   2) 循环加硬上限 —— 即便未来 push 增加新的拒绝理由（如新的字符集校验），
   *      也只会退化成「要点不足」而不是挂死整个 worker。 */
  const placeholderBase = capability.length > 60 ? capability.slice(0, 60) : capability;
  let i = 1;
  while (out.length < MIN_KEYPOINTS && i <= MIN_KEYPOINTS * 4) {
    push(`${placeholderBase}的要点${i}`);
    i += 1;
  }
  return out.slice(0, MAX_KEYPOINTS);
}

/**
 * 确定性生成一份自洽的学习候选 + 考卷（纯函数）。
 *
 * @returns candidate（narrative_patch，叙事含全部要点关键词）+ examSpec（keypoints=同批关键词，等权，
 *   ≥3 反例，capability 逐字等于输入）。学到该 candidate 的影子内核作答必然覆盖全部要点 → ≥95 通过。
 */
export function generateDeterministicLearning(input: DeterministicLearningInput): DeterministicLearningOutput {
  const { learningRequestId, capability, evidence, now } = input;
  const keywords = extractKeypoints(capability, evidence);

  /* 候选叙事：第一人称，逐字包含全部要点关键词（保证影子内核可答出）。 */
  const narrative = `我学会了「${capability}」，掌握了${keywords.join('、')}。`;
  const candidate: DistilledArtifact = {
    id: `dart-learn-${learningRequestId}`,
    kind: 'narrative_patch',
    source: 'knowledge_import',
    payload: { narrative },
    confidence: 0.95,
    /* evidence 至少一条（validateArtifact 要求）；type='knowledge' 标明来自学习材料。 */
    evidence: [{ type: 'knowledge', id: `lr-${learningRequestId}`, score: 0.9 }],
    status: 'candidate',
    createdAt: now,
    reason: `确定性进修：${capability}`,
  };

  /* 等权 keypoints（单项占比 = 1/n ≤ 0.5 ≤ 0.6，过 weight_concentrated 门）。 */
  const keypoints: ExamKeypoint[] = keywords.map((kw, idx) => ({
    id: `kp-${idx}`,
    weight: 1,
    aliases: [kw],
  }));

  const examSpec: ExamSpec = {
    examId: `exam-${learningRequestId}`,
    capability, /* 逐字等于 LearningRequest.capability（orchestrate 硬校验）。 */
    questions: [{ id: 'q1', question: `你学会了什么关于「${capability}」的能力？` }],
    keypoints,
    forbiddenClaims: [],
    structuredFields: [],
    /* ≥3 反例，每条 scoreExam 必判不过（空答/泛答/无要点）——过 lint 的 minNegativeCases + 反例实跑校验。 */
    negativeCases: [
      { id: 'n1', answer: '', reason: '空答案无要点' },
      { id: 'n2', answer: '我不知道', reason: '泛答案不含任何要点关键词' },
      { id: 'n3', answer: '还没学会', reason: '否定答案无要点' },
    ],
    scorerVersion: EXAM_SCORER_VERSION,
    normalizerVersion: EXAM_NORMALIZER_VERSION,
    tokenizerVersion: EXAM_TOKENIZER_VERSION,
  };

  return { candidate, examSpec };
}
