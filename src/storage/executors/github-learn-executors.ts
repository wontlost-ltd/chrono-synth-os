/**
 * GitHub 学习段 SQL 执行器（GitHub 集成 Plan 2 Task 3）——增量同步游标账本 + 摄入幂等账本。
 *
 * kernel（github-learn-types.ts）只声明 { kind, params } 描述符与 Row 形状；真 SQL 在此层
 * （与 github-app-executors.ts / llm-credential-executors.ts 同架构）。dispatch 一律用 kernel
 * 导出的 kind 常量，**不硬编码字面量**（Task 2 契约传承）。
 *
 * 两存储对象分工正交：
 *   - github_learn_state：per (tenant, persona, repo, resource_type) 一条游标行。upsertCursor 在
 *     UNIQUE(tenant_id, persona_id, repo, resource_type) 四键上 CAS upsert（首插带 created_at，
 *     冲突只更 cursor / cursor_advanced_at / last_synced_at / updated_at）。
 *   - github_ingest_digests：摄入幂等账本。**claim 是原子占位**——INSERT ... ON CONFLICT
 *     (tenant_id, persona_id, repo, resource_type, content_sha) DO NOTHING，以受影响行数判定
 *     （rowsAffected=1=首个 claim 者抢到未摄入过；0=已被抢/已摄入）。绝非 check-then-act（先
 *     SELECT 再 INSERT 在并发/崩溃下会重复灌记忆——spec ⑦b 明确禁止）。markIngested 把 status
 *     由 claimed 置 ingested 并记 ingested_at。
 *
 * ⚠️ 安全不变量（Task 2 契约）：两表均 tenant scoped——全部读写 WHERE / 键内均带 tenant_id，
 *   幂等键含 tenant_id，故不同租户同 (persona,repo,resource,sha) 各自独立 claim（不跨租户串扰）。
 */

import { randomUUID } from 'node:crypto';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  GithubLearnStateRow, GithubIngestDigestRow,
  GithubLearnStateKeyParams, GithubLearnStateUpsertCursorParams,
  GithubIngestDigestKeyParams, GithubDigestClaimParams, GithubDigestMarkIngestedParams,
  GithubDigestByDiscussionKeyParams, GithubDigestSetMemoryIdParams,
} from '@chrono/kernel';
import {
  GITHUB_LEARN_STATE_QUERY, GITHUB_LEARN_STATE_CMD_UPSERT_CURSOR,
  GITHUB_INGEST_DIGEST_QUERY, GITHUB_INGEST_DIGEST_CMD_CLAIM, GITHUB_INGEST_DIGEST_CMD_MARK_INGESTED,
  GITHUB_INGEST_DIGEST_QUERY_BY_DISCUSSION, GITHUB_INGEST_DIGEST_CMD_SET_MEMORY_ID,
  GITHUB_INGEST_DIGEST_CMD_RELEASE_CLAIM,
} from '@chrono/kernel';

