/**
 * 加载更多的并发/顺序守卫（纯函数，零依赖，便于 Node strip-only 单测）。
 */

/**
 * 是否允许发起加载第 `next` 页：
 *   - 已有请求在飞（inFlight）→ 拒绝（杜绝快速双击/并发重复追加同一页）。
 *   - 只允许首页（next===1）或已加载页的顺序下一页（loadedPage+1）→ 杜绝乱序/跳页累积。
 */
export function canLoadPage(inFlight: boolean, loadedPage: number, next: number): boolean {
  if (inFlight) return false;
  return next === 1 || next === loadedPage + 1;
}
