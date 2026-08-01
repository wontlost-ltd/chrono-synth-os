/**
 * GitHub 学习段的 Query/Command kind 契约（GitHub 集成 Plan 2）。
 *
 * kernel 只声明数据形状与 { kind, params } 描述符；SQL 执行器在 src/storage/executors
 * （与 github-app-types.ts / llm-credential-queries.ts 同架构）。
 *
 * 两个存储对象（Task 1 迁移 v120 已建）：
 *   - github_learn_state：增量同步游标账本。per (tenant, persona, repo, resource_type) 一条游标行，
 *     UNIQUE(tenant_id, persona_id, repo, resource_type) 保证唯一。githubLearnStateQuery 按这四键
 *     定位（0/1 行）；githubLearnStateUpsertCursor 在四键上 upsert 游标 + 推进/同步时间戳。
 *     cursor / cursor_advanced_at / last_synced_at 均可空（首次同步前无游标、尚未推进/同步）。
 *   - github_ingest_digests：摄入幂等账本。以 content_sha 为内容指纹，status 走 claimed → ingested
 *     两态。githubDigestClaim 是**原子 claim**（执行器用 INSERT ON CONFLICT DO NOTHING 抢占幂等
 *     窗口——故 kind 与普通 upsert 区分，语义是「首个 claim 者独占，重复 claim 无副作用」）；
 *     githubDigestMarkIngested 把 status 置 ingested；githubDigestQuery 按五键
 *     (tenant, persona, repo, resource_type, content_sha) 反查单行（测试 / reclaim 用）。
 *     UNIQUE(tenant_id, persona_id, repo, resource_type, content_sha) 是幂等主键。
 *
 * 两表均含 tenant_id，纳入 TenantDatabase 自动隔离集与 GDPR 导出/擦除清单（随 Task 1 同片登记）。
 * 时间戳列语义为毫秒 epoch（Postgres BIGINT / SQLite INTEGER，均 64 位整数）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const GITHUB_LEARN_STATE_QUERY = 'githubLearnState.byKey' as const;
export const GITHUB_LEARN_STATE_CMD_UPSERT_CURSOR = 'githubLearnState.upsertCursor' as const;

export const GITHUB_INGEST_DIGEST_QUERY = 'githubIngestDigest.byKey' as const;
export const GITHUB_INGEST_DIGEST_CMD_CLAIM = 'githubIngestDigest.claim' as const;
export const GITHUB_INGEST_DIGEST_CMD_MARK_INGESTED = 'githubIngestDigest.markIngested' as const;
/** 按讨论键反查摘要行（演进式取代：定位同一 issue/PR 的上一版记忆）。 */
export const GITHUB_INGEST_DIGEST_QUERY_BY_DISCUSSION = 'githubIngestDigest.byDiscussion' as const;
/** 回写摘要行对应的记忆 ID（perceive 产出记忆后记录，供下一轮取代用）。 */
export const GITHUB_INGEST_DIGEST_CMD_SET_MEMORY_ID = 'githubIngestDigest.setMemoryId' as const;

/* ── Row（对齐 DB 列，snake_case） ── */

export interface GithubLearnStateRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly repo: string;
  /** 可学资源类型：code / issues / pulls / commits（迁移 CHECK 钉死取值）。 */
  readonly resource_type: string;
  /** 增量同步游标；null = 首次同步前无游标。 */
  readonly cursor: string | null;
  /** 游标最近一次推进时间（毫秒 epoch）；null = 尚未推进。 */
  readonly cursor_advanced_at: number | null;
  /** 最近一次同步完成时间（毫秒 epoch）；null = 尚未同步。 */
  readonly last_synced_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface GithubIngestDigestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly repo: string;
  readonly resource_type: string;
  /** 内容指纹（幂等键的一部分）。 */
  readonly content_sha: string;
  /** 摄入状态：claimed（已占位）→ ingested（已摄入）（迁移 CHECK 钉死取值）。 */
  readonly status: string;
  /** claim 占位时间（毫秒 epoch）；null = 未占位。 */
  readonly claimed_at: number | null;
  /** 摄入完成时间（毫秒 epoch）；null = 尚未完成摄入。 */
  readonly ingested_at: number | null;
  /** 讨论稳定标识（issues:owner/repo#42）；null = code/commits 等无讨论概念的资源。 */
  readonly discussion_key: string | null;
  /** 该讨论当前对应的记忆 ID；null = 尚未回写（仅占位未摄入完成）。 */
  readonly memory_id: string | null;
}

/* ── Params ── */

/** 游标行四键（tenant, persona, repo, resource_type）——唯一定位一条游标行。 */
export interface GithubLearnStateKeyParams {
  tenantId: string;
  personaId: string;
  repo: string;
  resourceType: string;
}

export interface GithubLearnStateUpsertCursorParams extends GithubLearnStateKeyParams {
  /** 增量同步游标；null = 首次同步前无游标。 */
  cursor: string | null;
  /** 游标推进时间（毫秒 epoch）；null = 尚未推进。 */
  cursorAdvancedAt: number | null;
  /** 同步完成时间（毫秒 epoch）；null = 尚未同步。 */
  lastSyncedAt: number | null;
  now: number;
}

