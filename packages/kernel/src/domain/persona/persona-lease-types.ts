/**
 * PersonaLease — 数字人级分布式并发锁（ADR-0047 + ADR-0048 多实例 gating item）。
 *
 * 两个已合并 ADR 都把「多实例部署前必须有锁」列为硬约束（注意粒度不同）：
 *   - ADR-0048：earning cycle 前需获取 **per-persona** earning lease，否则两个并发
 *     cycle 会各自读到 stale 的 24h reward exposure，双双超 daily cap。
 *   - ADR-0047：DistillationService compile 前需 **租户级全局** compile mutex（用
 *     GLOBAL_LEASE_PERSONA_ID），否则全局 restoreFromSnapshot 回滚会被并发写者
 *     互相覆盖快照——per-persona 锁挡不住不同 persona 的并发编译。
 *
 * 设计（方向由 ADR-0048 指定：DB 级、compare-and-set、unique running per scope）：
 *   - 一张 persona_leases 表，UNIQUE(tenant_id, persona_id, purpose)，保证同一数字人
 *     同一用途同时只有一个持有者。
 *   - acquire 用 `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now` 的
 *     原子 CAS（复用 quota_consume 已验证的双库写法），过期锁可被抢占。
 *   - release / refresh 用 `WHERE holder_token 匹配` 的乐观并发（复用 distilled
 *     artifact 的按期望值更新写法），只能操作自己持有的锁，杜绝 A 释放 B 的锁。
 *   - 时间戳一律 epoch ms（ADR-0029）。expires_at 提供 TTL，避免持有者崩溃后死锁。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。SQL 由 src/storage 执行器实现。
 */

import type { Query, Command } from '../../ports/query.js';

/** 锁用途：earning（接单 cycle 串行化）/ compile（蒸馏编译串行化）。 */
export type PersonaLeasePurpose = 'earning' | 'compile';

export const PERSONA_LEASE_PURPOSES: readonly PersonaLeasePurpose[] = ['earning', 'compile'];

/**
 * 全局（租户级）锁的 sentinel persona_id。
 *
 * 用于「作用域是整个租户而非单个 persona」的互斥：典型是 compile——
 * DistillationService 的编译走 system-global 的 createSnapshot/restoreFromSnapshot
 * （快照覆盖 coreSelf + 全部 personas + 全部 conflicts），因此不同 persona 的并发
 * 编译必须互斥，不能各持一把 per-persona 锁。让所有 persona 的 compile 都竞争
 * (tenant, GLOBAL_LEASE_PERSONA_ID, 'compile') 这一把锁即得到租户级全局互斥。
 *
 * 形如真实 persona id 不会用的保留值（双下划线包裹），避免与真实 persona 冲突。
 */
export const GLOBAL_LEASE_PERSONA_ID = '__global__' as const;

export function isPersonaLeasePurpose(value: unknown): value is PersonaLeasePurpose {
  return value === 'earning' || value === 'compile';
}

/** 一条租约的领域视图。 */
export interface PersonaLease {
  readonly tenantId: string;
  readonly personaId: string;
  readonly purpose: PersonaLeasePurpose;
  /** 持有者随机令牌：release/refresh 必须匹配，杜绝跨持有者误操作（ABA 防护）。 */
  readonly holderToken: string;
  /** 获取时刻（epoch ms）。 */
  readonly acquiredAt: number;
  /** 过期时刻（epoch ms）；now >= expiresAt 即视为 TTL 耗尽、可被抢占（与 SQL 一致）。 */
  readonly expiresAt: number;
}

/** 获取租约的意图（CAS 输入）。 */
export interface AcquireLeaseIntent {
  readonly tenantId: string;
  readonly personaId: string;
  readonly purpose: PersonaLeasePurpose;
  readonly holderToken: string;
  /** 当前时刻（epoch ms），由调用方注入 clock.now()，与 exposure 计算同源。 */
  readonly now: number;
  /** 租约存活时长（ms）；expiresAt = now + ttlMs。必须 > 0。 */
  readonly ttlMs: number;
}

/** 释放 / 续租意图（按持有者令牌匹配）。 */
export interface LeaseOwnershipIntent {
  readonly tenantId: string;
  readonly personaId: string;
  readonly purpose: PersonaLeasePurpose;
  readonly holderToken: string;
}

export interface RefreshLeaseIntent extends LeaseOwnershipIntent {
  readonly now: number;
  readonly ttlMs: number;
}

/**
 * 校验获取意图。返回错误消息数组（空 = 合法）。unknown-safe，绝不抛。
 * 在领域层挡住非法输入，避免把脏数据写进锁表。
 */
export function validateAcquireIntent(intent: AcquireLeaseIntent): readonly string[] {
  const errors: string[] = [];
  if (!intent || typeof intent !== 'object') return ['intent 必须是对象'];
  if (typeof intent.tenantId !== 'string' || intent.tenantId.length === 0) errors.push('tenantId 必填');
  if (typeof intent.personaId !== 'string' || intent.personaId.length === 0) errors.push('personaId 必填');
  if (!isPersonaLeasePurpose(intent.purpose)) errors.push('purpose 必须是 earning | compile');
  if (typeof intent.holderToken !== 'string' || intent.holderToken.length === 0) errors.push('holderToken 必填');
  if (typeof intent.now !== 'number' || !Number.isFinite(intent.now) || intent.now < 0) errors.push('now 必须是非负有限数（epoch ms）');
  if (typeof intent.ttlMs !== 'number' || !Number.isFinite(intent.ttlMs) || intent.ttlMs <= 0) errors.push('ttlMs 必须是正有限数');
  return errors;
}

