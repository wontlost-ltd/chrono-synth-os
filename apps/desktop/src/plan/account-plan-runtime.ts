/**
 * `resolveAccountPlan` 的运行时装配（ADR-0046 Phase 2.4a）：把 account-plan.ts 的纯逻辑
 * 接到真实依赖——HTTP 探测 `/api/v1/companion/me` + app_settings 缓存。
 *
 * 拆成单独文件，让 account-plan.ts 保持零桥接依赖、纯函数可测；本文件只做「接线」，无分支逻辑。
 */

import { getApiBaseUrl, getApiToken } from '@/bridge/http-client';
import { getAppSetting, setAppSetting } from '@/bridge/tauri-commands';
import {
  resolveAccountPlanWith,
  APP_SETTING_ACCOUNT_PLAN,
  type AccountPlan,
  type PlanProbeResult,
} from './account-plan';

/**
 * 探测 `/api/v1/companion/me`：只关心状态码，不解析响应体。
 * 网络/fetch 异常吞掉转成 `status: 0`（= 不可达），交给上层回退缓存——探测本身不抛。
 */
async function probeCompanionPlan(): Promise<PlanProbeResult> {
  const base = getApiBaseUrl();
  const token = getApiToken();
  if (!base || !token) return { unconfigured: true, status: 0 };
  try {
    const res = await fetch(`${base}/api/v1/companion/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    return { unconfigured: false, status: res.status };
  } catch {
    return { unconfigured: false, status: 0 };
  }
}

/** 解析当前账号 plan（真实依赖）。供 App.tsx 在 ready→渲染路由前调用一次。 */
export function resolveAccountPlan(): Promise<AccountPlan> {
  return resolveAccountPlanWith({
    probe: probeCompanionPlan,
    readCachedPlan: () => getAppSetting(APP_SETTING_ACCOUNT_PLAN),
    writeCachedPlan: (plan) => setAppSetting(APP_SETTING_ACCOUNT_PLAN, plan),
  });
}
