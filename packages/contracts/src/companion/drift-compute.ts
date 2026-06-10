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

/** 把一个「价值条目」对象收敛成 {id,label,weight}；无 id 返回 null。 */
function toCoreValueSnapshot(v: unknown): CoreValueSnapshot | null {
  if (v === null || typeof v !== 'object') return null;
  const val = v as Record<string, unknown>;
  const id = String(val.id ?? '');
  if (!id) return null;
  const label = String(val.label ?? '');
  const weight = typeof val.weight === 'number' ? val.weight : 0;
  return { id, label, weight };
}

/**
 * 从任意「价值集合」形态收集价值。支持三种真实/历史形态：
 *   1. 普通数组 `[{id,label,weight}, ...]`（旧 fixtures / data.values / data.L1）。
 *   2. 序列化的 Map `{__type:'Map', entries:[[id, CoreValue], ...]}`（真实快照 coreSelf.values，
 *      deepStringify 产物——CoreValue 自带 id/label/weight）。
 *   3. 普通对象 `{ id: CoreValue }`（保险起见也支持）。
 */
function collectValues(values: unknown, into: Map<string, CoreValueSnapshot>): void {
  if (Array.isArray(values)) {
    for (const v of values) {
      const cv = toCoreValueSnapshot(v);
      if (cv) into.set(cv.id, cv);
    }
    return;
  }
  if (values !== null && typeof values === 'object') {
    const obj = values as Record<string, unknown>;
    /* 序列化 Map：取 entries 的 value（[key, CoreValue]）。 */
    if (obj.__type === 'Map' && Array.isArray(obj.entries)) {
      for (const entry of obj.entries as unknown[]) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const cv = toCoreValueSnapshot(entry[1]);
          if (cv) into.set(cv.id, cv);
        }
      }
      return;
    }
    /* 普通对象映射：每个 value 是 CoreValue。 */
    for (const v of Object.values(obj)) {
      const cv = toCoreValueSnapshot(v);
      if (cv) into.set(cv.id, cv);
    }
  }
}

/**
 * 解析快照 JSON 的价值列表 → Map<id, {id,label,weight}>。
 *
 * 真实快照（os.createSnapshot → deepStringify(SystemSnapshot)）把价值放在 `coreSelf.values`，且是
 * 序列化 Map（`{__type:'Map', entries}`）。历史/测试 fixtures 用顶层 `values`/`L1` 数组。三处都支持，
 * 非法/缺失返回空 Map（不抛）。
 */
export function parseSnapshotValues(dataJson: string): Map<string, CoreValueSnapshot> {
  const result = new Map<string, CoreValueSnapshot>();
  try {
    const data = JSON.parse(dataJson) as Record<string, unknown>;
    /* 真实快照：coreSelf.values。历史/fixtures：顶层 values / L1。按优先级取第一个存在的。 */
    const coreSelf = data.coreSelf as Record<string, unknown> | undefined;
    const source = coreSelf?.values ?? data.values ?? data.L1;
    collectValues(source, result);
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
 * current 中没有的 baseline 价值跳过（与服务端一致）。入参 baselineJson/currentJson 是**原始**
 * 快照 JSON 字符串（内部用 parseSnapshotValues 解析）。
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
