/**
 * desktop ChronoCompanion 成长数据（ADR-0046 ② 路线 B：在线取 + 本地缓存）。
 *
 * desktop 本地 SQLCipher 没有 snapshots/drift 表（drift 是服务端实时算的），所以 Growth 改为：
 * 在线时 HTTP 取服务端**已映射**的 `/api/v1/companion/me/growth`（返回 CompanionGrowthV1，与 mobile
 * 同源），成功后把结果缓存到 app_settings；离线/启动时回退上次缓存。真·本地离线算 drift（路线 A）留后续。
 *
 * 纯函数 `pickGrowth`（合并 remote / cached）抽出来便于 vitest；副作用（fetch/读写缓存）在 runtime 层。
 */

import { CompanionGrowthV1Schema, type CompanionGrowthV1 } from '@chrono/contracts';
import { apiFetch, ApiNotConfiguredError } from '@/bridge/http-client';
import { getAppSetting, setAppSetting } from '@/bridge/tauri-commands';

/** 缓存上次成功的 growth DTO 的 app_settings 键。 */
export const APP_SETTING_GROWTH_CACHE = 'companion.growth.cache';

/** Growth 数据来源标记——UI 用它提示「在线最新」还是「上次同步」。 */
export type GrowthSource = 'remote' | 'cache' | 'none';

export interface GrowthResult {
  readonly growth: CompanionGrowthV1 | null;
  readonly source: GrowthSource;
  /** 未配置服务器（无 base URL/token）——UI 引导去设置，而非报错。 */
  readonly unconfigured: boolean;
}

/**
 * 合并 remote 与 cached 的纯决策：remote 成功优先；否则回退 cached；都没有则 none。
 * unconfigured 仅在「未配置且无缓存」时为 true（有缓存就先给用户看上次的）。
 */
export function pickGrowth(
  remote: CompanionGrowthV1 | null,
  cached: CompanionGrowthV1 | null,
  unconfigured: boolean,
): GrowthResult {
  if (remote) return { growth: remote, source: 'remote', unconfigured: false };
  if (cached) return { growth: cached, source: 'cache', unconfigured: false };
  return { growth: null, source: 'none', unconfigured };
}

/** 读缓存（解析 + schema 校验；脏缓存按无缓存处理，不抛）。 */
async function readCachedGrowth(): Promise<CompanionGrowthV1 | null> {
  try {
    const raw = await getAppSetting(APP_SETTING_GROWTH_CACHE);
    if (!raw) return null;
    return CompanionGrowthV1Schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** best-effort 写缓存（失败忽略）。 */
async function writeCachedGrowth(growth: CompanionGrowthV1): Promise<void> {
  try {
    await setAppSetting(APP_SETTING_GROWTH_CACHE, JSON.stringify(growth));
  } catch {
    /* 缓存写失败不影响本次展示，下次成功再写。 */
  }
}

/**
 * 取成长数据：先试在线（成功则刷新缓存），失败/未配置回退缓存。
 *
 * 返回 source 让 UI 区分「在线最新 / 上次同步 / 还在认识你」。任何网络/服务端错误都不抛——
 * 降级到缓存或空态，保证 Growth 页面始终可渲染（离线优先体验）。
 */
export async function loadCompanionGrowth(): Promise<GrowthResult> {
  const cached = await readCachedGrowth();
  try {
    const remote = CompanionGrowthV1Schema.parse(
      await apiFetch<unknown>('/api/v1/companion/me/growth'),
    );
    await writeCachedGrowth(remote);
    return pickGrowth(remote, cached, false);
  } catch (err) {
    /* 未配置服务器：若也无缓存，标记 unconfigured 让 UI 引导设置；有缓存则照常给缓存。 */
    const unconfigured = err instanceof ApiNotConfiguredError;
    return pickGrowth(null, cached, unconfigured);
  }
}