/** 摘要五键（四键 + content_sha 指纹）——幂等主键的参数化等价物。 */
export interface GithubIngestDigestKeyParams extends GithubLearnStateKeyParams {
  contentSha: string;
}

export interface GithubDigestClaimParams extends GithubIngestDigestKeyParams {
  now: number;
  /**
   * 讨论稳定标识（issues:owner/repo#42）。跨轮次恒定、与 contentSha 无关——
   * 讨论新增评论使 contentSha 变化，靠此键才能定位「同一 issue 的上一版记忆」。
   * code / commits 无讨论概念时省略。
   */
  discussionKey?: string;
}

export interface GithubDigestMarkIngestedParams extends GithubIngestDigestKeyParams {
  now: number;
}

/** 按讨论键定位（tenant, persona, discussion_key）——取代路径反查上一版记忆指针。 */
export interface GithubDigestByDiscussionKeyParams {
  tenantId: string;
  personaId: string;
  discussionKey: string;
}

export interface GithubDigestSetMemoryIdParams extends GithubIngestDigestKeyParams {
  /** perceive 产出的新记忆 ID。 */
  memoryId: string;
  now: number;
}

/* ── 游标账本工厂 ── */

/**
 * 按四键 (tenant, persona, repo, resource_type) 取游标行。
 * 依赖 UNIQUE(tenant_id, persona_id, repo, resource_type) 唯一约束，返回 0/1 行。
 */
export function githubLearnStateQuery(params: GithubLearnStateKeyParams): Query<GithubLearnStateRow | null, GithubLearnStateKeyParams> {
  return { kind: GITHUB_LEARN_STATE_QUERY, params };
}

/**
 * upsert 游标：在四键上覆盖更新游标 + 推进/同步时间戳（执行器 INSERT ... ON CONFLICT
 * (tenant_id, persona_id, repo, resource_type) DO UPDATE）。断点续拉用。
 */
export function githubLearnStateUpsertCursor(params: GithubLearnStateUpsertCursorParams): Command<GithubLearnStateUpsertCursorParams> {
  return { kind: GITHUB_LEARN_STATE_CMD_UPSERT_CURSOR, params };
}

/* ── 幂等账本工厂 ── */

/**
 * 原子 claim：占位摄入幂等窗口。执行器用 INSERT ... ON CONFLICT
 * (tenant_id, persona_id, repo, resource_type, content_sha) DO NOTHING——首个 claim 者独占
 * （rowsAffected=1），重复 claim 无副作用（rowsAffected=0，供调用方判定已被摄入过）。
 * 故 kind 与普通 upsert 区分：claim 语义是「抢占」而非「覆盖」。
 */
export function githubDigestClaim(params: GithubDigestClaimParams): Command<GithubDigestClaimParams> {
  return { kind: GITHUB_INGEST_DIGEST_CMD_CLAIM, params };
}

/** 摄入完成：把某条摘要 status 由 claimed 置为 ingested，并记录 ingested_at。 */
export function githubDigestMarkIngested(params: GithubDigestMarkIngestedParams): Command<GithubDigestMarkIngestedParams> {
  return { kind: GITHUB_INGEST_DIGEST_CMD_MARK_INGESTED, params };
}

/**
 * 按五键 (tenant, persona, repo, resource_type, content_sha) 反查单行摘要（测试 / reclaim 用）。
 * 依赖 UNIQUE(...) 幂等主键，返回 0/1 行。
 */
export function githubDigestQuery(params: GithubIngestDigestKeyParams): Query<GithubIngestDigestRow | null, GithubIngestDigestKeyParams> {
  return { kind: GITHUB_INGEST_DIGEST_QUERY, params };
}

/**
 * 按 (tenant, persona, discussion_key) 反查该讨论**当前**的摘要行（演进式取代用）。
 *
 * 为什么不用 githubDigestQuery：那个按 content_sha 定位，而讨论新增评论会改变 content_sha——
 * 反查「同一 issue 的上一版」必须用跨轮次稳定的 discussion_key。执行器只取已回写 memory_id
 * 的行（占位未完成的行没有记忆可取代），按摄入时间取最新一条。
 */
export function githubDigestByDiscussionKeyQuery(params: GithubDigestByDiscussionKeyParams): Query<GithubIngestDigestRow | null, GithubDigestByDiscussionKeyParams> {
  return { kind: GITHUB_INGEST_DIGEST_QUERY_BY_DISCUSSION, params };
}

/** 回写摘要行的 memory_id（perceive 返回 memoryIds 后调用），供下一轮取代定位旧记忆。 */
export function githubDigestSetMemoryId(params: GithubDigestSetMemoryIdParams): Command<GithubDigestSetMemoryIdParams> {
  return { kind: GITHUB_INGEST_DIGEST_CMD_SET_MEMORY_ID, params };
}