export function registerGithubLearnExecutors(): void {
  /* ── 游标账本 Query ── */

  /**
   * 按四键 (tenant, persona, repo, resource_type) 取游标行。tenant scoped。
   * 依赖 UNIQUE(tenant_id, persona_id, repo, resource_type) 返回 0/1 行。
   */
  registerQuery<GithubLearnStateRow | null, GithubLearnStateKeyParams>(GITHUB_LEARN_STATE_QUERY, (db, p) => {
    return db.prepare<GithubLearnStateRow>(
      'SELECT * FROM github_learn_state WHERE tenant_id = ? AND persona_id = ? AND repo = ? AND resource_type = ?',
    ).get(p.tenantId, p.personaId, p.repo, p.resourceType) ?? null;
  });

  /* ── 游标账本 Command ── */

  /**
   * upsert 游标：四键 CAS upsert。首插带 created_at；冲突（已有同四键行）时 DO UPDATE 只更
   * cursor / cursor_advanced_at / last_synced_at / updated_at，**created_at 保持首插值不变**。
   */
  registerCommand<GithubLearnStateUpsertCursorParams>(GITHUB_LEARN_STATE_CMD_UPSERT_CURSOR, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO github_learn_state
         (id, tenant_id, persona_id, repo, resource_type, cursor, cursor_advanced_at, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, persona_id, repo, resource_type) DO UPDATE SET
         cursor = excluded.cursor,
         cursor_advanced_at = excluded.cursor_advanced_at,
         last_synced_at = excluded.last_synced_at,
         updated_at = excluded.updated_at`,
    ).run(
      randomUUID(), p.tenantId, p.personaId, p.repo, p.resourceType,
      p.cursor, p.cursorAdvancedAt, p.lastSyncedAt, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  /* ── 摄入幂等账本 Query ── */

  /**
   * 按五键 (tenant, persona, repo, resource_type, content_sha) 反查单行摘要（测试 / reclaim 用）。
   * 依赖 UNIQUE(...) 幂等主键返回 0/1 行。tenant scoped。
   */
  registerQuery<GithubIngestDigestRow | null, GithubIngestDigestKeyParams>(GITHUB_INGEST_DIGEST_QUERY, (db, p) => {
    return db.prepare<GithubIngestDigestRow>(
      'SELECT * FROM github_ingest_digests WHERE tenant_id = ? AND persona_id = ? AND repo = ? AND resource_type = ? AND content_sha = ?',
    ).get(p.tenantId, p.personaId, p.repo, p.resourceType, p.contentSha) ?? null;
  });

  /* ── 摄入幂等账本 Command ── */

  /**
   * 原子 claim：占位摄入幂等窗口。INSERT ... ON CONFLICT DO NOTHING——首个 claim 者独占
   * （rowsAffected=1），重复 claim 无副作用（rowsAffected=0）。store 层据受影响行数判 true/false。
   * **绝非 check-then-act**：不先 SELECT 再 INSERT，故并发/崩溃下不会重复灌记忆（spec ⑦b）。
   * 首次占位 status=claimed，claimed_at=now，ingested_at 尚空。
   */
  registerCommand<GithubDigestClaimParams>(GITHUB_INGEST_DIGEST_CMD_CLAIM, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO github_ingest_digests
         (id, tenant_id, persona_id, repo, resource_type, content_sha, status, claimed_at, ingested_at, discussion_key, memory_id)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, NULL, ?, NULL)
       ON CONFLICT(tenant_id, persona_id, repo, resource_type, content_sha) DO NOTHING`,
    ).run(
      randomUUID(), p.tenantId, p.personaId, p.repo, p.resourceType, p.contentSha, p.now,
      p.discussionKey ?? null,
    );
    return { rowsAffected: result.changes };
  });

  /**
   * 摄入完成：把某条摘要 status 由 claimed 置 ingested，记 ingested_at。五键定位。tenant scoped。
   */
  registerCommand<GithubDigestMarkIngestedParams>(GITHUB_INGEST_DIGEST_CMD_MARK_INGESTED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE github_ingest_digests
         SET status = 'ingested', ingested_at = ?
       WHERE tenant_id = ? AND persona_id = ? AND repo = ? AND resource_type = ? AND content_sha = ?`,
    ).run(
      p.now, p.tenantId, p.personaId, p.repo, p.resourceType, p.contentSha,
    );
    return { rowsAffected: result.changes };
  });

  /**
   * 释放占位：删除仍处 claimed 的行，使失败内容下一轮可重新 claim。五键定位。tenant scoped。
   * status 谓词是安全闸——已 ingested 的行是有效去重记录，任何情况下都不删。
   */
  registerCommand<GithubIngestDigestKeyParams>(GITHUB_INGEST_DIGEST_CMD_RELEASE_CLAIM, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM github_ingest_digests
       WHERE tenant_id = ? AND persona_id = ? AND repo = ? AND resource_type = ? AND content_sha = ?
         AND status = 'claimed'`,
    ).run(
      p.tenantId, p.personaId, p.repo, p.resourceType, p.contentSha,
    );
    return { rowsAffected: result.changes };
  });

  /* ── 演进式取代（讨论键反查 + 记忆指针回写） ── */

  /**
   * 按 (tenant, persona, discussion_key) 反查该讨论当前的摘要行。tenant scoped。
   *
   * 只取 memory_id 非空的行：仅 claim 占位、尚未回写记忆指针的行没有可取代的记忆。
   * 同一讨论跨轮次会留多行（每轮 content_sha 不同），按 ingested_at 降序取最新一条——
   * 即「上一版记忆」。ingested_at 相同（同毫秒）时以 rowid 降序兜底，保证确定性。
   */
  registerQuery<GithubIngestDigestRow | null, GithubDigestByDiscussionKeyParams>(GITHUB_INGEST_DIGEST_QUERY_BY_DISCUSSION, (db, p) => {
    return db.prepare<GithubIngestDigestRow>(
      `SELECT * FROM github_ingest_digests
        WHERE tenant_id = ? AND persona_id = ? AND discussion_key = ? AND memory_id IS NOT NULL
        ORDER BY ingested_at DESC, rowid DESC
        LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.discussionKey) ?? null;
  });

  /**
   * 回写摘要行的记忆 ID 列表（perceive 产出记忆后调用）。五键定位。tenant scoped。
   * 下一轮同讨论摄入时据此找到并删除这**整组**旧记忆，实现「每 issue 恒为最新一版共识」。
   *
   * 存 JSON 数组字符串：perceive 把一条表征切成多条事实记忆（标题/正文/讨论各一条），
   * 只存单个 ID 会漏删其余、记忆仍堆积。列本就是 TEXT，无需改表。
   */
  registerCommand<GithubDigestSetMemoryIdParams>(GITHUB_INGEST_DIGEST_CMD_SET_MEMORY_ID, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE github_ingest_digests
         SET memory_id = ?
       WHERE tenant_id = ? AND persona_id = ? AND repo = ? AND resource_type = ? AND content_sha = ?`,
    ).run(
      JSON.stringify(p.memoryIds), p.tenantId, p.personaId, p.repo, p.resourceType, p.contentSha,
    );
    return { rowsAffected: result.changes };
  });
}
