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
  personaGovernanceCmdUpdateIfVersion,
  personaGovernanceCmdDelete,
  DEFAULT_EARNING_POLICY,
  type EarningPolicyConfig,
  type AmlAggregatePolicy,
  type CategoryRouteMode,
  type MarketplaceTaskCategory,
  type PersonaGovernanceRow,
  type ToolScope,
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
  /**
   * 不确定性预算（窗口内 auto-compile 上限）。属 DistillationPolicy 而非 EarningPolicyConfig——
   * mergeEarningPolicy 不消费它；由 distillation 侧 budgetResolver 单独取用（resolvePersonaUnverifiedGrowthBudget）。
   * 允许 0（= 完全禁止自动吸收未验证成长，全部转人工审批）。
   */
  readonly unverifiedGrowthBudgetPerWindow?: number;
  /**
   * ADR-0060 T5 工具自动授权白名单（红线 13：「低风险」由**治理白名单**维护，非 tool.metadata.highRisk 自证）。
   * key=toolId；出现在白名单 = 治理显式批准该工具可被自动授权。value 是自动授权时写入的策略：
   *   - scope：授予的权限范围（read/write/any）；
   *   - maxExpiryMs：自动授予权限的**强制**有效期上限（红线：T5 自动授权 expiresAt 必须非空，防漂移成永久授权）；
   *   - requireConfirmation：授予的 constraints 是否强制二次确认（默认 true——自动授权更保守）。
   * 不在白名单 / 高风险的 eligibility 建议 → 不自动授权，只自动创建待审批请求（红线 3）。
   */
  readonly toolAutoAuthWhitelist?: Record<string, ToolAutoAuthPolicy>;
}

