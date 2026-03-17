/**
 * 冲突检测与解决 — 纯领域类型与逻辑
 * 零 node:* 依赖
 */

/** 冲突类型 */
export type ConflictKind = 'value_divergence' | 'resource_contention' | 'narrative_inconsistency';

/** 冲突严重程度 */
export type ConflictSeverity = 'low' | 'medium' | 'high' | 'critical';

/** 冲突记录 */
export interface Conflict {
  readonly id: string;
  readonly kind: ConflictKind;
  readonly severity: ConflictSeverity;
  readonly involvedVersions: readonly string[];
  readonly affectedValues: readonly string[];
  readonly description: string;
  readonly detectedAt: number;
  resolvedAt?: number;
  resolution?: string;
}

/** 人格版本的最小接口（仅包含冲突检测所需字段） */
export interface PersonaVersionSnapshot {
  readonly id: string;
  readonly label: string;
  readonly values: ReadonlyMap<string, number>;
  readonly status: string;
  readonly resourceQuota: number;
}

/** 分歧数量 → 严重等级阈值 */
const SEVERITY_CRITICAL_THRESHOLD = 5;
const SEVERITY_HIGH_THRESHOLD = 3;
const SEVERITY_MEDIUM_THRESHOLD = 2;

/** 根据分歧数量判定严重等级 */
export function classifyConflictSeverity(divergenceCount: number): ConflictSeverity {
  if (divergenceCount >= SEVERITY_CRITICAL_THRESHOLD) return 'critical';
  if (divergenceCount >= SEVERITY_HIGH_THRESHOLD) return 'high';
  if (divergenceCount >= SEVERITY_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/** 生成版本对的规范化键（用于去重） */
export function pairKey(versions: readonly string[]): string {
  return [...versions].sort().join('|');
}

/** 价值分歧检测结果 */
export interface ValueDivergenceResult {
  readonly involvedVersions: [string, string];
  readonly affectedValues: string[];
  readonly severity: ConflictSeverity;
  readonly description: string;
}

/**
 * 检测价值分歧（纯函数）
 * 对比所有人格版本对的价值权重，返回超阈值的分歧列表
 * @param existingPairKeys 已有未解决冲突的版本对键集合（用于跳过）
 */
export function detectValueDivergences(
  personas: readonly PersonaVersionSnapshot[],
  threshold: number,
  existingPairKeys: ReadonlySet<string>,
): ValueDivergenceResult[] {
  const results: ValueDivergenceResult[] = [];

  for (let i = 0; i < personas.length; i++) {
    for (let j = i + 1; j < personas.length; j++) {
      const a = personas[i];
      const b = personas[j];

      if (existingPairKeys.has(pairKey([a.id, b.id]))) continue;

      const affectedValues: string[] = [];
      for (const [key, weightA] of a.values) {
        const weightB = b.values.get(key);
        if (weightB !== undefined && Math.abs(weightA - weightB) > threshold) {
          affectedValues.push(key);
        }
      }

      if (affectedValues.length > 0) {
        results.push({
          involvedVersions: [a.id, b.id],
          affectedValues,
          severity: classifyConflictSeverity(affectedValues.length),
          description: `人格 ${a.label} 与 ${b.label} 在 ${affectedValues.length} 个价值维度上存在分歧`,
        });
      }
    }
  }

  return results;
}

/** 资源争用检测结果 */
export interface ResourceContentionResult {
  readonly involvedVersions: string[];
  readonly totalQuota: number;
  readonly severity: ConflictSeverity;
  readonly description: string;
}

/**
 * 检测资源争用（纯函数）
 * 检查所有活跃人格版本的资源配额总和是否超过 1.0
 */
export function detectResourceContention(
  personas: readonly PersonaVersionSnapshot[],
): ResourceContentionResult | undefined {
  const activePersonas = personas.filter(p => p.status === 'active');
  const totalQuota = activePersonas.reduce((sum, p) => sum + p.resourceQuota, 0);

  if (totalQuota > 1.0) {
    return {
      involvedVersions: activePersonas.map(p => p.id),
      totalQuota,
      severity: totalQuota > 1.5 ? 'critical' : 'high',
      description: `活跃人格总资源配额 ${totalQuota.toFixed(2)} 超过 1.0`,
    };
  }
  return undefined;
}
