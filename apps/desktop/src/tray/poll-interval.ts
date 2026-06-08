/**
 * 后台省电：轮询间隔的电源感知策略（ADR-0046 Phase 2.4c，TS 侧纯逻辑）。
 *
 * desktop 常驻会定期拉 sync 状态 / drift 报告。窗口隐藏或电池供电时拉长间隔省电；
 * 可见且插电时用最短间隔保持实时。纯函数，可 vitest；Rust 侧负责把窗口 focus/blur +
 * 电源状态 emit 给前端（需 cargo 环境，见文件末注释）。
 *
 * 取舍：用离散档位而非连续函数——可预测、好测、对用户无感。最长档限制在 5 分钟，
 * 避免「省电」到状态严重过期。
 */

/** 轮询间隔档位（毫秒）。 */
export const POLL_INTERVAL_MS = {
  /** 可见 + 插电：实时。 */
  active: 30_000,
  /** 可见 + 电池：适度放慢。 */
  visibleOnBattery: 60_000,
  /** 隐藏 + 插电：后台慢轮询。 */
  hiddenPlugged: 120_000,
  /** 隐藏 + 电池：最省电（上限 5 分钟）。 */
  hiddenOnBattery: 300_000,
} as const;

export interface PowerState {
  /** 窗口是否可见（document.visibilityState === 'visible' 或 Tauri focus）。 */
  readonly visible: boolean;
  /** 是否电池供电（true=电池，false=插电/未知）。 */
  readonly onBattery: boolean;
}

/**
 * 按电源状态算轮询间隔。
 *
 * 矩阵：
 *   可见+插电 → active(30s)；可见+电池 → 60s；隐藏+插电 → 120s；隐藏+电池 → 300s。
 * 「未知电源」按插电处理（onBattery=false），避免在不确定时过度省电。
 */
export function computePollInterval(state: PowerState): number {
  if (state.visible) {
    return state.onBattery ? POLL_INTERVAL_MS.visibleOnBattery : POLL_INTERVAL_MS.active;
  }
  return state.onBattery ? POLL_INTERVAL_MS.hiddenOnBattery : POLL_INTERVAL_MS.hiddenPlugged;
}
