/**
 * GitHub 反馈起草段 SQL 执行器（GitHub 集成 Plan 3 Task 3）——回复草稿账本 + webhook 幂等账本。
 *
 * kernel（github-draft-types.ts）只声明 { kind, params } 描述符与 Row 形状；真 SQL 在此层
 * （与 github-learn-executors.ts / github-app-executors.ts 同架构）。dispatch 一律用 kernel
 * 导出的 kind 常量，**不硬编码字面量**（Task 2 契约传承）。
 *
 * 两存储对象分工正交：
 *   - github_reply_drafts：回复草稿账本。数字人对某条 issue/pull 起草的回复正文，落 drafted 态待审批。
 *     insert 执行器**钉死 status='drafted'**（不入参——起草即停铁律），自生成 id，created_at=updated_at=now；
 *     byId / byPersona 查询 WHERE **均带 persona_id**（三键 / 二键收紧——防跨租户/跨人格读他人草稿）；
 *     updateStatus 执行器 **WHERE ... AND status='drafted'** 保护——仅 drafted 可改 approved/rejected
 *     （approved/rejected 终态不可逆，重复推进 rowsAffected=0）。
 *   - github_webhook_events：webhook 幂等账本。**claim 是原子占位**——INSERT ... ON CONFLICT
 *     (tenant_id, delivery_id) DO NOTHING，以受影响行数判定（rowsAffected=1=首个 claim 者抢到未处理过；
 *     0=重复投递）。绝非 check-then-act（先 SELECT 再 INSERT 在并发/崩溃下会重复触发动作——禁止）。
 *     复合键含 tenant_id，故不同租户同 delivery_id 各自独立 claim（不跨租户串扰）。
 *
 * ⚠️ 安全不变量（Task 2 契约）：两表均 tenant scoped——全部读写 WHERE / 键内均带 tenant_id；
 *   草稿读写额外带 persona_id（三键 (tenant, persona, id)）防跨人格读写他人草稿。
 */

import { randomUUID } from 'node:crypto';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  GithubReplyDraftRow,
  GithubReplyDraftKeyParams, GithubDraftInsertParams,
  GithubDraftListByPersonaParams, GithubDraftUpdateStatusParams,
  GithubWebhookEventClaimParams,
} from '@chrono/kernel';
import {
  GITHUB_REPLY_DRAFT_CMD_INSERT, GITHUB_REPLY_DRAFT_QUERY_BY_ID,
  GITHUB_REPLY_DRAFT_QUERY_BY_PERSONA, GITHUB_REPLY_DRAFT_CMD_UPDATE_STATUS,
  GITHUB_WEBHOOK_EVENT_CMD_CLAIM,
} from '@chrono/kernel';

export function registerGithubDraftExecutors(): void {
  /* ── 草稿账本 Command ── */

  /**
   * 插入草稿：id 取调用方传入的 p.id（store 生成以便建后即知 id 供返回），省略则自生成（randomUUID）；
   * **钉死 status='drafted'**（不入参——起草即停铁律），created_at=updated_at=now。tenant scoped，
   * 含 persona_id 标识起草人格。
   */
  registerCommand<GithubDraftInsertParams>(GITHUB_REPLY_DRAFT_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO github_reply_drafts
         (id, tenant_id, persona_id, repo, target_type, target_number, draft_body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'drafted', ?, ?)`,
    ).run(
      p.id ?? randomUUID(), p.tenantId, p.personaId, p.repo, p.targetType, p.targetNumber, p.draftBody, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  /**
   * 推进草稿状态：drafted → approved / rejected，更新 updated_at。**WHERE ... AND status='drafted'**
   * 保护——仅 drafted 可改（approved/rejected 终态不可逆，重复推进 rowsAffected=0）。三键定位
   * (tenant, persona, id)——防跨租户/跨人格改他人草稿。store 层据受影响行数判 true/false。
   */
  registerCommand<GithubDraftUpdateStatusParams>(GITHUB_REPLY_DRAFT_CMD_UPDATE_STATUS, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE github_reply_drafts
         SET status = ?, updated_at = ?
       WHERE tenant_id = ? AND persona_id = ? AND id = ? AND status = 'drafted'`,
    ).run(
      p.status, p.now, p.tenantId, p.personaId, p.id,
    );
    return { rowsAffected: result.changes };
  });

  /* ── 草稿账本 Query ── */

  /**
   * 按三键 (tenant, persona, id) 取单行草稿。**WHERE 带 persona_id**——防跨租户/跨人格读他人草稿，
   * 返回 0/1 行。
   */
  registerQuery<GithubReplyDraftRow | null, GithubReplyDraftKeyParams>(GITHUB_REPLY_DRAFT_QUERY_BY_ID, (db, p) => {
    return db.prepare<GithubReplyDraftRow>(
      'SELECT * FROM github_reply_drafts WHERE tenant_id = ? AND persona_id = ? AND id = ?',
    ).get(p.tenantId, p.personaId, p.id) ?? null;
  });

  /**
   * 按 (tenant, persona) 列多行草稿；status 可选过滤（对应 idx_github_reply_drafts_lookup
   * (tenant_id, persona_id, status)）。省略 status 则列该人格全部草稿。**WHERE 带 persona_id**——
   * persona 隔离，B persona 列不到 A persona 的草稿。created_at 升序稳定排序。
   */
  registerQuery<GithubReplyDraftRow[], GithubDraftListByPersonaParams>(GITHUB_REPLY_DRAFT_QUERY_BY_PERSONA, (db, p) => {
    if (p.status !== undefined) {
      return db.prepare<GithubReplyDraftRow>(
        `SELECT * FROM github_reply_drafts
           WHERE tenant_id = ? AND persona_id = ? AND status = ?
           ORDER BY created_at ASC`,
      ).all(p.tenantId, p.personaId, p.status);
    }
    return db.prepare<GithubReplyDraftRow>(
      `SELECT * FROM github_reply_drafts
         WHERE tenant_id = ? AND persona_id = ?
         ORDER BY created_at ASC`,
    ).all(p.tenantId, p.personaId);
  });

  /* ── webhook 幂等账本 Command ── */

  /**
   * 原子 claim：占位 webhook 幂等窗口。INSERT ... ON CONFLICT (tenant_id, delivery_id) DO NOTHING——
   * 首个 claim 者独占（rowsAffected=1），重复投递无副作用（rowsAffected=0）。store 层据受影响行数
   * 判 true/false。**绝非 check-then-act**：不先 SELECT 再 INSERT，故并发/崩溃下不重复触发动作。
   * 复合键含 tenant_id，故不同租户同 delivery_id 各自独立 claim。
   */
  registerCommand<GithubWebhookEventClaimParams>(GITHUB_WEBHOOK_EVENT_CMD_CLAIM, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO github_webhook_events
         (delivery_id, tenant_id, event_type, processed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, delivery_id) DO NOTHING`,
    ).run(
      p.deliveryId, p.tenantId, p.eventType, p.now,
    );
    return { rowsAffected: result.changes };
  });
}
