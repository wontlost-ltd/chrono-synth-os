/**
 * GitHub 反馈起草段的 Query/Command kind 契约（GitHub 集成 Plan 3）。
 *
 * kernel 只声明数据形状与 { kind, params } 描述符；SQL 执行器在 src/storage/executors
 * （与 github-learn-types.ts / github-app-types.ts / llm-credential-queries.ts 同架构）。
 *
 * 两个存储对象（Task 1 迁移 v121 / Postgres v123 已建）：
 *   - github_reply_drafts：回复草稿账本。数字人对某条 issue/pull 起草的回复正文，落到 drafted 态
 *     待人工审批（红线：起草即停，绝不自动发布）。target_type 迁移 CHECK 钉死 issue / pull；
 *     target_number 是 issue/PR 编号；status 走 drafted → approved / rejected 三态（CHECK 钉死取值）。
 *     githubDraftInsert 建行时 status 由执行器钉死 drafted（不入参——起草即停铁律）；
 *     githubDraftQueryById 按 (tenant, persona, id) 三键反查单行（0/1）；
 *     githubDraftListByPersona 按 (tenant, persona) 列多行，status 可选过滤，对应索引
 *     idx_github_reply_drafts_lookup (tenant_id, persona_id, status)；
 *     githubDraftUpdateStatus 推进状态（drafted → approved / rejected），执行器 WHERE status='drafted'
 *     保护（仅 drafted 可改，approved/rejected 终态不可逆）。tenant_id + persona_id 标识
 *     「哪个租户的哪个人格」起草了这条草稿。
 *   - github_webhook_events：webhook 幂等账本。独立于 Stripe 的 webhook_events 表（各领域各自幂等），
 *     以 delivery_id 为 GitHub 投递指纹记录某条 webhook 是否已处理，防重复投递触发重复动作。
 *     githubWebhookEventClaim 是**原子 claim**（执行器用 INSERT ON CONFLICT (tenant_id, delivery_id)
 *     DO NOTHING 抢占幂等窗口——故 kind 与普通 insert 区分，语义是「首个 claim 者独占，重复 claim
 *     无副作用」）。复合主键 (tenant_id, delivery_id) 而非单 delivery_id——GitHub 的 X-GitHub-Delivery
 *     在不同租户的 App 间不保证全局唯一，复合主键防跨租户 delivery id 相撞。
 *
 * 两表均含 tenant_id，纳入 TenantDatabase 自动隔离集与 GDPR 导出/擦除清单（随 Task 1 同片登记）。
 * 时间戳列语义为毫秒 epoch（Postgres BIGINT / SQLite INTEGER，均 64 位整数）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const GITHUB_REPLY_DRAFT_CMD_INSERT = 'githubReplyDraft.insert' as const;
export const GITHUB_REPLY_DRAFT_QUERY_BY_ID = 'githubReplyDraft.byId' as const;
export const GITHUB_REPLY_DRAFT_QUERY_BY_PERSONA = 'githubReplyDraft.byPersona' as const;
export const GITHUB_REPLY_DRAFT_CMD_UPDATE_STATUS = 'githubReplyDraft.updateStatus' as const;
export const GITHUB_REPLY_DRAFT_CMD_CLAIM_FOR_PUBLISH = 'githubReplyDraft.claimForPublish' as const;
export const GITHUB_REPLY_DRAFT_CMD_MARK_PUBLISHED = 'githubReplyDraft.markPublished' as const;

export const GITHUB_WEBHOOK_EVENT_CMD_CLAIM = 'githubWebhookEvent.claim' as const;

/* ── Row（对齐 DB 列，snake_case） ── */

export interface GithubReplyDraftRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly repo: string;
  /** 回复目标类型：issue / pull（迁移 CHECK 钉死取值）。 */
  readonly target_type: string;
  /** issue / PR 编号。 */
  readonly target_number: number;
  /** 起草的回复正文。 */
  readonly draft_body: string;
  /** 审批状态：drafted（起草待审）→ approved（人工批准）/ rejected（人工驳回）→ published（发布成功终态）（迁移 CHECK 钉死取值）。 */
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
  /** 发布时间戳（毫秒 epoch）；未发布的草稿为 NULL（Plan 4 Task 1 迁移 v122 加）。 */
  readonly published_at: number | null;
  /** 发布后 GitHub 侧 comment/review id（审计佐证 + 去重佐证）；未发布为 NULL（Plan 4 Task 1 迁移 v122 加）。 */
  readonly github_ref: string | null;
}

export interface GithubWebhookEventRow {
  readonly delivery_id: string;
  readonly tenant_id: string;
  /** webhook 事件类型（如 issue_comment / pull_request）。 */
  readonly event_type: string;
  /** 处理时间（毫秒 epoch）。 */
  readonly processed_at: number;
}

/* ── Params ── */

/** 草稿三键 (tenant, persona, id)——租户 + 人格隔离下唯一定位一条草稿行。 */
export interface GithubReplyDraftKeyParams {
  tenantId: string;
  personaId: string;
  id: string;
}

export interface GithubDraftInsertParams {
  tenantId: string;
  personaId: string;
  repo: string;
  /** 回复目标类型：issue / pull。 */
  targetType: string;
  /** issue / PR 编号。 */
  targetNumber: number;
  /** 起草的回复正文。 */
  draftBody: string;
  now: number;
  /**
   * 草稿主键。可选——调用方（store）显式生成并传入以便建后即知 id 供返回（ExecResult 只回 rowsAffected，
   * 不回自生成 id）；省略时由执行器自生成（randomUUID）。故省略此项时 params 恰为七键（Task 2 契约）。
   */
  id?: string;
  /* status 不入参——首插由执行器钉死 drafted（起草即停铁律）。 */
}

