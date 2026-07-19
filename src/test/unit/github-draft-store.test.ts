/**
 * GitHub 反馈起草段 storage（GithubDraftStore）：草稿 CRUD + 状态机保护 + webhook 幂等 claim。
 *
 * 断言重点（Plan 3 Task 3——起草即停铁律 + 状态机 + 幂等去重 + 跨人格隔离）：
 *   1. createDraft → getDraft 往返：新建行 status 由执行器钉死 drafted（不入参——起草即停铁律），
 *      created_at = updated_at = now。
 *   2. 状态机保护（核心）：drafted → approved 返 true（改成功）；已 approved 再 setStatus 返 false
 *      且状态不变（执行器 WHERE status='drafted' 保护——approved/rejected 终态不可逆）。
 *   3. listDrafts 按 status 过滤 + persona 隔离：省略 status 列该人格全部；带 status 只列匹配态；
 *      B persona 列不到 A persona 的草稿。
 *   4. claimWebhookEvent 原子去重：首次同 delivery_id 返 true（抢占），二次同 delivery_id 返 false
 *      （重投——rowsAffected=0）。执行器 INSERT ON CONFLICT (tenant_id, delivery_id) DO NOTHING。
 *   5. 三键 (tenant, persona, id) 收紧真守：getDraft / setStatus 带 persona_id，B persona 读不到 /
 *      改不动 A persona 的草稿（防跨人格读写他人草稿）；跨租户同样隔离。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { GithubDraftStore } from '../../storage/github-draft-store.js';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'tenant_a';
const PERSONA = 'persona_1';
const REPO = 'acme/repo';

describe('GitHub 反馈起草段 storage（GithubDraftStore）', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });

  describe('createDraft → getDraft 往返（起草即停：status 钉死 drafted）', () => {
    it('新建草稿 status=drafted，created_at=updated_at=now，字段回读一致', () => {
      const store = new GithubDraftStore(db, TENANT);
      const id = store.createDraft(PERSONA, REPO, 'issue', 42, '感谢反馈，我们会跟进。', 1000);

      const row = store.getDraft(PERSONA, id);
      assert.ok(row, 'getDraft 应回读到刚建的草稿');
      assert.equal(row.id, id);
      assert.equal(row.tenant_id, TENANT);
      assert.equal(row.persona_id, PERSONA);
      assert.equal(row.repo, REPO);
      assert.equal(row.target_type, 'issue');
      assert.equal(row.target_number, 42);
      assert.equal(row.draft_body, '感谢反馈，我们会跟进。');
      assert.equal(row.status, 'drafted', '起草即停：首插钉死 drafted');
      assert.equal(row.created_at, 1000, 'created_at=now');
      assert.equal(row.updated_at, 1000, 'updated_at=now');
    });

    it('createDraft 返回可用 id，pull 目标类型同样落 drafted', () => {
      const store = new GithubDraftStore(db, TENANT);
      const id = store.createDraft(PERSONA, REPO, 'pull', 7, 'PR review 意见', 2000);
      assert.ok(typeof id === 'string' && id.length > 0, 'createDraft 返回非空 id');
      assert.equal(store.getDraft(PERSONA, id)?.status, 'drafted');
    });

    it('getDraft 不存在的 id 返 undefined', () => {
      const store = new GithubDraftStore(db, TENANT);
      assert.equal(store.getDraft(PERSONA, 'no-such-id'), undefined);
    });
  });

  describe('setStatus 状态机保护（核心：仅 drafted 可改，终态不可逆）', () => {
    it('drafted → approved 返 true；再 setStatus 已 approved 返 false 且状态不变', () => {
      const store = new GithubDraftStore(db, TENANT);
      const id = store.createDraft(PERSONA, REPO, 'issue', 1, '回复正文', 1000);

      /* drafted → approved：改成功。 */
      assert.equal(store.setStatus(PERSONA, id, 'approved', 2000), true, 'drafted→approved 改成功');
      const afterApprove = store.getDraft(PERSONA, id);
      assert.equal(afterApprove?.status, 'approved', '状态已推进为 approved');
      assert.equal(afterApprove?.updated_at, 2000, 'updated_at 随状态推进更新');

      /* 已 approved 再改：WHERE status='drafted' 拦截，rowsAffected=0 → false，状态与时间戳不变。 */
      assert.equal(store.setStatus(PERSONA, id, 'rejected', 3000), false, '非 drafted 态不可再改');
      const afterReject = store.getDraft(PERSONA, id);
      assert.equal(afterReject?.status, 'approved', '状态保持 approved（终态不可逆）');
      assert.equal(afterReject?.updated_at, 2000, 'updated_at 不被非法推进覆盖');
    });

    it('drafted → rejected 同样成功，且 rejected 终态不可再改', () => {
      const store = new GithubDraftStore(db, TENANT);
      const id = store.createDraft(PERSONA, REPO, 'issue', 2, '驳回场景', 1000);
      assert.equal(store.setStatus(PERSONA, id, 'rejected', 2000), true, 'drafted→rejected 改成功');
      assert.equal(store.setStatus(PERSONA, id, 'approved', 3000), false, 'rejected 后不可再改');
      assert.equal(store.getDraft(PERSONA, id)?.status, 'rejected');
    });

    it('setStatus 不存在的 id 返 false', () => {
      const store = new GithubDraftStore(db, TENANT);
      assert.equal(store.setStatus(PERSONA, 'no-such-id', 'approved', 2000), false);
    });
  });

  describe('listDrafts（status 过滤 + persona 隔离）', () => {
    it('省略 status 列该人格全部草稿；带 status 只列匹配态', () => {
      const store = new GithubDraftStore(db, TENANT);
      const a = store.createDraft(PERSONA, REPO, 'issue', 1, 'body-1', 1000);
      const b = store.createDraft(PERSONA, REPO, 'issue', 2, 'body-2', 1000);
      store.createDraft(PERSONA, REPO, 'pull', 3, 'body-3', 1000);
      store.setStatus(PERSONA, a, 'approved', 2000);

      const all = store.listDrafts(PERSONA);
      assert.equal(all.length, 3, '省略 status 列全部三条');

      const drafted = store.listDrafts(PERSONA, 'drafted');
      assert.equal(drafted.length, 2, 'drafted 过滤只剩两条');
      assert.ok(drafted.every((r) => r.status === 'drafted'));
      assert.ok(drafted.some((r) => r.id === b), '未改状态的 b 仍在 drafted 集');

      const approved = store.listDrafts(PERSONA, 'approved');
      assert.equal(approved.length, 1, 'approved 过滤只剩一条');
      assert.equal(approved[0]?.id, a);
    });

    it('persona 隔离：B persona 列不到 A persona 的草稿', () => {
      const store = new GithubDraftStore(db, TENANT);
      store.createDraft('persona_A', REPO, 'issue', 1, 'A 的草稿', 1000);
      assert.equal(store.listDrafts('persona_A').length, 1, 'A 自己能列到');
      assert.equal(store.listDrafts('persona_B').length, 0, 'B 列不到 A 的草稿');
    });
  });

  describe('三键 (tenant, persona, id) 收紧真守（防跨人格 / 跨租户读写他人草稿）', () => {
    it('B persona 读不到 A persona 的草稿（getDraft 带 persona_id）', () => {
      const store = new GithubDraftStore(db, TENANT);
      const id = store.createDraft('persona_A', REPO, 'issue', 1, 'A 的草稿', 1000);
      assert.ok(store.getDraft('persona_A', id), 'A 自己读得到');
      assert.equal(store.getDraft('persona_B', id), undefined, 'B 用同 id 读不到 A 的草稿');
    });

    it('B persona 改不动 A persona 的草稿（setStatus 带 persona_id）', () => {
      const store = new GithubDraftStore(db, TENANT);
      const id = store.createDraft('persona_A', REPO, 'issue', 1, 'A 的草稿', 1000);
      assert.equal(store.setStatus('persona_B', id, 'approved', 2000), false, 'B 改不动 A 的草稿');
      assert.equal(store.getDraft('persona_A', id)?.status, 'drafted', 'A 的草稿状态未被 B 篡改');
    });

    it('跨租户隔离：B 租户读不到 / 改不动 A 租户的草稿', () => {
      const storeA = new GithubDraftStore(db, 'tenant_A');
      const storeB = new GithubDraftStore(db, 'tenant_B');
      const id = storeA.createDraft(PERSONA, REPO, 'issue', 1, '跨租户草稿', 1000);
      assert.equal(storeB.getDraft(PERSONA, id), undefined, 'B 租户读不到 A 租户草稿');
      assert.equal(storeB.setStatus(PERSONA, id, 'approved', 2000), false, 'B 租户改不动 A 租户草稿');
      assert.equal(storeA.getDraft(PERSONA, id)?.status, 'drafted', 'A 租户草稿未被篡改');
    });
  });

  describe('claimWebhookEvent（原子去重——INSERT ON CONFLICT (tenant_id, delivery_id) DO NOTHING）', () => {
    it('同一 delivery_id：首次 claim 返 true，二次同 delivery_id 返 false（幂等去重）', () => {
      const store = new GithubDraftStore(db, TENANT);
      const delivery = 'delivery-abc-123';

      assert.equal(store.claimWebhookEvent(delivery, 'issue_comment', 1000), true, '首次投递抢到');
      assert.equal(store.claimWebhookEvent(delivery, 'issue_comment', 2000), false, '同 delivery_id 重投抢不到');

      const cnt = db.prepare<{ c: number }>(
        'SELECT COUNT(*) AS c FROM github_webhook_events WHERE tenant_id=? AND delivery_id=?',
      ).get(TENANT, delivery)?.c;
      assert.equal(cnt, 1, '幂等主键防重复：只落一行');
    });

    it('不同 delivery_id 各自独立 claim（都返 true）', () => {
      const store = new GithubDraftStore(db, TENANT);
      assert.equal(store.claimWebhookEvent('delivery-1', 'pull_request', 1000), true);
      assert.equal(store.claimWebhookEvent('delivery-2', 'pull_request', 1000), true, '不同 delivery 互不影响');
    });

    it('跨租户隔离：A 已 claim 的 delivery_id，B 在同 delivery_id 仍能 claim（复合主键含 tenant_id）', () => {
      const delivery = 'delivery-shared';
      assert.equal(new GithubDraftStore(db, 'tenant_A').claimWebhookEvent(delivery, 'issue_comment', 1000), true);
      assert.equal(
        new GithubDraftStore(db, 'tenant_B').claimWebhookEvent(delivery, 'issue_comment', 1000),
        true,
        'B 与 A 复合主键不同（tenant_id 在键内），B 独立抢到',
      );
    });
  });
});
