/**
 * 任务 category → 该蒸馏哪个核心价值（ADR-0046 自演化闭环 WP-0）。
 *
 * earn→distill 闭环需要把「完成了某 category 的任务」映射到「该强化哪个 core value」。
 * EarningOutcomeDistiller 接收 `targetValue {valueId, currentWeight}`，但谁来产这个映射此前是空的
 * （distiller 注释说「owner 配置」，但无 owner 配置子系统）。这里给一个**确定性、可测、可替换**的
 * 默认策略——避免为闭环先建一整套 owner-config UI/store（那是独立 ADR）。
 *
 * 策略（**保守**，可解释；Codex WP-0 审查：不做激进兜底，避免 rich-get-richer 人格漂移）：
 *   1. 精确：category 与某 value 的 id 或 label 相等（忽略大小写）→ 选它。
 *   2. 包含：category 是某 value id/label 的子串或反之 → 选第一个匹配。
 *   3. **无明确映射 → null**（不产 value_shift，与 distiller 既有「无 targetValue 则跳过」一致）。
 *      故意**不**兜底强化「最高权重价值」：那会让任意无关的高质量任务自动加强当前最强价值，形成
 *      无关漂移，违背「自我修改必须可解释」。明确的 category→value 映射（owner-config）是后续工作。
 *
 * 纯函数、零依赖，便于 vitest + 将来换成真正的 owner-config 映射。
 */

/** 解析所需的最小价值形态（core value 的子集）。 */
export interface ResolvableValue {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

export interface ResolvedTargetValue {
  readonly valueId: string;
  readonly currentWeight: number;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * 从 persona 的核心价值里，为某任务 category 选一个要强化的 value。
 * **只在有明确映射时返回**：精确 id/label → 子串；无明确映射或无价值 → null（不兜底，避免漂移）。
 */
export function resolveTargetValueForCategory(
  category: string,
  values: readonly ResolvableValue[],
): ResolvedTargetValue | null {
  if (values.length === 0) return null;
  const cat = norm(category);
  if (!cat) return null;

  /* 1. 精确匹配 id 或 label。 */
  const exact = values.find((v) => norm(v.id) === cat || norm(v.label) === cat);
  if (exact) return { valueId: exact.id, currentWeight: exact.weight };

  /* 2. 子串匹配（category ⊂ value 或 value ⊂ category）。 */
  const partial = values.find((v) => {
    const id = norm(v.id);
    const label = norm(v.label);
    return id.includes(cat) || cat.includes(id) || label.includes(cat) || cat.includes(label);
  });
  if (partial) return { valueId: partial.id, currentWeight: partial.weight };

  /* 3. 无明确映射：返回 null（不兜底强化最强价值）。 */
  return null;
}
