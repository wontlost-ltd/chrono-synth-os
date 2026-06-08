/**
 * 账号 plan 解析（ADR-0046 Phase 2.4a）：决定 desktop 渲染**企业控制台**还是 **ChronoCompanion**。
 *
 * 决策（Ryan 已定）：**plan 服务端权威 + 本地缓存（混合）**。
 *   - 服务端权威：复用既有 plan 门控——服务端 `assertCompanionAccess` 对 enterprise 账号返回 403、
 *     对个人版账号放行（200）。desktop 探测 `GET /api/v1/companion/me` 的状态码即得 plan，**零新后端**。
 *   - 本地缓存：探测成功后把结果写入 app_settings；离线/探测失败时回退上次缓存，保证离线可用。
 *
 * 本模块是纯逻辑 + 依赖注入（probe / 读写缓存都从外部传入），便于 vitest 全分支覆盖；
 * 用真实桥接接好线的 `resolveAccountPlan` 在 `account-plan-runtime.ts` 里。
 *
 * **不抛契约**：本函数对外承诺「不抛」（App.tsx 的状态机依赖它失败也能进 ready）。因此对注入的
 * 缓存读/写都做 best-effort 兜底——写失败忽略、读失败按无缓存处理，绝不让桥接异常冒泡。
 */

/** 账号 plan 解析结果。 */
export type AccountPlan = 'enterprise' | 'companion' | 'unconfigured';

/** app_settings 中缓存上次成功解析的 plan 的键。 */
export const APP_SETTING_ACCOUNT_PLAN = 'account.plan';

/** plan 探测结果：HTTP 状态码 + 是否「未配置」（无 base URL/token）。 */
export interface PlanProbeResult {
  /** true = 本地未配置 API（无 base URL 或 token），无法探测。 */
  readonly unconfigured: boolean;
  /** 探测到的 HTTP 状态码（unconfigured=true 时无意义）。 */
  readonly status: number;
}

/** `resolveAccountPlan` 的注入依赖，全部可在测试里替换。 */
export interface AccountPlanDeps {
  /** 探测 `/api/v1/companion/me`：返回未配置标记或 HTTP 状态码（不抛网络错误，内部吞掉转成 status=0）。 */
  readonly probe: () => Promise<PlanProbeResult>;
  /** 读上次缓存的 plan（app_settings）。无缓存返回 null。 */
  readonly readCachedPlan: () => Promise<string | null>;
  /** 写缓存 plan（app_settings）。 */
  readonly writeCachedPlan: (plan: AccountPlan) => Promise<void>;
}

/** 把缓存里的任意字符串收敛回合法 AccountPlan（脏值/缺失 → unconfigured）。 */
function normalizeCachedPlan(raw: string | null): AccountPlan {
  return raw === 'enterprise' || raw === 'companion' ? raw : 'unconfigured';
}

/** best-effort 写缓存：写失败不影响 plan 结果（缓存只是优化，不是真相来源）。 */
async function writeCacheBestEffort(deps: AccountPlanDeps, plan: AccountPlan): Promise<void> {
  try {
    await deps.writeCachedPlan(plan);
  } catch {
    /* 忽略：缓存写失败下次再写即可，不能让它破坏「不抛」契约。 */
  }
}

/** best-effort 读缓存：读失败按「无缓存」处理（→ unconfigured），不抛。 */
async function readCacheBestEffort(deps: AccountPlanDeps): Promise<string | null> {
  try {
    return await deps.readCachedPlan();
  } catch {
    return null;
  }
}

/**
 * 解析账号 plan。
 *
 * 判定顺序：
 *   1. 未配置 API → `unconfigured`（引导去 Settings 配；不写缓存——「没配」不是一个可缓存的账号事实）。
 *   2. 探测成功：200 → `companion`（个人版放行）；403 → `enterprise`（companion 拒绝 enterprise）。
 *      两者都写入缓存。其余 2xx/4xx 视为「能连上但语义未知」，**不覆盖**已有缓存，回退缓存值。
 *   3. 探测失败（status=0，网络/服务端不可达）→ 回退本地缓存（离线续用上次结论）。
 */
export async function resolveAccountPlanWith(deps: AccountPlanDeps): Promise<AccountPlan> {
  /* probe 也兜底：约定的 runtime probe 已自吞网络异常，但任何注入实现抛出时也不破坏「不抛」契约
   * ——视作连不上（status=0），回退缓存。 */
  let result: PlanProbeResult;
  try {
    result = await deps.probe();
  } catch {
    result = { unconfigured: false, status: 0 };
  }
  if (result.unconfigured) return 'unconfigured';

  if (result.status === 200) {
    await writeCacheBestEffort(deps, 'companion');
    return 'companion';
  }
  if (result.status === 403) {
    await writeCacheBestEffort(deps, 'enterprise');
    return 'enterprise';
  }
  /* 能连上但状态码不是明确的 200/403（如 401 token 过期、5xx），或彻底连不上（status=0）：
   * 不臆断 plan，回退上次缓存的可信结论；无缓存则 unconfigured（让 UI 引导重新配置/登录）。 */
  return normalizeCachedPlan(await readCacheBestEffort(deps));
}
