/**
 * 单元测试：GitHub 学习段 kernel 契约（github-learn-types）。
 *
 * kernel 契约层只声明 Query/Command 的 { kind, params } 形状（不含 SQL——SQL 在
 * src/storage/executors 的执行器里，与 github-app-types.ts 同架构）。因此本测试断言的是
 * 「契约形状」这一参数化等价物：
 *   - githubLearnStateQuery / githubLearnStateUpsertCursor 生成的描述符必须在 params 里携带
 *     四键（tenantId / personaId / repo / resourceType），对应 Task 1 建的
 *     UNIQUE(tenant_id, persona_id, repo, resource_type) 游标唯一约束（一个
 *     (租户,人格,仓库,资源类型) 只有一条游标行）。
 *   - githubDigestClaim 必须有专用 kind（原子 claim 语义 ≠ 普通 upsert），并携带 content_sha
 *     指纹与四键，对应摄入幂等账本的 UNIQUE(tenant_id, persona_id, repo, resource_type,
 *     content_sha) 主键（INSERT ON CONFLICT DO NOTHING 在执行器里）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_LEARN_STATE_QUERY,
  GITHUB_LEARN_STATE_CMD_UPSERT_CURSOR,
  GITHUB_INGEST_DIGEST_CMD_CLAIM,
  GITHUB_INGEST_DIGEST_CMD_MARK_INGESTED,
  GITHUB_INGEST_DIGEST_QUERY,
  githubLearnStateQuery,
  githubLearnStateUpsertCursor,
  githubDigestClaim,
  githubDigestMarkIngested,
  githubDigestQuery,
  type GithubLearnStateRow,
  type GithubIngestDigestRow,
} from '@chrono/kernel';

const FOUR_KEYS = ['personaId', 'repo', 'resourceType', 'tenantId'];
const FIVE_KEYS = ['contentSha', 'personaId', 'repo', 'resourceType', 'tenantId'];

describe('github-learn-types kernel 契约', () => {
  describe('githubLearnStateQuery（游标四键定位）', () => {
    it('params 同时携带四键（tenant/persona/repo/resourceType）', () => {
      const q = githubLearnStateQuery({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        repo: 'acme/repo',
        resourceType: 'issues',
      });
      // 参数化等价于 WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=?
      assert.equal(q.kind, GITHUB_LEARN_STATE_QUERY);
      assert.equal(q.params.tenantId, 'tenant-a');
      assert.equal(q.params.personaId, 'persona-1');
      assert.equal(q.params.repo, 'acme/repo');
      assert.equal(q.params.resourceType, 'issues');
    });

    it('四键都必须存在（缺一即无法定位唯一游标行）', () => {
      const q = githubLearnStateQuery({
        tenantId: 't',
        personaId: 'p',
        repo: 'r',
        resourceType: 'code',
      });
      assert.deepEqual(Object.keys(q.params).sort(), FOUR_KEYS);
    });
  });

  describe('githubLearnStateUpsertCursor（游标推进，upsert on 四键）', () => {
    it('携带四键 + 游标 + 三时间戳', () => {
      const cmd = githubLearnStateUpsertCursor({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        repo: 'acme/repo',
        resourceType: 'commits',
        cursor: 'sha-cursor-123',
        cursorAdvancedAt: 2000,
        lastSyncedAt: 3000,
        now: 1000,
      });
      assert.equal(cmd.kind, GITHUB_LEARN_STATE_CMD_UPSERT_CURSOR);
      assert.equal(cmd.params.tenantId, 'tenant-a');
      assert.equal(cmd.params.personaId, 'persona-1');
      assert.equal(cmd.params.repo, 'acme/repo');
      assert.equal(cmd.params.resourceType, 'commits');
      assert.equal(cmd.params.cursor, 'sha-cursor-123');
      assert.equal(cmd.params.cursorAdvancedAt, 2000);
      assert.equal(cmd.params.lastSyncedAt, 3000);
      assert.equal(cmd.params.now, 1000);
    });

    it('游标与推进/同步时间戳可空（首次同步前无游标）', () => {
      const cmd = githubLearnStateUpsertCursor({
        tenantId: 't',
        personaId: 'p',
        repo: 'r',
        resourceType: 'pulls',
        cursor: null,
        cursorAdvancedAt: null,
        lastSyncedAt: null,
        now: 1000,
      });
      assert.equal(cmd.params.cursor, null);
      assert.equal(cmd.params.cursorAdvancedAt, null);
      assert.equal(cmd.params.lastSyncedAt, null);
    });
  });

  describe('githubDigestClaim（原子 claim，专用 kind ≠ 普通 upsert）', () => {
    it('有专用 claim kind（INSERT ON CONFLICT DO NOTHING 语义在执行器）', () => {
      const cmd = githubDigestClaim({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        repo: 'acme/repo',
        resourceType: 'issues',
        contentSha: 'sha-abc',
        now: 1000,
      });
      assert.equal(cmd.kind, GITHUB_INGEST_DIGEST_CMD_CLAIM);
      // claim 的 kind 必须和 markIngested / 普通查询区分开（语义不同）
      assert.notEqual(cmd.kind, GITHUB_INGEST_DIGEST_CMD_MARK_INGESTED);
      assert.notEqual(cmd.kind, GITHUB_INGEST_DIGEST_QUERY);
    });

    it('claim 携带五键（四键 + content_sha 指纹）', () => {
      const cmd = githubDigestClaim({
        tenantId: 't',
        personaId: 'p',
        repo: 'r',
        resourceType: 'code',
        contentSha: 'sha-xyz',
        now: 1000,
      });
      const keys = Object.keys(cmd.params).sort();
      // now 是时间戳，五键定位幂等窗口
      assert.deepEqual(keys.filter((k) => k !== 'now').sort(), FIVE_KEYS);
      assert.equal(cmd.params.contentSha, 'sha-xyz');
    });
  });

  describe('githubDigestMarkIngested（status → ingested）', () => {
    it('专用 markIngested kind + 五键定位', () => {
      const cmd = githubDigestMarkIngested({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        repo: 'acme/repo',
        resourceType: 'pulls',
        contentSha: 'sha-abc',
        now: 5000,
      });
      assert.equal(cmd.kind, GITHUB_INGEST_DIGEST_CMD_MARK_INGESTED);
      assert.equal(cmd.params.contentSha, 'sha-abc');
      assert.equal(cmd.params.now, 5000);
    });
  });

  describe('githubDigestQuery（测试 / reclaim 用）', () => {
    it('按五键反查单行摘要', () => {
      const q = githubDigestQuery({
        tenantId: 't',
        personaId: 'p',
        repo: 'r',
        resourceType: 'commits',
        contentSha: 'sha-q',
      });
      assert.equal(q.kind, GITHUB_INGEST_DIGEST_QUERY);
      assert.deepEqual(Object.keys(q.params).sort(), FIVE_KEYS);
      assert.equal(q.params.contentSha, 'sha-q');
    });
  });

  describe('Row 类型对齐 DB 列（编译期校验 + 运行期形状）', () => {
    it('GithubLearnStateRow 字段与表列一致', () => {
      const row: GithubLearnStateRow = {
        id: 'i',
        tenant_id: 't',
        persona_id: 'p',
        repo: 'r',
        resource_type: 'issues',
        cursor: null,
        cursor_advanced_at: null,
        last_synced_at: null,
        created_at: 1,
        updated_at: 2,
      };
      assert.deepEqual(Object.keys(row).sort(), [
        'created_at', 'cursor', 'cursor_advanced_at', 'id',
        'last_synced_at', 'persona_id', 'repo', 'resource_type',
        'tenant_id', 'updated_at',
      ]);
    });

    it('GithubIngestDigestRow 字段与表列一致', () => {
      const row: GithubIngestDigestRow = {
        id: 'i',
        tenant_id: 't',
        persona_id: 'p',
        repo: 'r',
        resource_type: 'code',
        content_sha: 'sha',
        status: 'claimed',
        claimed_at: 1,
        ingested_at: null,
      };
      assert.deepEqual(Object.keys(row).sort(), [
        'claimed_at', 'content_sha', 'id', 'ingested_at',
        'persona_id', 'repo', 'resource_type', 'status', 'tenant_id',
      ]);
    });
  });
});
