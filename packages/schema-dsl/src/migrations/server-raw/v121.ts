import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 反馈起草段地基（Plan 3 Task 1）——建 github_reply_drafts + github_webhook_events 两表。
 *
 * 「数字人对 GitHub issue/PR 起草回复、但停在待审批」的最底层存储，两张表分工正交：
 *   - github_reply_drafts：回复草稿账本。数字人对某条 issue/pull 起草的回复正文，落到 drafted 态
 *     待人工审批（红线：起草即停，绝不自动发布）。target_type CHECK 钉死取值（issue / pull），
 *     target_number 是 issue/PR 编号。status 走 drafted → approved / rejected 三态，CHECK 钉死取值：
 *     drafted（起草待审）、approved（人工批准，供后续投递段读取）、rejected（人工驳回）。
 *     created_at / updated_at 双时间戳，随状态推进更新 updated_at。含 tenant_id + persona_id，
 *     标识「哪个租户的哪个人格」起草了这条草稿。
 *   - github_webhook_events：webhook 幂等账本。独立于 Stripe 的 webhook_events 表（各自领域各自幂等），
 *     以 delivery_id 为 GitHub 投递指纹记录某条 webhook 是否已处理，防重复投递触发重复动作。
 *     PRIMARY KEY 复合 (tenant_id, delivery_id) 而非单 delivery_id——GitHub 的 X-GitHub-Delivery
 *     在不同租户的 App 间不保证全局唯一，复合主键防跨租户 delivery id 相撞（同一 delivery_id 落到
 *     不同租户是两条独立记录）。processed_at 记录处理时间。
 *
 * 两表均含 tenant_id，纳入 TenantDatabase 自动隔离集（TENANT_TABLES）与 GDPR 导出/擦除清单
 * （privacy-service TENANT_TABLES），随本片同片登记。
 *
 * 时间戳列：Postgres 用 BIGINT（毫秒 epoch），SQLite 无 BIGINT 用 INTEGER（同为 64 位整数语义）。
 *
 * 后续 task 依赖这两表（草稿 store / webhook 幂等入口 / 起草 service / 审批端点）。本片纯建表 DDL，
 * 无 DML，向后兼容（新表不影响任何既有表），回滚安全（DROP 两新表即可）。
 *
 * Alias：SQLite v121 / Postgres v123（紧跟 Plan 2 github-learn-state / SQLite v120 / Postgres v122）。
 */
export const v121_github_reply_drafts: RawMigration = defineRaw({
  id: 'github-reply-drafts',
  version: 'v121',
  aliases: { postgres: 'v123', 'sqlite-sql': 'v121' },
  description: 'GitHub feedback drafting foundation: github_reply_drafts (reply drafts halted at drafted for approval) + github_webhook_events (webhook idempotency, composite PK)',
  reason: '建两表：回复草稿账本（起草停 drafted 待审批；target_type CHECK issue/pull，status CHECK drafted/approved/rejected）+ webhook 幂等账本（独立于 Stripe webhook_events；复合主键 (tenant_id, delivery_id) 防跨租户 delivery id 相撞）',
  postgres: rawSql([
    `CREATE TABLE IF NOT EXISTS github_reply_drafts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('issue', 'pull')),
      target_number INTEGER NOT NULL,
      draft_body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('drafted', 'approved', 'rejected')),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_github_reply_drafts_lookup
      ON github_reply_drafts (tenant_id, persona_id, status)`,
    `CREATE TABLE IF NOT EXISTS github_webhook_events (
      delivery_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      processed_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, delivery_id)
    )`,
  ]),
  sqlite: rawSql([
    `CREATE TABLE IF NOT EXISTS github_reply_drafts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('issue', 'pull')),
      target_number INTEGER NOT NULL,
      draft_body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('drafted', 'approved', 'rejected')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_github_reply_drafts_lookup
      ON github_reply_drafts (tenant_id, persona_id, status)`,
    `CREATE TABLE IF NOT EXISTS github_webhook_events (
      delivery_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, delivery_id)
    )`,
  ]),
});