export interface GithubDraftListByPersonaParams {
  tenantId: string;
  personaId: string;
  /** 可选 status 过滤（对应 lookup 索引第三列）；省略则列该人格全部草稿。 */
  status?: string;
}

export interface GithubDraftUpdateStatusParams extends GithubReplyDraftKeyParams {
  /** 目标状态：approved / rejected（执行器 WHERE status='drafted' 保护，仅 drafted 可改）。 */
  status: string;
  now: number;
}

/** claimForPublish 三键定位 + 占位时间戳（回填 published_at）。 */
export interface GithubDraftClaimForPublishParams extends GithubReplyDraftKeyParams {
  /** 占位时间戳（毫秒 epoch），落 published_at + updated_at。 */
  now: number;
}

/** markPublished 三键定位 + 回填 GitHub 侧引用。 */
export interface GithubDraftMarkPublishedParams extends GithubReplyDraftKeyParams {
  /** 发布后 GitHub 侧 comment/review id。 */
  githubRef: string;
  /** 回填时间戳（毫秒 epoch），落 updated_at。 */
  now: number;
}

export interface GithubWebhookEventClaimParams {
  tenantId: string;
  /** GitHub 投递指纹（X-GitHub-Delivery）。 */
  deliveryId: string;
  /** webhook 事件类型。 */
  eventType: string;
  now: number;
}

/* ── 草稿账本工厂 ── */

/**
 * 插入草稿：建一条 drafted 态回复草稿。执行器把 status 钉死为 drafted（不入参——起草即停铁律），
 * created_at / updated_at 均取 now。
 */
export function githubDraftInsert(params: GithubDraftInsertParams): Command<GithubDraftInsertParams> {
  return { kind: GITHUB_REPLY_DRAFT_CMD_INSERT, params };
}

/**
 * 按三键 (tenant, persona, id) 取草稿行。租户 + 人格隔离，防跨租户/跨人格读他人草稿，返回 0/1 行。
 */
export function githubDraftQueryById(params: GithubReplyDraftKeyParams): Query<GithubReplyDraftRow | null, GithubReplyDraftKeyParams> {
  return { kind: GITHUB_REPLY_DRAFT_QUERY_BY_ID, params };
}

/**
 * 按 (tenant, persona) 列多行草稿；status 可选过滤（对应 idx_github_reply_drafts_lookup
 * (tenant_id, persona_id, status)）。省略 status 则列该人格全部草稿。
 */
export function githubDraftListByPersona(params: GithubDraftListByPersonaParams): Query<GithubReplyDraftRow, GithubDraftListByPersonaParams> {
  return { kind: GITHUB_REPLY_DRAFT_QUERY_BY_PERSONA, params };
}

/**
 * 推进草稿状态：drafted → approved / rejected，并更新 updated_at。执行器 WHERE status='drafted'
 * 保护——仅 drafted 可改（approved/rejected 终态不可逆，重复推进 rowsAffected=0）。
 */
export function githubDraftUpdateStatus(params: GithubDraftUpdateStatusParams): Command<GithubDraftUpdateStatusParams> {
  return { kind: GITHUB_REPLY_DRAFT_CMD_UPDATE_STATUS, params };
}

/**
 * 原子 CAS 占位发布：approved → published（发布成功终态）。执行器
 * **UPDATE ... SET status='published', published_at=now WHERE ... AND status='approved'**——
 * `WHERE status='approved'` 是原子占位关键：只有 approved 能被 claim 成 published，且 UPDATE 是
 * 原子的，同一草稿并发/重复调用只有一次 rowsAffected=1，之后都是 0（已 published）。**先 UPDATE
 * 占位再读回**（非先 SELECT 再 UPDATE 的 check-then-act）——防重复发布靠这个 CAS。三键定位
 * (tenant, persona, id)——防跨租户/跨人格抢发他人草稿。store 层据受影响行数判返行 / undefined。
 */
export function githubDraftClaimForPublish(params: GithubDraftClaimForPublishParams): Command<GithubDraftClaimForPublishParams> {
  return { kind: GITHUB_REPLY_DRAFT_CMD_CLAIM_FOR_PUBLISH, params };
}

/**
 * 发布成功后回填 github_ref（GitHub 侧 comment/review id，审计+去重佐证），并更新 updated_at。
 * 三键定位 (tenant, persona, id)——防跨租户/跨人格回填他人草稿。不校验 status（claimForPublish 已
 * 原子占位为 published，本步只补 ref）。
 */
export function githubDraftMarkPublished(params: GithubDraftMarkPublishedParams): Command<GithubDraftMarkPublishedParams> {
  return { kind: GITHUB_REPLY_DRAFT_CMD_MARK_PUBLISHED, params };
}

/* ── webhook 幂等账本工厂 ── */

/**
 * 原子 claim：占位 webhook 幂等窗口。执行器用 INSERT ... ON CONFLICT (tenant_id, delivery_id)
 * DO NOTHING——首个 claim 者独占（rowsAffected=1），重复投递无副作用（rowsAffected=0，供调用方
 * 判定已处理过）。故 kind 与普通 insert 区分：claim 语义是「抢占幂等窗口」而非「无条件建行」。
 */
export function githubWebhookEventClaim(params: GithubWebhookEventClaimParams): Command<GithubWebhookEventClaimParams> {
  return { kind: GITHUB_WEBHOOK_EVENT_CMD_CLAIM, params };
}
