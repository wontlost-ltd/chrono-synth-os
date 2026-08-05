/**
 * GitHub 学习段 storage（GithubLearnStore）— 薄适配器，增量同步游标读写 + 摄入幂等账本的原子 claim。
 *
 * 「数字人从 GitHub 增量学习」的存储门面。两存储对象分工正交（参照 GithubAppCredentialStore 的
 * store + executor 分层）：
 *   - github_learn_state：增量同步游标账本。per (tenant, persona, repo, resource_type) 一条游标行，
 *     供后续断点续拉。getCursor 按四键取回；advanceCursor 成功拉取后推进游标（四键 CAS upsert）。
 *   - github_ingest_digests：摄入幂等账本（spec ⑦b——防并发/崩溃重复灌记忆的关键机制）。
 *     claimDigest 是**原子占位**（执行器 INSERT ON CONFLICT DO NOTHING，以受影响行数判 claim 成败），
 *     markIngested 在摄入完成后把 status 由 claimed 置 ingested。
 *
 * 契约：真 SQL 全在 executors/github-learn-executors.ts；本层只组装 { kind, params } 描述符经
 * SyncWriteUnitOfWork 执行，并把 rowsAffected / Row 映射成调用方友好的返回值。构造时确保执行器
 * 已注册（idempotent registerCoreSelfExecutors）。全部读写 tenant scoped（tenant_id 参与幂等键）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  githubLearnStateQuery, githubLearnStateUpsertCursor,
  githubDigestClaim, githubDigestMarkIngested,
  githubDigestByDiscussionKeyQuery, githubDigestSetMemoryId,
  githubDigestReleaseClaim,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';

/** getCursor 返回：当前游标 + 最近推进时间（毫秒 epoch）。无游标行返回 undefined。 */
export interface GithubLearnCursor {
  cursor: string | null;
  cursorAdvancedAt: number | null;
}

export class GithubLearnStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * 取某 (persona, repo, resource_type) 的增量同步游标（本租户）。无游标行返回 undefined。
   * cursor / cursorAdvancedAt 各自可空（首次同步前无游标 / 尚未推进）。
   */
  getCursor(personaId: string, repo: string, resourceType: string): GithubLearnCursor | undefined {
    const row = this.tx.queryOne(githubLearnStateQuery({
      tenantId: this.tenantId, personaId, repo, resourceType,
    }));
    if (!row) return undefined;
    return { cursor: row.cursor, cursorAdvancedAt: row.cursor_advanced_at };
  }

  /**
   * 推进游标（成功拉取后调用）：在四键上 CAS upsert 游标 + 推进/同步时间戳。推进即视为一次同步完成，
   * 故 cursor_advanced_at 与 last_synced_at 同取 now。首插带 created_at；冲突只覆盖游标与时间戳。
   */
  advanceCursor(personaId: string, repo: string, resourceType: string, cursor: string, now: number): void {
    this.tx.execute(githubLearnStateUpsertCursor({
      tenantId: this.tenantId, personaId, repo, resourceType,
      cursor,
      cursorAdvancedAt: now,
      lastSyncedAt: now,
      now,
    }));
  }

  /**
   * 原子 claim 摄入幂等窗口（spec ⑦b 关键机制）：执行器 INSERT ON CONFLICT DO NOTHING，用受影响
   * 行数判定——返 true=本次抢到（未摄入过，可继续摄入）；false=已被抢/已摄入（跳过，防重复灌记忆）。
   * **绝非 check-then-act**：不先 SELECT 再 INSERT，故并发/崩溃下同 content_sha 只有一个调用方拿到 true。
   */
  claimDigest(personaId: string, repo: string, resourceType: string, contentSha: string, now: number, discussionKey?: string): boolean {
    const result = this.tx.execute(githubDigestClaim({
      tenantId: this.tenantId, personaId, repo, resourceType, contentSha, now, discussionKey,
    }));
    return result.rowsAffected === 1;
  }

  /**
   * 摄入完成后标记：把某条摘要 status 由 claimed 置 ingested，记录 ingested_at（本租户，五键定位）。
   */
  markIngested(personaId: string, repo: string, resourceType: string, contentSha: string, now: number): void {
    this.tx.execute(githubDigestMarkIngested({
      tenantId: this.tenantId, personaId, repo, resourceType, contentSha, now,
    }));
  }

  /**
   * 释放占位（摄入失败路径）：删除仍为 claimed 的行，使该内容下一轮可重新 claim。
   * 返回是否真的释放了一行（已 ingested 的行不会被删，返回 false）。
   */
  releaseDigestClaim(personaId: string, repo: string, resourceType: string, contentSha: string): boolean {
    const result = this.tx.execute(githubDigestReleaseClaim({
      tenantId: this.tenantId, personaId, repo, resourceType, contentSha,
    }));
    return result.rowsAffected === 1;
  }

  /**
   * 反查某讨论**当前**对应的记忆 ID（演进式取代用）。无记录 / 尚未回写记忆指针返回 undefined。
   *
   * 为什么不能用 content_sha 反查：讨论新增评论 → 表征变 → content_sha 变，
   * 按 sha 找不到「同一 issue 的上一版」。discussion_key 跨轮次稳定，才是取代路径的正确锚。
   */
  findMemoryIdsByDiscussionKey(personaId: string, discussionKey: string): string[] {
    const row = this.tx.queryOne(githubDigestByDiscussionKeyQuery({
      tenantId: this.tenantId, personaId, discussionKey,
    }));
    return parseMemoryIds(row?.memory_id ?? null);
  }

  /**
   * 回写摘要行对应的**全部**记忆 ID（perceive 产出 memoryIds 后调用），供下一轮取代整组删除。
   * 传空数组视为「无记忆可记」，不写入（保持 NULL，反查不会命中）。
   */
  recordMemoryIds(personaId: string, repo: string, resourceType: string, contentSha: string, memoryIds: readonly string[], now: number): void {
    if (memoryIds.length === 0) return;
    this.tx.execute(githubDigestSetMemoryId({
      tenantId: this.tenantId, personaId, repo, resourceType, contentSha, memoryIds, now,
    }));
  }
}

/**
 * 解析 memory_id 列（JSON 数组字符串）成 ID 列表。
 * 容错：null / 非法 JSON / 非数组 → 空列表（取代退化为「不删旧记忆」，宁可留冗余不误删）。
 */
function parseMemoryIds(raw: string | null): string[] {
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}
