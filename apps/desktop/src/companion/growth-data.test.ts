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
}));

import {
  pickGrowth,
  loadCompanionGrowth,
  clearCachedCompanionGrowth,
  APP_SETTING_GROWTH_CACHE,
} from './growth-data';
import { apiFetch, ApiNotConfiguredError } from '@/bridge/http-client';
import { getAppSetting, setAppSetting } from '@/bridge/tauri-commands';
import type { CompanionGrowthV1 } from '@chrono/contracts';

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const getAppSettingMock = getAppSetting as unknown as ReturnType<typeof vi.fn>;
const setAppSettingMock = setAppSetting as unknown as ReturnType<typeof vi.fn>;

const sample: CompanionGrowthV1 = {
  schemaVersion: 'companion-growth.v1',
  hasBaseline: true,
  analyzedAt: 5,
  overallIntensity: 'exploring',
  directions: [{ valueId: 'a', label: '冒险', direction: 'toward', magnitude: 0.4, intensity: 'exploring' }],
};

const cachedSample: CompanionGrowthV1 = { ...sample, analyzedAt: 1, overallIntensity: 'steady', directions: [] };

describe('pickGrowth（纯合并决策）', () => {
  it('remote 优先', () => {
    expect(pickGrowth(sample, cachedSample, false)).toEqual({ growth: sample, source: 'remote', unconfigured: false });
  });
  it('无 remote → 回退 cache', () => {
    expect(pickGrowth(null, cachedSample, false)).toEqual({ growth: cachedSample, source: 'cache', unconfigured: false });
  });
  it('都无 + unconfigured → none + unconfigured 标记', () => {
    expect(pickGrowth(null, null, true)).toEqual({ growth: null, source: 'none', unconfigured: true });
  });
  it('有 cache 时即使 unconfigured 也先给 cache（不标 unconfigured）', () => {
    expect(pickGrowth(null, cachedSample, true).source).toBe('cache');
  });
});

describe('loadCompanionGrowth（在线取 + 缓存回退）', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    getAppSettingMock.mockReset();
    setAppSettingMock.mockReset().mockResolvedValue(undefined);
  });

  it('在线成功 → 返回 remote 并写缓存', async () => {
    getAppSettingMock.mockResolvedValue(null);
    apiFetchMock.mockResolvedValue(sample);
    const out = await loadCompanionGrowth();
    expect(out.source).toBe('remote');
    expect(out.growth).toEqual(sample);
    expect(setAppSettingMock).toHaveBeenCalledWith(APP_SETTING_GROWTH_CACHE, JSON.stringify(sample));
  });

  it('在线失败但有缓存 → 回退 cache，不抛', async () => {
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
