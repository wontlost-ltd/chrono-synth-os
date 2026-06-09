/**
 * 移动端账号 plan 解析（ADR-0046 Phase 2.3）：决定渲染企业版 tab 还是 ChronoCompanion tab。
 *
 * 与 desktop 同语义但**在线优先、无本地缓存**（移动端默认联网；离线体验是后续工作）。
 * 复用服务端 plan 门控：探测 /api/v1/companion/me 状态码——200=个人版放行、403=enterprise 拒绝。
 */

import { hasSession, probeStatus } from '../api/client';

export type AccountPlan = 'enterprise' | 'companion' | 'unconfigured';

/**
 * 纯判定：根据「是否已配置会话」+ 探测状态码得出 plan。
 *   - 未配置（未登录）→ unconfigured。
 *   - 200 → companion；403 → enterprise。
 *   - 其它（401/5xx/网络不可达 status=0）→ unconfigured（让上层走默认/引导，不臆断）。
 */
export function resolveAccountPlanFromProbe(configured: boolean, status: number): AccountPlan {
  if (!configured) return 'unconfigured';
  if (status === 200) return 'companion';
  if (status === 403) return 'enterprise';
  return 'unconfigured';
}

/** 解析当前账号 plan（真实依赖）。 */
export async function resolveAccountPlan(): Promise<AccountPlan> {
  if (!hasSession()) return 'unconfigured';
  const status = await probeStatus('/api/v1/companion/me');
  return resolveAccountPlanFromProbe(true, status);
}
