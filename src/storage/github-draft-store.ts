/**
 * GitHub 反馈起草段 storage（GithubDraftStore）— 薄适配器，回复草稿 CRUD + 状态机保护 +
 * webhook 幂等 claim。
 *
 * 「数字人对 GitHub issue/PR 起草回复、停在待审批」的存储门面（参照 GithubLearnStore 的
 * store + executor 分层）。两存储对象分工正交：
 *   - github_reply_drafts：回复草稿账本。createDraft 建一条 drafted 态草稿（起草即停铁律——
 *     执行器钉死 status='drafted'）；getDraft / listDrafts 按 (tenant, persona[, id/status]) 读；
 *     setStatus 推进 drafted → approved / rejected（**状态机保护**：执行器 WHERE status='drafted'，
 *     仅 drafted 可改，approved/rejected 终态不可逆，返 true=改成功 / false=非 drafted 态未改）。
 *   - github_webhook_events：webhook 幂等账本。claimWebhookEvent 是**原子占位**（执行器 INSERT
 *     ON CONFLICT (tenant_id, delivery_id) DO NOTHING，以受影响行数判——true=新投递 / false=重投）。
 *
 * 契约：真 SQL 全在 executors/github-draft-executors.ts；本层只组装 { kind, params } 描述符经
 * SyncWriteUnitOfWork 执行，并把 rowsAffected / Row 映射成调用方友好的返回值。构造时确保执行器
 * 已注册（idempotent registerCoreSelfExecutors）。全部读写 tenant scoped；草稿读写额外带 persona_id
 * （三键 (tenant, persona, id)——防跨租户/跨人格读写他人草稿）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  githubDraftInsert, githubDraftQueryById, githubDraftListByPersona,
  githubDraftUpdateStatus, githubDraftClaimForPublish, githubDraftMarkPublished,
  githubWebhookEventClaim,
} from '@chrono/kernel';
import type { GithubReplyDraftRow } from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { generatePrefixedId } from '../utils/index.js';

export class GithubDraftStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * 建一条回复草稿。id 在 store 侧生成并传入（ExecResult 只回 rowsAffected，不回自生成 id，
   * 故 store 生成以便建后即知 id 供返回——沿用 ProactiveMessageStore 的 insert-with-id 约定）；
   * 执行器钉死 status='drafted'（起草即停铁律）、created_at=updated_at=now。返回新草稿 id。
   */
  createDraft(
    personaId: string,
    repo: string,
    targetType: string,
    targetNumber: number,
    draftBody: string,
    now: number,
  ): string {
    const id = generatePrefixedId('ghdraft');
    this.tx.execute(githubDraftInsert({
      id, tenantId: this.tenantId, personaId, repo, targetType, targetNumber, draftBody, now,
    }));
    return id;
  }

  /**
   * 按三键 (tenant, persona, id) 取草稿行。persona 隔离——B persona 读不到 A persona 的草稿。
   * 无匹配返回 undefined。
   */
  getDraft(personaId: string, id: string): GithubReplyDraftRow | undefined {
    return this.tx.queryOne(githubDraftQueryById({
      tenantId: this.tenantId, personaId, id,
    })) ?? undefined;
  }

  /**
   * 列某 (tenant, persona) 的草稿；status 可选过滤（省略则列全部）。persona 隔离。
   */
  listDrafts(personaId: string, status?: string): GithubReplyDraftRow[] {
    return [...this.tx.queryMany(githubDraftListByPersona({
      tenantId: this.tenantId, personaId, status,
    }))];
  }

  /**
   * 推进草稿状态：drafted → approved / rejected（状态机保护——仅 drafted 可改）。
   * 返 true=改成功；false=非 drafted 态（approved/rejected 终态不可逆）或行不存在，均未改。
   * 三键定位——防跨租户/跨人格改他人草稿。
   */
  setStatus(personaId: string, id: string, status: 'approved' | 'rejected', now: number): boolean {
    const result = this.tx.execute(githubDraftUpdateStatus({
      tenantId: this.tenantId, personaId, id, status, now,
    }));
    return result.rowsAffected === 1;
  }

  /**
   * 原子占位发布：把 approved 草稿 CAS 成 published（防重复发布核心）。执行器
   * **UPDATE ... SET status='published', published_at=now WHERE ... AND status='approved'**——
   * `WHERE status='approved'` 保证只有 approved 能被 claim 成 published，且 UPDATE 是原子的：
   * 同一草稿并发/重复调用只有一次 rowsAffected=1，之后都是 0（已 published）。**先 UPDATE 占位再读回**
   * （非先 SELECT 再 UPDATE 的 check-then-act）。rowsAffected===1 才读回该行（含 draft_body / repo /
   * target_type / target_number 供发布）返回；rowsAffected===0（未批准 / 已发布 / 不存在 / 跨人格）返
   * undefined。三键定位——防跨租户/跨人格抢发他人草稿。
   */
  claimForPublish(personaId: string, id: string, now: number): GithubReplyDraftRow | undefined {
    const result = this.tx.execute(githubDraftClaimForPublish({
      tenantId: this.tenantId, personaId, id, now,
    }));
    if (result.rowsAffected !== 1) {
      return undefined;
    }
    /* 占位成功才读回：此刻该行 status 已是 published，含发布所需字段。 */
    return this.getDraft(personaId, id);
  }

  /**
   * 发布成功后回填 github_ref（GitHub 侧 comment/review id，审计+去重佐证）。执行器
   * **UPDATE ... SET github_ref=? WHERE tenant_id=? AND persona_id=? AND id=?**——三键定位，
   * 防跨租户/跨人格回填他人草稿。不校验 status（claimForPublish 已原子占位为 published）。
   */
  markPublished(personaId: string, id: string, githubRef: string, now: number): void {
    this.tx.execute(githubDraftMarkPublished({
      tenantId: this.tenantId, personaId, id, githubRef, now,
    }));
  }

  /**
   * 原子 claim webhook 幂等窗口：执行器 INSERT ON CONFLICT (tenant_id, delivery_id) DO NOTHING，
   * 以受影响行数判——返 true=首次投递（抢到，可继续处理）；false=重复投递（跳过，防重复触发动作）。
   * **绝非 check-then-act**：并发/崩溃下同 delivery_id 只有一个调用方拿到 true。复合键含 tenant_id，
   * 故不同租户同 delivery_id 各自独立 claim。
   */
  claimWebhookEvent(deliveryId: string, eventType: string, now: number): boolean {
    const result = this.tx.execute(githubWebhookEventClaim({
      tenantId: this.tenantId, deliveryId, eventType, now,
    }));
    return result.rowsAffected === 1;
  }
}
