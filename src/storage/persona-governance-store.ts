/**
 * per-persona 治理策略 store + 有效策略解析（ADR-0048 治理可配化）。
 *
 * 把已建好但「默认关/默认宽松」的治理能力（categoryRoutes / AML 阈值 / 不确定性预算 / reward 上限 等）
 * 做成**每 persona 可配**——owner 经 API / 管理控制台覆盖默认。
 *
 *   - PersonaGovernanceStore：读写某 persona 的策略覆盖（policy_json，非 secret 配置）。
 *   - resolvePersonaEarningPolicy：把 DEFAULT_EARNING_POLICY 与该 persona 的覆盖 merge 成「有效策略」。
 *     无 row → 完全回退 DEFAULT（行为不变 = 向后兼容）。
 *
 * 安全：upsert 前用 sanitizeGovernanceOverride **白名单校验**——只接受已知可覆盖字段、且每字段类型/范围
 * 合法（防落库脏 JSON 导致 resolve 出无法路由的策略）。未知字段直接丢弃，非法值抛错。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  personaGovernanceQueryByPersona,
  personaGovernanceCmdUpsert,
  personaGovernanceCmdDelete,
  DEFAULT_EARNING_POLICY,
  type EarningPolicyConfig,
  type AmlAggregatePolicy,
  type CategoryRouteMode,
  type MarketplaceTaskCategory,
  type PersonaGovernanceRow,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';

/** 合法 category（与 MarketplaceTaskCategory 对齐）。 */
const VALID_CATEGORIES: ReadonlySet<string> = new Set(['writing', 'coding', 'research', 'operations', 'general']);
/** 合法 category 路由模式。 */
const VALID_ROUTE_MODES: ReadonlySet<string> = new Set(['autonomous', 'human_review', 'blocked']);

/**
 * 治理策略可覆盖子集（owner 能配的字段）。全部可选——只覆盖给出的，其余沿用 DEFAULT。
 * 刻意**不暴露** allowedCategories（被 categoryRoutes 取代）与 minReputationForAutonomy 等内部项，
 * 聚焦 owner 真正该调的治理旋钮。
 */
export interface PersonaGovernanceOverride {
  readonly categoryRoutes?: Partial<Record<MarketplaceTaskCategory, CategoryRouteMode>>;
  readonly defaultCategoryRoute?: CategoryRouteMode;
  readonly maxAutonomousReward?: number;
  readonly dailyRewardExposureCap?: number;
  readonly maxConcurrentTasks?: number;
  readonly aml?: Partial<AmlAggregatePolicy>;
  /* 注：不确定性预算（unverifiedGrowthBudgetPerWindow）属 DistillationPolicy 而非 EarningPolicyConfig，
   * mergeEarningPolicy 不消费它。per-persona 预算的 distillation 侧解析接线是后续（与 ① 预算性能债一起做）；
   * 此处暂不纳入覆盖面，避免存一个对 earning 无效的字段（Codex 复审 Medium）。 */
}

export class PersonaGovernanceStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /** 取某 persona 的策略覆盖 row；无则 undefined（调用方回退 DEFAULT）。 */
  getRow(personaId: string): PersonaGovernanceRow | undefined {
    return this.tx.queryOne(personaGovernanceQueryByPersona({ tenantId: this.tenantId, personaId })) ?? undefined;
  }

  /** 取某 persona 的解析后覆盖对象（已 sanitize；无 row → undefined）。 */
  getOverride(personaId: string): PersonaGovernanceOverride | undefined {
    const row = this.getRow(personaId);
    if (!row) return undefined;
    return sanitizeGovernanceOverride(safeParseJson(row.policy_json));
  }

  /**
   * 设置某 persona 的策略覆盖。先 sanitize（白名单 + 类型/范围校验，非法抛错），再落库**规范化后的
   * JSON**（不存用户原始 JSON——杜绝未知字段/脏值进库）。
   */
  upsert(personaId: string, override: unknown, updatedBy: string | null, now: number): void {
    const clean = sanitizeGovernanceOverride(override);
    this.tx.execute(personaGovernanceCmdUpsert({
      tenantId: this.tenantId,
      personaId,
      policyJson: JSON.stringify(clean),
      updatedBy,
      now,
    }));
  }

  /** 删除某 persona 策略覆盖（恢复默认 / GDPR 擦除）。 */
  delete(personaId: string): void {
    this.tx.execute(personaGovernanceCmdDelete({ tenantId: this.tenantId, personaId }));
  }
}

/**
 * 解析某 persona 构造 earning 时该用的有效策略（DEFAULT_EARNING_POLICY ∪ persona 覆盖）。
 * 无覆盖 → 完全回退 DEFAULT（向后兼容）。
 */
export function resolvePersonaEarningPolicy(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  personaId: string,
): EarningPolicyConfig {
  const override = new PersonaGovernanceStore(tx, tenantId).getOverride(personaId);
  if (!override) return DEFAULT_EARNING_POLICY;
  return mergeEarningPolicy(DEFAULT_EARNING_POLICY, override);
}