/**
 * 校验续租意图（持有者令牌 + now/ttlMs 合法性）。返回错误数组（空 = 合法）。
 * refresh 与 acquire 一样会写 expires_at，非法 now/ttlMs 会把租约写到过去/异常时间，
 * 故同样需要前置校验，绝不抛。
 */
export function validateRefreshIntent(intent: RefreshLeaseIntent): readonly string[] {
  const errors: string[] = [];
  if (!intent || typeof intent !== 'object') return ['intent 必须是对象'];
  if (typeof intent.tenantId !== 'string' || intent.tenantId.length === 0) errors.push('tenantId 必填');
  if (typeof intent.personaId !== 'string' || intent.personaId.length === 0) errors.push('personaId 必填');
  if (!isPersonaLeasePurpose(intent.purpose)) errors.push('purpose 必须是 earning | compile');
  if (typeof intent.holderToken !== 'string' || intent.holderToken.length === 0) errors.push('holderToken 必填');
  if (typeof intent.now !== 'number' || !Number.isFinite(intent.now) || intent.now < 0) errors.push('now 必须是非负有限数（epoch ms）');
  if (typeof intent.ttlMs !== 'number' || !Number.isFinite(intent.ttlMs) || intent.ttlMs <= 0) errors.push('ttlMs 必须是正有限数');
  return errors;
}

/** 计算过期时刻。集中一处，acquire/refresh 复用，避免散落的算术。 */
export function leaseExpiry(now: number, ttlMs: number): number {
  return now + ttlMs;
}

/**
 * 判断一条已存在的租约在给定时刻是否已过期（可抢占）。
 * 用 now >= expiresAt：到达 expiresAt 时刻即视为 TTL 耗尽，与 SQL acquire 的
 * `WHERE expires_at <= now` 抢占条件严格一致（边界语义不能两处分歧）。
 */
export function isLeaseExpired(lease: Pick<PersonaLease, 'expiresAt'>, now: number): boolean {
  return now >= lease.expiresAt;
}

/* ── Query / Command kind 常量 ── */

export const PERSONA_LEASE_QUERY_GET = 'personaLease.get' as const;

export const PERSONA_LEASE_CMD_ACQUIRE = 'personaLease.acquire' as const;
export const PERSONA_LEASE_CMD_RELEASE = 'personaLease.release' as const;
export const PERSONA_LEASE_CMD_REFRESH = 'personaLease.refresh' as const;

/* ── 行类型 ── */

export interface PersonaLeaseRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly purpose: string;
  readonly holder_token: string;
  readonly acquired_at: number;
  readonly expires_at: number;
}

/* ── 参数类型 ── */

export interface PersonaLeaseGetParams {
  tenantId: string;
  personaId: string;
  purpose: string;
}

export interface PersonaLeaseAcquireParams {
  tenantId: string;
  personaId: string;
  purpose: string;
  holderToken: string;
  acquiredAt: number;
  expiresAt: number;
  /** 抢占判定基准时刻（epoch ms）：仅当现有锁 expires_at <= now 才允许抢占。 */
  now: number;
}

export interface PersonaLeaseReleaseParams {
  tenantId: string;
  personaId: string;
  purpose: string;
  /** 仅释放本持有者的锁。 */
  holderToken: string;
}

export interface PersonaLeaseRefreshParams {
  tenantId: string;
  personaId: string;
  purpose: string;
  holderToken: string;
  expiresAt: number;
  /** 仅当锁仍由本持有者持有且未过期才续租。 */
  now: number;
}

/* ── Query / Command 工厂 ── */

export function personaLeaseQueryGet(params: PersonaLeaseGetParams): Query<PersonaLeaseRow | null, PersonaLeaseGetParams> {
  return { kind: PERSONA_LEASE_QUERY_GET, params };
}

export function personaLeaseCmdAcquire(params: PersonaLeaseAcquireParams): Command<PersonaLeaseAcquireParams> {
  return { kind: PERSONA_LEASE_CMD_ACQUIRE, params };
}

export function personaLeaseCmdRelease(params: PersonaLeaseReleaseParams): Command<PersonaLeaseReleaseParams> {
  return { kind: PERSONA_LEASE_CMD_RELEASE, params };
}

export function personaLeaseCmdRefresh(params: PersonaLeaseRefreshParams): Command<PersonaLeaseRefreshParams> {
  return { kind: PERSONA_LEASE_CMD_REFRESH, params };
}

/** 把数据库行转成领域视图。集中一处，store 复用。 */
export function personaLeaseFromRow(row: PersonaLeaseRow): PersonaLease {
  return {
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    purpose: row.purpose as PersonaLeasePurpose,
    holderToken: row.holder_token,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}
