import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/bridge/http-client', () => {
  class ApiNotConfiguredError extends Error {
    constructor() {
      super('not configured');
      this.name = 'ApiNotConfiguredError';
    }
  }
  return { apiFetch: vi.fn(), ApiNotConfiguredError };
});
vi.mock('@/bridge/tauri-commands', () => ({
  getAppSetting: vi.fn(),
  setAppSetting: vi.fn().mockResolvedValue(undefined),
  querySnapshots: vi.fn().mockResolvedValue([]),
  upsertSnapshots: vi.fn().mockResolvedValue(undefined),
}));

import {
  pickGrowth,
  computeLocalGrowth,
  loadCompanionGrowth,
  clearCachedCompanionGrowth,
  APP_SETTING_GROWTH_CACHE,
} from './growth-data';
import { apiFetch, ApiNotConfiguredError } from '@/bridge/http-client';
import { getAppSetting, setAppSetting, querySnapshots } from '@/bridge/tauri-commands';
import type { CompanionGrowthV1 } from '@chrono/contracts';
import type { SnapshotRow } from '@/bridge/tauri-commands';

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const getAppSettingMock = getAppSetting as unknown as ReturnType<typeof vi.fn>;
const setAppSettingMock = setAppSetting as unknown as ReturnType<typeof vi.fn>;
const querySnapshotsMock = querySnapshots as unknown as ReturnType<typeof vi.fn>;

/** 造一条本地快照行。 */
function snapRow(id: string, createdAt: number, values: Array<{ id: string; label: string; weight: number }>): SnapshotRow {
  return {
    id,
    data_json: JSON.stringify({ values }),
    reason: '',
    tenant_id: null,
    created_at: createdAt,
    synced_at: 0,
  };
}

const sample: CompanionGrowthV1 = {
  schemaVersion: 'companion-growth.v1',
  hasBaseline: true,
  analyzedAt: 5,
  overallIntensity: 'exploring',
  directions: [{ valueId: 'a', label: '冒险', direction: 'toward', magnitude: 0.4, intensity: 'exploring' }],
};

const cachedSample: CompanionGrowthV1 = { ...sample, analyzedAt: 1, overallIntensity: 'steady', directions: [] };

const localSample: CompanionGrowthV1 = { ...sample, analyzedAt: 3, overallIntensity: 'leaping' };

describe('pickGrowth（纯合并决策：remote → local → cache → none）', () => {
  it('remote 优先（即使有 local/cache）', () => {
    expect(pickGrowth(sample, localSample, cachedSample, false)).toEqual({ growth: sample, source: 'remote', unconfigured: false });
  });
  it('无 remote 有 local → local（路线 A 离线本地算优先于上次缓存）', () => {
    expect(pickGrowth(null, localSample, cachedSample, false)).toEqual({ growth: localSample, source: 'local', unconfigured: false });
  });
  it('无 remote 无 local 有 cache → cache', () => {
    expect(pickGrowth(null, null, cachedSample, false)).toEqual({ growth: cachedSample, source: 'cache', unconfigured: false });
  });
  it('都无 + unconfigured → none + unconfigured 标记', () => {
    expect(pickGrowth(null, null, null, true)).toEqual({ growth: null, source: 'none', unconfigured: true });
  });
  it('有 local 时即使 unconfigured 也先给 local（不标 unconfigured）', () => {
    expect(pickGrowth(null, localSample, null, true).source).toBe('local');
  });
});

describe('computeLocalGrowth（路线 A：本地快照算 drift）', () => {
  it('<2 快照 → null（无可对比基线）', () => {
    expect(computeLocalGrowth([])).toBeNull();
    expect(computeLocalGrowth([snapRow('a', 100, [])])).toBeNull();
  });

  it('≥2 快照 → 算出 growth（current 在前 baseline 在后），analyzedAt=current 时间', () => {
    /* querySnapshots 返回 DESC：current(300) 在前、baseline(100) 在后。冒险 +0.3 → toward。 */
    const out = computeLocalGrowth([
      snapRow('cur', 300, [{ id: 'a', label: '冒险', weight: 0.5 }]),
      snapRow('base', 100, [{ id: 'a', label: '冒险', weight: 0.2 }]),
    ]);
    expect(out).not.toBeNull();
    expect(out!.hasBaseline).toBe(true);
    expect(out!.analyzedAt).toBe(300);
    expect(out!.directions[0]?.direction).toBe('toward');
    expect(out!.directions[0]?.label).toBe('冒险');
  });
});

