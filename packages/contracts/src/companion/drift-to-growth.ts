/**
 * 共享纯函数：persona drift → ChronoCompanion「你最近探索的方向」(ADR-0046)。
 *
 * 把企业版 persona drift（同一份数据被企业控制台渲染成「policy violation / alert」）重新组织成
 * C 端「探索方向」语义：alertLevel→探索强度，delta 符号→toward/away，magnitude=|delta|。
 *
 * 抽到 @chrono/contracts 让**服务端**（src/server/routes/companion/me.ts）与 **desktop 本地**
 * （apps/desktop，渲染本地 SQLCipher 的 drift 报告）共用同一份映射，杜绝分叉。零运行时依赖、纯函数。
 *
 * 输入用结构化 `DriftLike`（只取映射所需字段），让服务端 `DriftReport` 与 desktop 本地 drift 报告
 * 都能结构化满足，而不耦合任一具体类型。
 */

import type {
  CompanionGrowthV1,
  ExplorationDirectionV1,
  ExplorationIntensityV1,
} from './me.js';

/** 探索强度的来源等级（= 企业版 drift alertLevel，语义不变，不叫「告警」）。 */
export type DriftAlertLevelLike = 'ok' | 'warning' | 'critical';

/** 单条价值漂移（映射所需的最小字段）。 */
export interface ValueDriftLike {
  readonly valueId: string;
  readonly label: string;
  /** 权重变化量（正=越来越看重，负=越来越不看重）。 */
  readonly delta: number;
  readonly alertLevel: DriftAlertLevelLike;
}

/** drift 报告（映射所需的最小字段）；服务端 DriftReport 与 desktop 本地报告均结构化满足。 */
export interface DriftLike {
  readonly analyzedAt: number;
  readonly valueDrifts: readonly ValueDriftLike[];
  readonly alertLevel: DriftAlertLevelLike;
}

/** alertLevel → 探索强度（ok→steady、warning→exploring、critical→leaping）。 */
export function alertLevelToIntensity(level: DriftAlertLevelLike): ExplorationIntensityV1 {
  switch (level) {
    case 'critical': return 'leaping';
    case 'warning': return 'exploring';
    default: return 'steady';
  }
}

/** 单条 ValueDrift → 探索方向（direction 由 delta 符号定，magnitude=|delta| 夹到 0..1）。 */
export function valueDriftToDirection(d: ValueDriftLike): ExplorationDirectionV1 {
  const magnitude = Math.min(1, Math.abs(d.delta));
  const direction: ExplorationDirectionV1['direction'] =
    d.delta > 0 ? 'toward' : d.delta < 0 ? 'away' : 'steady';
  return {
    valueId: d.valueId,
    label: d.label,
    direction,
    magnitude,
    intensity: alertLevelToIntensity(d.alertLevel),
  };
}

/**
 * drift 报告 → C 端成长视图。
 *
 * `hasBaseline` **不能**仅看报告是否存在：drift 分析器在只有 1 个快照时仍会产出一份
 * valueDrifts=[] 的报告（那个快照是「当前」而非「历史基线」）。真正的基线需 ≥2 个快照对比，
 * 故由调用方传入 `hasComparisonBaseline`。report 为 null（从未分析）时一律空态。
 */
export function driftReportToGrowth(
  report: DriftLike | null,
  hasComparisonBaseline: boolean,
): CompanionGrowthV1 {
  if (!report || !hasComparisonBaseline) {
    return {
      schemaVersion: 'companion-growth.v1',
      hasBaseline: false,
      analyzedAt: report?.analyzedAt ?? null,
      overallIntensity: 'steady',
      directions: [],
    };
  }
  const directions = report.valueDrifts
    .map(valueDriftToDirection)
    .sort((a, b) => b.magnitude - a.magnitude);
  return {
    schemaVersion: 'companion-growth.v1',
    hasBaseline: true,
    analyzedAt: report.analyzedAt,
    overallIntensity: alertLevelToIntensity(report.alertLevel),
    directions,
  };
}
