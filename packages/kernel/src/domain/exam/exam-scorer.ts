/**
 * 确定性考试评分器 ExamScorer（ADR-0057 L3）——把作答按冻结的 ExamSpec 算加权命中率，判 ≥95。
 *
 * 严守红线（ADR-0057）：
 *   - 零-LLM（红线 1/14）：只用**确定性文本规范化 + 精确 alias 子串 + 受限 regex + 结构化字段精确匹配**；
 *     **禁止**评分时调 LLM / 云 embedding / 语义相似度——否则把 LLM 依赖偷渡回评分层，破铁律 + 不可复现。
 *   - 可复现可审计（红线 4）：同作答 + 同 ExamSpec + 同 scorerVersion → 同分。无 I/O、无随机、无时钟。
 *   - ≥95 定义（D0.4）：weighted keypoint coverage ≥ 0.95 且 forbiddenClaims 命中数 = 0。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。
 */

import {
  EXAM_PASS_THRESHOLD, EXAM_SCORER_VERSION,
  type ExamSpec, type ExamResult, type KeypointHit,
  type ExamKeypoint, type ExamForbiddenClaim,
} from './exam-types.js';

/**
 * 确定性文本规范化（normalizer v1）：小写 + 去首尾 + 内部连续空白折叠为单空格。
 * 纯字符串变换，同输入同输出，无语义判断。
 */
export function normalizeAnswer(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 把受限 regex 源串编译为 RegExp（大小写不敏感）。**受限**：lint 已禁 `.*`/贪婪通配/回溯（见 exam-lint），
 * 这里只负责安全编译；非法源串（编译抛错）视为不匹配（确定性，不抛到评分外）。
 */
function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/** 某规则（aliases + patterns）是否命中规范化后的作答。 */
function ruleHits(normalizedAnswer: string, aliases: readonly string[], patterns?: readonly string[]): boolean {
  for (const a of aliases) {
    const na = normalizeAnswer(a);
    if (na.length > 0 && normalizedAnswer.includes(na)) return true;
  }
  if (patterns) {
    for (const p of patterns) {
      const re = safeRegex(p);
      if (re && re.test(normalizedAnswer)) return true;
    }
  }
  return false;
}

/** 单个 keypoint 是否命中。 */
function keypointHit(normalizedAnswer: string, kp: ExamKeypoint): boolean {
  return ruleHits(normalizedAnswer, kp.aliases, kp.patterns);
}

/** 正则转义（把字面量安全嵌进动态构造的 RegExp）。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 结构化字段命中：作答须含 `key <sep> expected` 的 key-value 形态（sep ∈ {: =}，允许周边空白/引号），
 * 而非 key 与 expected 全文各自出现。确定性，无语义判断（Codex L3 复审：防 anywhere-both 假过）。
 */
function structuredFieldHit(normalizedAnswer: string, rawKey: string, rawExpected: string): boolean {
  const k = normalizeAnswer(rawKey);
  const v = normalizeAnswer(rawExpected);
  if (k.length === 0 || v.length === 0) return false;
  /* key ["']?  [:=]  ["']? expected —— 中间允许空白/引号（规范化已折叠空白为单空格）。 */
  const re = new RegExp(`${escapeRegex(k)}\\s*["']?\\s*[:=]\\s*["']?\\s*${escapeRegex(v)}`, 'i');
  return re.test(normalizedAnswer);
}

/** 单个禁忌点是否命中。 */
function forbiddenHit(normalizedAnswer: string, fc: ExamForbiddenClaim): boolean {
  return ruleHits(normalizedAnswer, fc.aliases, fc.patterns);
}

/**
 * 评分：作答按冻结 ExamSpec 算加权命中率（keypoints + structuredFields 同入加权分母）+ 禁忌检查。
 * 合格 = coverage ≥ 0.95 且无禁忌命中。纯确定性、可复现。
 */
export function scoreExam(spec: ExamSpec, answer: string): ExamResult {
  const normalized = normalizeAnswer(answer);

  /* 要点命中（加权）。 */
  const keypointHits: KeypointHit[] = spec.keypoints.map((kp) => ({
    keypointId: kp.id,
    weight: kp.weight,
    hit: keypointHit(normalized, kp),
  }));

  /* 结构化字段：要求作答含 **key-value 形态**（`key: expected` / `key=expected` / `"key":"expected"`），
   * 而非 key 与 expected 在全文任意位置各自出现——后者会假过（如「method 不应是 systematic review」，
   * Codex L3 复审）。确定性窗口匹配，零分隔符变体宽容（: = 及周边空白/引号）。 */
  const structuredHits: string[] = [];
  for (const f of spec.structuredFields) {
    if (structuredFieldHit(normalized, f.key, f.expected)) {
      structuredHits.push(f.key);
    }
  }

  /* 加权命中率 = 命中权重和 / 全部权重和（keypoints + structuredFields）。 */
  let totalWeight = 0;
  let hitWeight = 0;
  for (const kp of keypointHits) {
    totalWeight += kp.weight;
    if (kp.hit) hitWeight += kp.weight;
  }
  for (const f of spec.structuredFields) {
    totalWeight += f.weight;
    if (structuredHits.includes(f.key)) hitWeight += f.weight;
  }
  /* 无任何评分项 → coverage 0（不可能合格；lint 会挡空 rubric）。 */
  const coverage = totalWeight > 0 ? hitWeight / totalWeight : 0;

  /* 禁忌检查。 */
  const forbiddenHits: string[] = [];
  for (const fc of spec.forbiddenClaims) {
    if (forbiddenHit(normalized, fc)) forbiddenHits.push(fc.id);
  }

  const passed = coverage >= EXAM_PASS_THRESHOLD && forbiddenHits.length === 0;

  return {
    coverage,
    passed,
    keypointHits,
    forbiddenHits,
    structuredHits,
    scorerVersion: spec.scorerVersion || EXAM_SCORER_VERSION,
  };
}

/** 失分要点 id 列表（供 D0.3 补学：老师据此补教）。 */
export function failedKeypoints(result: ExamResult): readonly string[] {
  return result.keypointHits.filter((k) => !k.hit).map((k) => k.keypointId);
}