/** 把覆盖 merge over base（仅覆盖给出的字段；aml 深合并；其余浅合并）。纯函数。 */
export function mergeEarningPolicy(base: EarningPolicyConfig, override: PersonaGovernanceOverride): EarningPolicyConfig {
  return {
    ...base,
    ...(override.categoryRoutes !== undefined ? { categoryRoutes: override.categoryRoutes } : {}),
    ...(override.defaultCategoryRoute !== undefined ? { defaultCategoryRoute: override.defaultCategoryRoute } : {}),
    ...(override.maxAutonomousReward !== undefined ? { maxAutonomousReward: override.maxAutonomousReward } : {}),
    ...(override.dailyRewardExposureCap !== undefined ? { dailyRewardExposureCap: override.dailyRewardExposureCap } : {}),
    ...(override.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: override.maxConcurrentTasks } : {}),
    aml: override.aml ? { ...base.aml, ...override.aml } : base.aml,
  };
}

/**
 * 白名单 sanitize：只接受已知可覆盖字段、每字段类型/范围合法。未知字段丢弃；非法值抛错
 * （宁可拒写，不落脏策略）。返回规范化后的覆盖对象。
 */
export function sanitizeGovernanceOverride(input: unknown): PersonaGovernanceOverride {
  if (input === null || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  const out: Mutable<PersonaGovernanceOverride> = {};

  if (o.categoryRoutes !== undefined) {
    out.categoryRoutes = sanitizeCategoryRoutes(o.categoryRoutes);
  }
  if (o.defaultCategoryRoute !== undefined) {
    out.defaultCategoryRoute = requireRouteMode(o.defaultCategoryRoute, 'defaultCategoryRoute');
  }
  if (o.maxAutonomousReward !== undefined) {
    out.maxAutonomousReward = requireNonNegativeNumber(o.maxAutonomousReward, 'maxAutonomousReward');
  }
  if (o.dailyRewardExposureCap !== undefined) {
    out.dailyRewardExposureCap = requireNonNegativeNumber(o.dailyRewardExposureCap, 'dailyRewardExposureCap');
  }
  if (o.maxConcurrentTasks !== undefined) {
    out.maxConcurrentTasks = requirePositiveInt(o.maxConcurrentTasks, 'maxConcurrentTasks');
  }
  if (o.aml !== undefined) {
    out.aml = sanitizeAml(o.aml);
  }
  return out;
}

function sanitizeCategoryRoutes(input: unknown): Partial<Record<MarketplaceTaskCategory, CategoryRouteMode>> {
  if (input === null || typeof input !== 'object') {
    throw new Error('categoryRoutes 必须是对象');
  }
  const out: Partial<Record<MarketplaceTaskCategory, CategoryRouteMode>> = {};
  for (const [cat, mode] of Object.entries(input as Record<string, unknown>)) {
    if (!VALID_CATEGORIES.has(cat)) throw new Error(`非法 category: ${cat}`);
    out[cat as MarketplaceTaskCategory] = requireRouteMode(mode, `categoryRoutes.${cat}`);
  }
  return out;
}

function sanitizeAml(input: unknown): Partial<AmlAggregatePolicy> {
  if (input === null || typeof input !== 'object') throw new Error('aml 必须是对象');
  const a = input as Record<string, unknown>;
  const out: Mutable<Partial<AmlAggregatePolicy>> = {};
  if (a.maxTasksPerPublisherPerWindow !== undefined) out.maxTasksPerPublisherPerWindow = requirePositiveInt(a.maxTasksPerPublisherPerWindow, 'aml.maxTasksPerPublisherPerWindow');
  if (a.maxPublisherRewardShare !== undefined) out.maxPublisherRewardShare = requireUnitInterval(a.maxPublisherRewardShare, 'aml.maxPublisherRewardShare');
  if (a.concentrationMinTasks !== undefined) out.concentrationMinTasks = requirePositiveInt(a.concentrationMinTasks, 'aml.concentrationMinTasks');
  if (a.maxIdenticalRewardRepeats !== undefined) out.maxIdenticalRewardRepeats = requirePositiveInt(a.maxIdenticalRewardRepeats, 'aml.maxIdenticalRewardRepeats');
  return out;
}

function requireRouteMode(v: unknown, field: string): CategoryRouteMode {
  if (typeof v !== 'string' || !VALID_ROUTE_MODES.has(v)) {
    throw new Error(`${field} 必须是 autonomous/human_review/blocked 之一`);
  }
  return v as CategoryRouteMode;
}

function requireNonNegativeNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${field} 必须是非负有限数`);
  return v;
}

function requirePositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${field} 必须是正整数`);
  return v;
}

function requireUnitInterval(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${field} 必须在 [0,1]`);
  return v;
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
