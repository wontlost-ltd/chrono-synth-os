/**
 * 回应变化性 / 即兴（ADR-0056 类人化：不做复读机）——确定性、零-LLM。
 *
 * 人不会每次都用一模一样的话回应。但论点铁律（ADR-0047）要求**确定性可复现**：相同输入+相同状态
 * → 相同输出。看似矛盾，解法是——变化性是**演化状态的确定性函数**，不是随机：
 *   用已有的 interactionCount 作「轮次索引」，按 index % 变体数 轮换措辞。
 *   → 相同人格状态（含相同 count）→ 相同变体（可复现，重放同序列得同结果）；
 *   → 随关系推进（count 每轮 +1）→ 同一句问法的表层措辞自然轮换，消除机械重复。
 *
 * 关键：变体库**第 0 个元素 = 既有原文**，seed=0/缺省 → 取原文 → 零回归（旧行为不变）。
 */

/**
 * 从变体库按确定性轮次索引取一个（index = seed mod 变体数）。
 * 变体库第 0 个应是既有原文，保证 seed=0/缺省 → 零回归。空库 → 空串。
 * 负数/非整 seed 容错钳为 0。
 */
export function variantPick(variants: readonly string[], seed = 0): string {
  if (variants.length === 0) return '';
  if (!Number.isFinite(seed) || seed <= 0) return variants[0] ?? '';
  const idx = Math.floor(seed) % variants.length;
  return variants[idx] ?? variants[0] ?? '';
}
