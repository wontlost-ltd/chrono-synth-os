/**
 * 共享纯函数：从两个 persona 快照计算 drift（ADR-0046 路线 A）。
 *
 * 把服务端 PersonaDriftAnalyzer 的**计算核心**（解析快照价值 + 算 delta + 定 alertLevel + 综合分）
 * 抽到 @chrono/contracts，让**服务端**（src/safety/persona-drift-analyzer.ts）与 **desktop 本地**
 * （apps/desktop，从同步下来的本地 snapshots 算 drift，真离线）共用同一份计算，杜绝分叉。
 *
 * 纯函数、零运行时依赖。输出的 valueDrifts 结构与既有 DriftLike（drift-to-growth.ts）对齐，
 * 可直接喂给 driftReportToGrowth。
 */

import type { DriftAlertLevelLike } from './drift-to-growth.js';

/** drift 阈值（|delta| ≥ critical → critical；≥ warning → warning；否则 ok）。 */
export interface DriftThresholdsLike {
  readonly warning: number;
  readonly critical: number;
}

/** 单条价值漂移（计算结果，含完整 baseline/current 便于审计；映射到探索时只用 delta/alertLevel）。 */
export interface ComputedValueDrift {
  readonly valueId: string;
  readonly label: string;
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
  readonly alertLevel: DriftAlertLevelLike;
}

/** drift 计算结果（与 DriftLike 对齐：含 valueDrifts/alertLevel；额外带 overallDriftScore）。 */
export interface ComputedDrift {
  readonly valueDrifts: readonly ComputedValueDrift[];
  readonly overallDriftScore: number;
  readonly alertLevel: DriftAlertLevelLike;
}

/** 快照里单条价值的最小形态。 */
interface CoreValueSnapshot {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

/**
 * 解析快照 JSON 的价值列表 → Map<id, {id,label,weight}>。
 * 兼容 `data.values` 与旧的 `data.L1` 两种键；非法/缺失返回空 Map（不抛）。
 */
export function parseSnapshotValues(dataJson: string): Map<string, CoreValueSnapshot> {
  const result = new Map<string, CoreValueSnapshot>();
  try {
    const data = JSON.parse(dataJson) as Record<string, unknown>;
    const values = (data.values ?? data.L1) as unknown;
    if (!Array.isArray(values)) return result;
    for (const v of values as unknown[]) {
      if (v !== null && typeof v === 'object') {
        const val = v as Record<string, unknown>;
        const id = String(val.id ?? '');
        const label = String(val.label ?? '');
        const weight = typeof val.weight === 'number' ? val.weight : 0;
        if (id) result.set(id, { id, label, weight });
      }
    }
  } catch {
    /* malformed snapshot — 返回空 */
  }
  return result;
}

/** |delta| → alertLevel。 */
export function computeAlertLevel(
  absDelta: number,
  thresholds: DriftThresholdsLike,
): DriftAlertLevelLike {
  if (absDelta >= thresholds.critical) return 'critical';
  if (absDelta >= thresholds.warning) return 'warning';
  return 'ok';
}

/**
 * 计算 baseline→current 两个快照之间的 drift。
 *
 * 语义与服务端 PersonaDriftAnalyzer.analyze 的对比段完全一致：
 *   - 遍历 baseline 的价值，找到 current 中同 id 的，算 delta = current.weight - baseline.weight；
 *   - alertLevel 由 |delta| 与阈值定；
 *   - overallDriftScore = mean(|delta|)（无 drift 时 0）；
 *   - 整体 alertLevel：任一 critical → critical；任一 warning → warning；否则 ok。
 * current 中没有的 baseline 价值跳过（与服务端一致）。入参是已解析的快照 JSON 字符串。
 */
export function computeDriftFromSnapshots(
  baselineJson: string,
  currentJson: string,
  thresholds: DriftThresholdsLike,
): ComputedDrift {
  const baselineValues = parseSnapshotValues(baselineJson);
  const currentValues = parseSnapshotValues(currentJson);

  const valueDrifts: ComputedValueDrift[] = [];
  for (const [id, baseVal] of baselineValues) {
    const curVal = currentValues.get(id);
    if (!curVal) continue;
    const delta = curVal.weight - baseVal.weight;
    valueDrifts.push({
      valueId: id,
      label: baseVal.label,
      baseline: baseVal.weight,
      current: curVal.weight,
      delta,
      alertLevel: computeAlertLevel(Math.abs(delta), thresholds),
    });
  }

  const overallDriftScore =
    valueDrifts.length > 0
      ? valueDrifts.reduce((sum, d) => sum + Math.abs(d.delta), 0) / valueDrifts.length
      : 0;

  let alertLevel: DriftAlertLevelLike = 'ok';
  if (valueDrifts.some((d) => d.alertLevel === 'critical')) alertLevel = 'critical';
  else if (valueDrifts.some((d) => d.alertLevel === 'warning')) alertLevel = 'warning';

  return { valueDrifts, overallDriftScore, alertLevel };
}
