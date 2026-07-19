/**
 * 单元测试：GitHub 反馈起草段 kernel 契约（github-draft-types）。
 *
 * kernel 契约层只声明 Query/Command 的 { kind, params } 形状（不含 SQL——SQL 在
 * src/storage/executors 的执行器里，与 github-learn-types.ts / github-app-types.ts 同架构）。
 * 因此本测试断言的是「契约形状」这一参数化等价物：
 *   - githubDraftInsert 落 drafted 态草稿，params 携带六字段（tenant/persona/repo/targetType/
 *     targetNumber/draftBody）+ now 时间戳；首插 status 由执行器钉死 drafted（起草即停铁律）。
 *   - githubDraftQueryById 按 (tenant, persona, id) 三键反查单行（0/1 行）；租户+人格隔离，
 *     防跨租户/跨人格读他人草稿。
 *   - githubDraftListByPersona 按 (tenant, persona) 列多行，status 可选过滤（对应
 *     idx_github_reply_drafts_lookup (tenant_id, persona_id, status)）。
 *   - githubDraftUpdateStatus 把某条草稿状态推进（drafted → approved / rejected），执行器
 *     WHERE status='drafted' 保护（仅 drafted 可改，approved/rejected 终态不可逆），params 带 status。
 *   - githubWebhookEventClaim 必须有专用 claim kind（原子占位语义 ≠ 普通 insert），执行器用
 *     INSERT ON CONFLICT (tenant_id, delivery_id) DO NOTHING 抢占幂等窗口。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_REPLY_DRAFT_CMD_INSERT,
  GITHUB_REPLY_DRAFT_QUERY_BY_ID,
  GITHUB_REPLY_DRAFT_QUERY_BY_PERSONA,
  GITHUB_REPLY_DRAFT_CMD_UPDATE_STATUS,
  GITHUB_WEBHOOK_EVENT_CMD_CLAIM,
  githubDraftInsert,
  githubDraftQueryById,
  githubDraftListByPersona,
  githubDraftUpdateStatus,
  githubWebhookEventClaim,
  type GithubReplyDraftRow,
  type GithubWebhookEventRow,
} from '@chrono/kernel';

describe('github-draft-types kernel 契约', () => {
  describe('githubDraftInsert（首插 drafted 态草稿）', () => {
    it('专用 insert kind + params 携带六字段 + now', () => {
      const cmd = githubDraftInsert({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        repo: 'acme/repo',
        targetType: 'issue',
        targetNumber: 42,
        draftBody: '感谢反馈，我们会跟进。',
        now: 1000,
      });
      assert.equal(cmd.kind, GITHUB_REPLY_DRAFT_CMD_INSERT);
      assert.equal(cmd.params.tenantId, 'tenant-a');
      assert.equal(cmd.params.personaId, 'persona-1');
      assert.equal(cmd.params.repo, 'acme/repo');
      assert.equal(cmd.params.targetType, 'issue');
      assert.equal(cmd.params.targetNumber, 42);
      assert.equal(cmd.params.draftBody, '感谢反馈，我们会跟进。');
      assert.equal(cmd.params.now, 1000);
    });

    it('params 键集合恰为七项（六字段 + now，status 由执行器钉死 drafted 不入参）', () => {
      const cmd = githubDraftInsert({
        tenantId: 't',
        personaId: 'p',
        repo: 'r',
        targetType: 'pull',
        targetNumber: 7,
        draftBody: 'body',
        now: 1,
      });
      assert.deepEqual(Object.keys(cmd.params).sort(), [
        'draftBody', 'now', 'personaId', 'repo',
        'targetNumber', 'targetType', 'tenantId',
      ]);
    });
  });

  describe('githubDraftQueryById（三键反查单行）', () => {
    it('携带 tenant/persona/id（租户+人格隔离，返回 0/1 行）', () => {
      const q = githubDraftQueryById({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        id: 'draft-123',
      });
      assert.equal(q.kind, GITHUB_REPLY_DRAFT_QUERY_BY_ID);
      assert.equal(q.params.tenantId, 'tenant-a');
      assert.equal(q.params.personaId, 'persona-1');
      assert.equal(q.params.id, 'draft-123');
      assert.deepEqual(Object.keys(q.params).sort(), ['id', 'personaId', 'tenantId']);
    });
  });

  describe('githubDraftListByPersona（按人格列多行，status 可选过滤）', () => {
    it('无 status 时只携带 tenant/persona', () => {
      const q = githubDraftListByPersona({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
      });
      assert.equal(q.kind, GITHUB_REPLY_DRAFT_QUERY_BY_PERSONA);
      assert.equal(q.params.tenantId, 'tenant-a');
      assert.equal(q.params.personaId, 'persona-1');
      assert.equal(q.params.status, undefined);
    });

    it('带 status 时携带过滤值（对应 lookup 索引第三列）', () => {
      const q = githubDraftListByPersona({
        tenantId: 't',
        personaId: 'p',
        status: 'drafted',
      });
      assert.equal(q.params.status, 'drafted');
    });
  });

  describe('githubDraftUpdateStatus（drafted → approved / rejected）', () => {
    it('专用 updateStatus kind + params 带 status 与 now', () => {
      const cmd = githubDraftUpdateStatus({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        id: 'draft-123',
        status: 'approved',
        now: 5000,
      });
      assert.equal(cmd.kind, GITHUB_REPLY_DRAFT_CMD_UPDATE_STATUS);
      // 与 insert 区分（语义不同：insert 建行，updateStatus 推进状态）
      assert.notEqual(cmd.kind, GITHUB_REPLY_DRAFT_CMD_INSERT);
      assert.equal(cmd.params.status, 'approved');
      assert.equal(cmd.params.now, 5000);
      assert.deepEqual(Object.keys(cmd.params).sort(), [
        'id', 'now', 'personaId', 'status', 'tenantId',
      ]);
    });

    it('支持 rejected 终态', () => {
      const cmd = githubDraftUpdateStatus({
        tenantId: 't',
        personaId: 'p',
        id: 'd',
        status: 'rejected',
        now: 1,
      });
      assert.equal(cmd.params.status, 'rejected');
    });
  });

  describe('githubWebhookEventClaim（原子 claim，专用 kind ≠ insert）', () => {
    it('有专用 claim kind（INSERT ON CONFLICT DO NOTHING 语义在执行器）', () => {
      const cmd = githubWebhookEventClaim({
        tenantId: 'tenant-a',
        deliveryId: 'delivery-abc',
        eventType: 'issue_comment',
        now: 1000,
      });
      assert.equal(cmd.kind, GITHUB_WEBHOOK_EVENT_CMD_CLAIM);
      // claim 的 kind 必须与 draftInsert 区分开（幂等抢占 ≠ 普通 insert）
      assert.notEqual(cmd.kind, GITHUB_REPLY_DRAFT_CMD_INSERT);
    });

    it('携带 tenant/deliveryId/eventType + now（复合幂等键 tenant_id+delivery_id）', () => {
      const cmd = githubWebhookEventClaim({
        tenantId: 't',
        deliveryId: 'd',
        eventType: 'pull_request',
        now: 2000,
      });
      assert.equal(cmd.params.tenantId, 't');
      assert.equal(cmd.params.deliveryId, 'd');
      assert.equal(cmd.params.eventType, 'pull_request');
      assert.equal(cmd.params.now, 2000);
      assert.deepEqual(Object.keys(cmd.params).sort(), [
        'deliveryId', 'eventType', 'now', 'tenantId',
      ]);
    });
  });

  describe('Row 类型对齐 DB 列（编译期校验 + 运行期形状）', () => {
    it('GithubReplyDraftRow 字段与表列一致', () => {
      const row: GithubReplyDraftRow = {
        id: 'i',
        tenant_id: 't',
        persona_id: 'p',
        repo: 'r',
        target_type: 'issue',
        target_number: 1,
        draft_body: 'body',
        status: 'drafted',
        created_at: 1,
        updated_at: 2,
      };
      assert.deepEqual(Object.keys(row).sort(), [
        'created_at', 'draft_body', 'id', 'persona_id', 'repo',
        'status', 'target_number', 'target_type', 'tenant_id', 'updated_at',
      ]);
    });

    it('GithubWebhookEventRow 字段与表列一致', () => {
      const row: GithubWebhookEventRow = {
        delivery_id: 'd',
        tenant_id: 't',
        event_type: 'issue_comment',
        processed_at: 1,
      };
      assert.deepEqual(Object.keys(row).sort(), [
        'delivery_id', 'event_type', 'processed_at', 'tenant_id',
      ]);
    });
  });
});