describe('loadCompanionGrowth（路线 A+B 分层）', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    getAppSettingMock.mockReset();
    setAppSettingMock.mockReset().mockResolvedValue(undefined);
    querySnapshotsMock.mockReset().mockResolvedValue([]); // 默认无本地快照
  });

  it('在线成功 → 返回 remote 并写缓存', async () => {
    getAppSettingMock.mockResolvedValue(null);
    apiFetchMock.mockResolvedValue(sample);
    const out = await loadCompanionGrowth();
    expect(out.source).toBe('remote');
    expect(out.growth).toEqual(sample);
    expect(setAppSettingMock).toHaveBeenCalledWith(APP_SETTING_GROWTH_CACHE, JSON.stringify(sample));
  });

  it('在线失败 + 本地有 ≥2 快照 → local（路线 A 真离线算），优先于缓存', async () => {
    getAppSettingMock.mockResolvedValue(JSON.stringify(cachedSample));
    apiFetchMock.mockRejectedValue(new Error('offline'));
    querySnapshotsMock.mockResolvedValue([
      snapRow('cur', 300, [{ id: 'a', label: '冒险', weight: 0.6 }]),
      snapRow('base', 100, [{ id: 'a', label: '冒险', weight: 0.2 }]),
    ]);
    const out = await loadCompanionGrowth();
    expect(out.source).toBe('local');
    expect(out.growth?.hasBaseline).toBe(true);
    expect(out.growth?.analyzedAt).toBe(300);
  });

  it('在线失败 + 本地无快照但有缓存 → 回退 cache，不抛', async () => {
    getAppSettingMock.mockResolvedValue(JSON.stringify(cachedSample));
    apiFetchMock.mockRejectedValue(new Error('network down'));
    const out = await loadCompanionGrowth();
    expect(out.source).toBe('cache');
    expect(out.growth).toEqual(cachedSample);
  });

  it('未配置 + 无缓存 → unconfigured', async () => {
    getAppSettingMock.mockResolvedValue(null);
    apiFetchMock.mockRejectedValue(new ApiNotConfiguredError());
    const out = await loadCompanionGrowth();
    expect(out).toEqual({ growth: null, source: 'none', unconfigured: true });
  });

  it('脏缓存（非法 JSON）按无缓存处理，不抛', async () => {
    getAppSettingMock.mockResolvedValue('{not json');
    apiFetchMock.mockRejectedValue(new Error('offline'));
    const out = await loadCompanionGrowth();
    expect(out.source).toBe('none');
  });

  it('remote 返回非法 schema（ZodError）但缓存有效 → 回退 cache', async () => {
    getAppSettingMock.mockResolvedValue(JSON.stringify(cachedSample));
    /* 缺字段/类型错 → CompanionGrowthV1Schema.parse 抛 ZodError，应被 catch 回退缓存。 */
    apiFetchMock.mockResolvedValue({ schemaVersion: 'companion-growth.v1', hasBaseline: 'yes' });
    const out = await loadCompanionGrowth();
    expect(out.source).toBe('cache');
    expect(out.growth).toEqual(cachedSample);
  });

  it('remote 成功但写缓存失败 → 仍返回 remote（best-effort 缓存）', async () => {
    getAppSettingMock.mockResolvedValue(null);
    apiFetchMock.mockResolvedValue(sample);
    setAppSettingMock.mockImplementation(async () => {
      throw new Error('disk full');
    });
    const out = await loadCompanionGrowth();
    expect(out.source).toBe('remote');
    expect(out.growth).toEqual(sample);
  });
});

describe('clearCachedCompanionGrowth（换凭据/登出清缓存，Codex ② Major）', () => {
  beforeEach(() => setAppSettingMock.mockReset().mockResolvedValue(undefined));

  it('把 growth 缓存键置空', async () => {
    await clearCachedCompanionGrowth();
    expect(setAppSettingMock).toHaveBeenCalledWith(APP_SETTING_GROWTH_CACHE, '');
  });
});
