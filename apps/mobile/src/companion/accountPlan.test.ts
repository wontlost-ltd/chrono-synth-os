/**
 * 移动端 plan 解析纯逻辑回归（ADR-0046 Phase 2.3）。
 * Codex 审查指出 mobile 缺纯逻辑测试——这里锁住 resolveAccountPlanFromProbe 的全分支，
 * 尤其安全方向：只有 200 才进 companion，403/未知/未登录都不放行个人版 UI。
 */

import { resolveAccountPlanFromProbe } from './accountPlan';

describe('resolveAccountPlanFromProbe', () => {
  it('未配置（未登录）→ unconfigured，无论状态码', () => {
    expect(resolveAccountPlanFromProbe(false, 200)).toBe('unconfigured');
    expect(resolveAccountPlanFromProbe(false, 403)).toBe('unconfigured');
    expect(resolveAccountPlanFromProbe(false, 0)).toBe('unconfigured');
  });

  it('已配置 + 200 → companion', () => {
    expect(resolveAccountPlanFromProbe(true, 200)).toBe('companion');
  });

  it('已配置 + 403 → enterprise（companion 门控拒绝 enterprise）', () => {
    expect(resolveAccountPlanFromProbe(true, 403)).toBe('enterprise');
  });

  it('已配置但状态码语义未知（401/5xx/网络不可达 0）→ unconfigured，不臆断放行 companion', () => {
    for (const status of [0, 401, 404, 418, 500, 503]) {
      expect(resolveAccountPlanFromProbe(true, status)).toBe('unconfigured');
    }
  });

  it('安全不变量：任何非 200 都不会返回 companion', () => {
    for (const status of [0, 201, 204, 301, 400, 401, 403, 500]) {
      expect(resolveAccountPlanFromProbe(true, status)).not.toBe('companion');
    }
  });
});
