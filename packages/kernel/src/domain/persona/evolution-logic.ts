/**
 * 演化合并 — 纯领域逻辑
 * 最优结果选择、差异报告生成、后悔概率计算
 * 零 node:* 依赖
 */

/** 模拟结果最小接口 */
export interface FitnessResult {
  readonly fitnessScore: number;
}

/** 价值差异条目 */
export interface ValueDiff {
  readonly valueId: string;
  readonly label: string;
  readonly weightBefore: number;
  readonly weightAfter: number;
  readonly delta: number;
}

/** 演化差异报告 */
export interface EvolutionDiffReport {
  readonly valueDiffs: readonly ValueDiff[];
  readonly regretProbability: number;
  readonly totalDeltaMagnitude: number;
  readonly summary: string;
}

/**
 * 选择最高适应度的结果（纯函数）
 */
export function selectBestResult<T extends FitnessResult>(results: readonly T[]): T | undefined {
  if (results.length === 0) return undefined;
  return results.reduce((best, r) => r.fitnessScore > best.fitnessScore ? r : best);
}

/**
 * 计算后悔概率（纯函数）
 * 公式：regretSensitivity × tanh(totalDeltaMagnitude / max(valueCount, 1))
 */
export function computeRegretProbability(
  regretSensitivity: number,
  totalDeltaMagnitude: number,
  valueCount: number,
): number {
  return regretSensitivity * Math.tanh(totalDeltaMagnitude / Math.max(valueCount, 1));
}

/** 合并前后价值快照 */
export interface ValueSnapshot {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

/**
 * 构建演化差异报告（纯函数）
 * 比较合并前后的价值权重，生成差异条目和后悔概率
 */
export function buildEvolutionDiffReport(
  beforeValues: ReadonlyMap<string, ValueSnapshot>,
  afterValues: ReadonlyMap<string, ValueSnapshot>,
  mergedCount: number,
  regretSensitivity: number,
): EvolutionDiffReport {
  const valueDiffs: ValueDiff[] = [];

  for (const [id, after] of afterValues) {
    const before = beforeValues.get(id);
    if (before !== undefined && before.weight !== after.weight) {
      valueDiffs.push({
        valueId: id,
        label: before.label,
        weightBefore: before.weight,
        weightAfter: after.weight,
        delta: after.weight - before.weight,
      });
    }
  }

  const totalDeltaMagnitude = valueDiffs.reduce((sum, d) => sum + Math.abs(d.delta), 0);
  const regretProbability = computeRegretProbability(
    regretSensitivity, totalDeltaMagnitude, beforeValues.size,
  );

  const summary = mergedCount === 0
    ? '无版本被合并'
    : `合并 ${mergedCount} 个版本，影响 ${valueDiffs.length} 个价值维度，总偏移量 ${totalDeltaMagnitude.toFixed(4)}，后悔概率 ${(regretProbability * 100).toFixed(1)}%`;

  return { valueDiffs, regretProbability, totalDeltaMagnitude, summary };
}