/** T5 工具自动授权白名单条目（治理维护）。 */
export interface ToolAutoAuthPolicy {
  readonly scope: ToolScope;
  /** 自动授予权限有效期上限 ms（必须 >0；红线：自动授权禁永久）。 */
  readonly maxExpiryMs: number;
  /** 授予 constraints 是否强制二次确认（默认 true）。 */
  readonly requireConfirmation?: boolean;
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
   *
   * 乐观并发（可选）：给定 expectedUpdatedAt 时做 compare-and-set——仅当当前 row 的 updated_at 与之
   * 匹配（或无 row 且 expected=undefined 视为新建）才写。版本不符返回 false（调用方转 409 冲突），
   * 防止两个 owner 并发编辑时后写盲覆盖前写。不给 expectedUpdatedAt = 不做版本检查（last-write-wins）。
   * updated_at 即版本令牌——每次写都变，无需额外 version 列。
   */
  upsert(personaId: string, override: unknown, updatedBy: string | null, now: number, expectedUpdatedAt?: number): boolean {
    const clean = sanitizeGovernanceOverride(override);
    const policyJson = JSON.stringify(clean);
    /* updated_at 即版本令牌——必须**严格单调递增**（即使同毫秒连写 / 时钟回拨）才能可靠做乐观锁。
     * nextVersion = max(now, 当前版本+1)：若 now ≤ 当前版本则强制 +1，保证每次写版本都变。 */
    const currentVersion = this.getRow(personaId)?.updated_at;
    const nextVersion = currentVersion !== undefined && now <= currentVersion ? currentVersion + 1 : now;

    if (expectedUpdatedAt !== undefined) {
      /* DB 级原子 CAS（消除 read-then-write TOCTOU，Codex 复审）：WHERE updated_at=expected。
       * rowsAffected=0 → 版本不符或行不存在 → 冲突（返回 false，调用方转 409）。 */
      const result = this.tx.execute(personaGovernanceCmdUpdateIfVersion({
        tenantId: this.tenantId,
        personaId,
        policyJson,
        updatedBy,
        now: nextVersion,
        expectedUpdatedAt,
      }));
      return result.rowsAffected > 0;
    }

    /* 无版本检查：last-write-wins upsert（向后兼容，无并发场景）。 */
    this.tx.execute(personaGovernanceCmdUpsert({
      tenantId: this.tenantId,
      personaId,
      policyJson,
      updatedBy,
      now: nextVersion,
    }));
    return true;
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

/**
 * 解析某 persona 的不确定性预算覆盖（distillation 侧 budgetResolver 用）。
 * 返回 owner 设的 per-persona 预算上限；无覆盖 → undefined（调用方回退全局 DistillationPolicy 预算）。
 * 与 earning policy 分开解析——预算属 DistillationPolicy，不进 mergeEarningPolicy。
 */
export function resolvePersonaUnverifiedGrowthBudget(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  personaId: string,
): number | undefined {
  return new PersonaGovernanceStore(tx, tenantId).getOverride(personaId)?.unverifiedGrowthBudgetPerWindow;
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
  if (o.unverifiedGrowthBudgetPerWindow !== undefined) {
    /* 允许 0（完全禁止自动吸收）；非负整数。 */
    out.unverifiedGrowthBudgetPerWindow = requireNonNegativeInt(o.unverifiedGrowthBudgetPerWindow, 'unverifiedGrowthBudgetPerWindow');
  }
  if (o.toolAutoAuthWhitelist !== undefined) {
    out.toolAutoAuthWhitelist = sanitizeToolAutoAuthWhitelist(o.toolAutoAuthWhitelist);
  }
  return out;
}

const VALID_TOOL_SCOPES: ReadonlySet<string> = new Set(['read', 'write', 'any']);

/** 原型污染键：授权白名单是安全敏感面，显式拒绝（防 __proto__/constructor/prototype 作为 toolId 键）。 */
const PROTO_POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * sanitize T5 工具自动授权白名单：每条须合法 scope + 正数 maxExpiryMs；非法抛错（宁拒写不落脏授权策略）。
 * 授权层从严（Codex T5 复审补）：输出用 null-prototype map，拒绝原型污染键，policy 用 own-property 校验且拒数组。
 */
function sanitizeToolAutoAuthWhitelist(input: unknown): Record<string, ToolAutoAuthPolicy> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('toolAutoAuthWhitelist 必须是对象（toolId → 策略）');
  }
  const out: Record<string, ToolAutoAuthPolicy> = Object.create(null);
  for (const [toolId, raw] of Object.entries(input as Record<string, unknown>)) {
    if (toolId.length === 0) throw new Error('toolAutoAuthWhitelist toolId 不得为空');
    if (PROTO_POLLUTION_KEYS.has(toolId)) throw new Error(`toolAutoAuthWhitelist toolId 不得为原型污染键「${toolId}」`);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`toolAutoAuthWhitelist「${toolId}」策略必须是对象`);
    const p = raw as Record<string, unknown>;
    const scope = Object.hasOwn(p, 'scope') ? p.scope : undefined;
    const maxExpiryMs = Object.hasOwn(p, 'maxExpiryMs') ? p.maxExpiryMs : undefined;
    if (typeof scope !== 'string' || !VALID_TOOL_SCOPES.has(scope)) {
      throw new Error(`toolAutoAuthWhitelist「${toolId}」scope 必须为 read/write/any`);
    }
    if (typeof maxExpiryMs !== 'number' || !Number.isFinite(maxExpiryMs) || maxExpiryMs <= 0) {
      throw new Error(`toolAutoAuthWhitelist「${toolId}」maxExpiryMs 必须为正数（红线：自动授权禁永久）`);
    }
    const requireConfirmation = Object.hasOwn(p, 'requireConfirmation') ? p.requireConfirmation : undefined;
    const policy: ToolAutoAuthPolicy = {
      scope: scope as ToolScope,
      maxExpiryMs,
      ...(requireConfirmation !== undefined ? { requireConfirmation: requireConfirmation === true } : {}),
    };
    out[toolId] = policy;
  }
  return out;
}

/**
 * 解析某 persona 的工具自动授权白名单（T5 桥消费）。返回 owner/治理设的白名单；无覆盖 → 空对象
 * （= 无任何工具可自动授权，安全默认——不在白名单一律走待审批）。
 */
export function resolvePersonaToolAutoAuthWhitelist(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  personaId: string,
): Record<string, ToolAutoAuthPolicy> {
  return new PersonaGovernanceStore(tx, tenantId).getOverride(personaId)?.toolAutoAuthWhitelist ?? {};
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

function requireNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${field} 必须是非负整数`);
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
