/**
 * ExamSpec 冻结前确定性 lint（ADR-0057 L3，红线 17/19）——防作弊 + 防过拟合的 rubric 健康门。
 *
 * lint 不过**不得冻结**。检查（全确定性，零-LLM）：
 *   1. 受限 regex：禁 `.*` / 贪婪通配 `.+` / 任意回溯——只允许受限匹配（防超宽 regex 假命中）。
 *   2. alias/keypoint 配额：alias 数/长度上限；keypoint 必须有信息量（alias 非空、非过短）；至少一个评分项。
 *   3. 权重分布：权重 > 0；单要点权重占比 ≤ 上限（防单要点架空其他）。
 *   4. negative cases：ExamSpec 自带反例（空/泛/禁忌/答案塞 alias 的作答）**必须判不过**——用 scorer 实跑验证
 *      scorer 不被骗（假过率守门）；且反例集必须覆盖关键作弊面。
 *
 * 纯函数，零 node:* 依赖（ADR-0001）。
 */

import type { ExamSpec } from './exam-types.js';
import { scoreExam } from './exam-scorer.js';

/** lint 配额（frozen 默认；可按需调，但放宽须谨慎——这是反作弊底线）。 */
export const EXAM_LINT_LIMITS = Object.freeze({
  /** 每 keypoint 最多 alias 数（防把整段答案拆成海量 alias 兜底）。 */
  maxAliasesPerKeypoint: 12,
  /** 单个 alias 最大字符数（防把整句标准答案塞进一个 alias）。 */
  maxAliasLength: 80,
  /** alias 最小字符数（防零信息单字/空白 alias 滥竽充数）。 */
  minAliasLength: 2,
  /** 单**评分项**（keypoint 或 structuredField）权重占比上限（防单项架空其他，Codex L3 复审：含 structured）。 */
  maxSingleItemWeightRatio: 0.6,
  /** 至少几条 negative case（覆盖关键作弊面）。 */
  minNegativeCases: 3,
  /** 单条 regex 源串最大长度（防超长 alternation/复杂模式）。 */
  maxRegexLength: 120,
  /** structured field key/expected 长度边界。 */
  minStructuredFieldLength: 1,
  maxStructuredFieldLength: 80,
});

/**
 * 受限 regex **白名单校验**（ADR-0057 红线 + Codex L3 复审：防 ReDoS）。LLM 拟题的 regex 冻结前必须过此校验——
 * 只允许低风险原语，**拒绝**任何可触发指数回溯/DoS 或难审计的结构：
 *   - 嵌套量词 / 量词作用于分组：(a+)+ / ([a-z]+)* / (a|aa)+ —— ReDoS 经典。
 *   - 无上界量词 {n,} / 贪婪通配 .* .+。
 *   - lookaround (?=)(?!)(?<=) / 反向引用 \1。
 *   - 超长源串。
 * 返回违规原因（空=合法）。这是真正的 safety gate（与 scorer 里仅做编译的 compileFrozenRegex 分工）。
 */
