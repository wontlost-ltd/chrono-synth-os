import { describe, it, expect, vi } from 'vitest';
import {
  resolveAccountPlanWith,
  type AccountPlanDeps,
  type PlanProbeResult,
} from './account-plan';

/** 造一组依赖：probe 固定返回 result，缓存读固定返回 cached，写记录调用。 */
function makeDeps(
  result: PlanProbeResult,
  cached: string | null,
): { deps: AccountPlanDeps; writeCachedPlan: ReturnType<typeof vi.fn> } {
  const writeCachedPlan = vi.fn().mockResolvedValue(undefined);
  return {
    writeCachedPlan,
    deps: {
      probe: vi.fn().mockResolvedValue(result),
      readCachedPlan: vi.fn().mockResolvedValue(cached),
      writeCachedPlan,
    },
  };
}

describe('resolveAccountPlanWith', () => {
  it('未配置 API → unconfigured，且不写缓存', async () => {
    const { deps, writeCachedPlan } = makeDeps({ unconfigured: true, status: 0 }, null);
    expect(await resolveAccountPlanWith(deps)).toBe('unconfigured');
    expect(writeCachedPlan).not.toHaveBeenCalled();
  });

  it('200 → companion，并缓存 companion', async () => {
    const { deps, writeCachedPlan } = makeDeps({ unconfigured: false, status: 200 }, null);
    expect(await resolveAccountPlanWith(deps)).toBe('companion');
    expect(writeCachedPlan).toHaveBeenCalledWith('companion');
  });

  it('403 → enterprise，并缓存 enterprise', async () => {
    const { deps, writeCachedPlan } = makeDeps({ unconfigured: false, status: 403 }, null);
    expect(await resolveAccountPlanWith(deps)).toBe('enterprise');
    expect(writeCachedPlan).toHaveBeenCalledWith('enterprise');
  });

  it('网络不可达(status=0) → 回退本地缓存的 enterprise', async () => {
    const { deps, writeCachedPlan } = makeDeps({ unconfigured: false, status: 0 }, 'enterprise');
    expect(await resolveAccountPlanWith(deps)).toBe('enterprise');
    /* 回退路径不应覆盖缓存。 */
    expect(writeCachedPlan).not.toHaveBeenCalled();
  });

  it('网络不可达 + 缓存为 companion → 回退 companion', async () => {
    const { deps } = makeDeps({ unconfigured: false, status: 0 }, 'companion');
    expect(await resolveAccountPlanWith(deps)).toBe('companion');
  });

  it('网络不可达 + 无缓存 → unconfigured', async () => {
    const { deps } = makeDeps({ unconfigured: false, status: 0 }, null);
    expect(await resolveAccountPlanWith(deps)).toBe('unconfigured');
  });

  it('能连上但状态码语义未知(如 401/500) → 回退缓存，不臆断、不覆盖缓存', async () => {
    for (const status of [401, 500, 204]) {
      const { deps, writeCachedPlan } = makeDeps({ unconfigured: false, status }, 'enterprise');
      expect(await resolveAccountPlanWith(deps)).toBe('enterprise');
      expect(writeCachedPlan).not.toHaveBeenCalled();
    }
  });

  it('缓存里的脏值 → 收敛成 unconfigured', async () => {
    const { deps } = makeDeps({ unconfigured: false, status: 0 }, 'garbage-value');
    expect(await resolveAccountPlanWith(deps)).toBe('unconfigured');
  });

  /* ── 「不抛」契约：桥接读写/probe 失败都不能冒泡（App 状态机依赖它失败也能进 ready）。 ── */

  it('200 但写缓存 reject → 仍返回 companion（缓存 best-effort）', async () => {
    const deps: AccountPlanDeps = {
      probe: vi.fn().mockResolvedValue({ unconfigured: false, status: 200 }),
      readCachedPlan: vi.fn().mockResolvedValue(null),
      writeCachedPlan: vi.fn().mockRejectedValue(new Error('keyring locked')),
    };
    await expect(resolveAccountPlanWith(deps)).resolves.toBe('companion');
  });

  it('网络不可达 + 读缓存 reject → 收敛 unconfigured，不抛', async () => {
    const deps: AccountPlanDeps = {
      probe: vi.fn().mockResolvedValue({ unconfigured: false, status: 0 }),
      readCachedPlan: vi.fn().mockRejectedValue(new Error('db locked')),
      writeCachedPlan: vi.fn().mockResolvedValue(undefined),
    };
    await expect(resolveAccountPlanWith(deps)).resolves.toBe('unconfigured');
  });

  it('probe 本身抛 → 视作不可达回退缓存，不抛', async () => {
    const deps: AccountPlanDeps = {
      probe: vi.fn().mockRejectedValue(new Error('boom')),
      readCachedPlan: vi.fn().mockResolvedValue('enterprise'),
      writeCachedPlan: vi.fn().mockResolvedValue(undefined),
    };
    await expect(resolveAccountPlanWith(deps)).resolves.toBe('enterprise');
  });
});
