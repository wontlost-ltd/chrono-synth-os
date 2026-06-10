/**
 * desktop ChronoCompanion 成长数据（ADR-0046 路线 A + B 分层）。
 *
 * 数据来源优先级：
 *   1. **remote（路线 B）**：在线取服务端已映射的 /api/v1/companion/me/growth；同时后台同步 snapshots 落本地。
 *   2. **local（路线 A）**：离线/服务端不可达时，用本地 snapshots（query_snapshots）+ 共享纯函数
 *      computeDriftFromSnapshots 本地算 drift → driftReportToGrowth。真·离线，不依赖上次缓存。
 *   3. **cache**：本地也算不出（snapshots <2）时回退上次成功的 growth 缓存。
 *   4. **none**：都没有 → 空态（未配置则引导设置）。
 *
 * 纯函数（pickGrowth / computeLocalGrowth）抽出便于 vitest；副作用（fetch/DB/缓存）在 runtime 层。
 */

import {
  CompanionGrowthV1Schema,
  driftReportToGrowth,
  computeDriftFromSnapshots,
  type CompanionGrowthV1,
  type DriftThresholdsLike,
} from '@chrono/contracts';
import { apiFetch, ApiNotConfiguredError } from '@/bridge/http-client';
import {
  getAppSetting,
  setAppSetting,
  querySnapshots,
  upsertSnapshots,
  type SnapshotRow,
} from '@/bridge/tauri-commands';

/** 缓存上次成功的 growth DTO 的 app_settings 键。 */
export const APP_SETTING_GROWTH_CACHE = 'companion.growth.cache';

/** desktop 本地算 drift 用的默认阈值（与服务端 DEFAULT_THRESHOLDS 一致）。 */
const LOCAL_DRIFT_THRESHOLDS: DriftThresholdsLike = { warning: 0.15, critical: 0.3 };

/** Growth 数据来源标记——UI 用它提示「在线最新 / 本地（离线）/ 上次同步」。 */
export type GrowthSource = 'remote' | 'local' | 'cache' | 'none';

export interface GrowthResult {
  readonly growth: CompanionGrowthV1 | null;
  readonly source: GrowthSource;
  /** 未配置服务器（无 base URL/token）——UI 引导去设置，而非报错。 */
  readonly unconfigured: boolean;
}

/**
 * 从本地最近两条快照算 growth（纯函数，便于测）。<2 条 → 无可对比基线 → null。
 * 快照按 created_at DESC（current 在前、baseline 在后），与服务端 analyzer 一致。
 */
export function computeLocalGrowth(snapshots: readonly SnapshotRow[]): CompanionGrowthV1 | null {
  if (snapshots.length < 2) return null;
  const current = snapshots[0]!;
  const baseline = snapshots[1]!;
  const computed = computeDriftFromSnapshots(
    baseline.data_json,
    current.data_json,
    LOCAL_DRIFT_THRESHOLDS,
  );
  /* 复用共享 driftReportToGrowth：DriftLike 结构化入参（analyzedAt/valueDrifts/alertLevel）。
   * analyzedAt 用 current 快照时间；hasComparisonBaseline=true（已确保 ≥2 条）。 */
  return driftReportToGrowth(
    { analyzedAt: current.created_at, valueDrifts: computed.valueDrifts, alertLevel: computed.alertLevel },
    true,
  );
}

/**
 * 合并 remote / local / cached 的纯决策：remote 优先 → 本地算 → 缓存 → none。
 * unconfigured 仅在「未配置且三者皆无」时为 true（有任何可显示数据就先给用户看）。
 */
export function pickGrowth(
  remote: CompanionGrowthV1 | null,
  local: CompanionGrowthV1 | null,
  cached: CompanionGrowthV1 | null,
  unconfigured: boolean,
): GrowthResult {
  if (remote) return { growth: remote, source: 'remote', unconfigured: false };
  if (local) return { growth: local, source: 'local', unconfigured: false };
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
 * 作废缓存的 growth（换凭据/登出时调用）——可 await，best-effort。
 *
 * growth 是用户画像/价值倾向，存在无账号维度的 app_settings 里，必须跟凭据生命周期绑定：
 * 换服务器/换 token/登出后绝不能让旧账号的成长数据串到新账号（Codex ② Major，与
 * clearCachedAccountPlan 同类）。
 */
export async function clearCachedCompanionGrowth(): Promise<void> {
  try {
    await setAppSetting(APP_SETTING_GROWTH_CACHE, '');
  } catch {
    /* 清缓存失败不阻断流程；脏/空缓存读取时已被 schema 校验按「无缓存」收敛。 */
  }
}

/**
 * 同步本地 snapshots（路线 A 数据源）：列最近 2 条 → 各取原始数据 → upsert 落本地。
 * best-effort：任何步骤失败都不抛（在线探测失败/未配置时跳过）；让在线时本地也攒着离线可算的数据。
 */
async function syncSnapshotsToLocal(): Promise<void> {
  try {
    /* 列表只要最近 2 条（drift 只需 current+baseline）。 */
    const list = await apiFetch<{ id: string }[] | { data?: unknown }>(
      '/api/v1/snapshots?page=1&pageSize=2',
    );
    /* apiFetch 已解包 {data}；列表分页响应是数组。 */
    const items = Array.isArray(list) ? list : [];
    const rows: SnapshotRow[] = [];
    for (const it of items as Array<{ id?: unknown }>) {
      const id = typeof it.id === 'string' ? it.id : null;
      if (!id) continue;
      const raw = await apiFetch<{ id: string; dataJson: string; reason: string; createdAt: number }>(
        `/api/v1/snapshots/${encodeURIComponent(id)}`,
      );
      rows.push({
        id: raw.id,
        data_json: raw.dataJson,
        reason: raw.reason,
        tenant_id: null,
        created_at: raw.createdAt,
        synced_at: Date.now(),
      });
    }
    if (rows.length > 0) await upsertSnapshots(rows);
  } catch {
    /* 同步失败不影响本次展示（可能离线/未配置/非 admin 无权拉 data）。下次在线再同步。 */
  }
}

/** 读本地 snapshots 算 growth（路线 A）；查询失败/无数据 → null，不抛。 */
async function loadLocalGrowth(): Promise<CompanionGrowthV1 | null> {
  try {
    return computeLocalGrowth(await querySnapshots());
  } catch {
    return null;
  }
}

/**
 * 取成长数据（路线 A+B 分层）：在线 remote 优先（成功则刷新缓存 + 后台同步本地 snapshots）；
 * 失败时本地算（路线 A，真离线）；再不行回退缓存；都无则空态/引导。
 *
 * 返回 source 让 UI 区分「在线最新 / 本地（离线）/ 上次同步 / 还在认识你」。任何错误都不抛。
 */
export async function loadCompanionGrowth(): Promise<GrowthResult> {
  const cached = await readCachedGrowth();
  try {
    const remote = CompanionGrowthV1Schema.parse(
      await apiFetch<unknown>('/api/v1/companion/me/growth'),
    );
    await writeCachedGrowth(remote);
    /* 在线成功：顺手把本地 snapshots 同步好，供日后离线本地算（不阻塞返回）。 */
    void syncSnapshotsToLocal();
    return pickGrowth(remote, null, cached, false);
  } catch (err) {
    /* remote 失败：先试本地算（路线 A 真离线），再回退缓存。 */
    const local = await loadLocalGrowth();
    const unconfigured = err instanceof ApiNotConfiguredError;
    return pickGrowth(null, local, cached, unconfigured);
  }
}