export function validateRestrictedRegex(source: string): string | null {
  if (source.length > EXAM_LINT_LIMITS.maxRegexLength) return `regex 过长（${source.length} > ${EXAM_LINT_LIMITS.maxRegexLength}）`;
  if (/\.\*|\.\+/.test(source)) return '含贪婪任意通配 .* / .+';
  if (/\{\d*,\}/.test(source)) return '含无上界量词 {n,}';
  if (/\(\?[=!<]/.test(source)) return '含 lookaround（回溯风险/难审计）';
  if (/\\\d/.test(source)) return '含反向引用 \\N（回溯风险）';
  /* 量词直接作用于「分组」是 ReDoS 主因：)+ )* )? ){...} —— 一律拒绝（分组内不得再被量词包裹）。 */
  if (/\)[*+?{]/.test(source)) return '量词作用于分组（嵌套量词 ReDoS 风险，如 (a+)+ / (a|aa)+）';
  try {
    new RegExp(source);
  } catch {
    return 'regex 无法编译';
  }
  return null;
}

/** 一条 lint 违规。 */
export interface ExamLintViolation {
  readonly code: string;
  readonly detail: string;
}

/** lint 结果。 */
export interface ExamLintResult {
  readonly ok: boolean;
  readonly violations: readonly ExamLintViolation[];
}

function checkPatterns(patterns: readonly string[] | undefined, where: string, out: ExamLintViolation[]): void {
  if (!patterns) return;
  for (const p of patterns) {
    const reason = validateRestrictedRegex(p);
    if (reason) {
      out.push({ code: 'regex_too_broad', detail: `${where} 的 regex「${p}」：${reason}` });
    }
  }
}

/**
 * lint 一份 ExamSpec（冻结前调用）。返回 ok + 违规列表。ok=false 则不得冻结。
 */
export function lintExamSpec(spec: ExamSpec): ExamLintResult {
  const v: ExamLintViolation[] = [];
  const L = EXAM_LINT_LIMITS;

  /* 至少要有评分项（keypoints 或 structuredFields），否则空 rubric 任何作答都 0 或假过。 */
  if (spec.keypoints.length === 0 && spec.structuredFields.length === 0) {
    v.push({ code: 'no_scoring_items', detail: 'ExamSpec 无 keypoints 也无 structuredFields，无法评分' });
  }

  /* 权重 + alias 配额。 */
  let totalWeight = 0;
  for (const kp of spec.keypoints) {
    if (!(kp.weight > 0)) v.push({ code: 'weight_nonpositive', detail: `keypoint ${kp.id} 权重须 > 0` });
    totalWeight += kp.weight > 0 ? kp.weight : 0;
    if (kp.aliases.length === 0 && (!kp.patterns || kp.patterns.length === 0)) {
      v.push({ code: 'keypoint_no_rule', detail: `keypoint ${kp.id} 无 alias 也无 pattern，永不命中` });
    }
    if (kp.aliases.length > L.maxAliasesPerKeypoint) {
      v.push({ code: 'too_many_aliases', detail: `keypoint ${kp.id} alias 数 ${kp.aliases.length} > ${L.maxAliasesPerKeypoint}` });
    }
    for (const a of kp.aliases) {
      const t = a.trim();
      if (t.length < L.minAliasLength) v.push({ code: 'alias_too_short', detail: `keypoint ${kp.id} 含零信息 alias「${a}」` });
      if (t.length > L.maxAliasLength) v.push({ code: 'alias_too_long', detail: `keypoint ${kp.id} alias「${a.slice(0, 20)}…」过长（疑似塞答案）` });
    }
    checkPatterns(kp.patterns, `keypoint ${kp.id}`, v);
  }
  for (const f of spec.structuredFields) {
    if (!(f.weight > 0)) v.push({ code: 'weight_nonpositive', detail: `structuredField ${f.key} 权重须 > 0` });
    totalWeight += f.weight > 0 ? f.weight : 0;
    /* key/expected 长度边界（防 key='a' expected='b' 的零信息宽匹配，Codex L3 复审）。 */
    const kt = f.key.trim();
    const et = f.expected.trim();
    if (kt.length < L.minStructuredFieldLength || et.length < L.minStructuredFieldLength) {
      v.push({ code: 'structured_field_too_short', detail: `structuredField ${f.key} 的 key/expected 太短（零信息宽匹配）` });
    }
    if (kt.length > L.maxStructuredFieldLength || et.length > L.maxStructuredFieldLength) {
      v.push({ code: 'structured_field_too_long', detail: `structuredField ${f.key} 的 key/expected 过长（疑似塞答案）` });
    }
  }
  for (const fc of spec.forbiddenClaims) {
    checkPatterns(fc.patterns, `forbidden ${fc.id}`, v);
  }

  /* 权重分布：**任一评分项**（keypoint 或 structuredField）占比不得架空其他（Codex L3 复审：含 structured）。 */
  if (totalWeight > 0) {
    const items: ReadonlyArray<{ id: string; weight: number; kind: string }> = [
      ...spec.keypoints.map((kp) => ({ id: kp.id, weight: kp.weight, kind: 'keypoint' })),
      ...spec.structuredFields.map((f) => ({ id: f.key, weight: f.weight, kind: 'structuredField' })),
    ];
    for (const it of items) {
      if (it.weight > 0 && it.weight / totalWeight > L.maxSingleItemWeightRatio) {
        v.push({ code: 'weight_concentrated', detail: `${it.kind} ${it.id} 权重占比 ${(it.weight / totalWeight).toFixed(2)} > ${L.maxSingleItemWeightRatio}（架空其他评分项）` });
      }
    }
  }

  /* negative cases：数量 + 实跑必不过（用 scorer 验 scorer 不被骗）。 */
  if (spec.negativeCases.length < L.minNegativeCases) {
    v.push({ code: 'too_few_negatives', detail: `negative cases ${spec.negativeCases.length} < ${L.minNegativeCases}（反作弊覆盖不足）` });
  }
  for (const nc of spec.negativeCases) {
    const r = scoreExam(spec, nc.answer);
    if (r.passed) {
      v.push({ code: 'negative_case_passed', detail: `反例 ${nc.id}（${nc.reason}）竟判合格（coverage ${r.coverage.toFixed(2)}）——scorer 被骗，rubric 不健康` });
    }
  }

  return { ok: v.length === 0, violations: v };
}
