/**
 * 单元测试：OnboardingV2Service — W2.1 agent governance 引导
 *
 * 验收对应 PRD 的硬性条件：
 *  3) 步骤生存性 — 重新读取 session 跳到正确步骤
 *  6) 关键路径无 LLM — service 完全不持有 LLM 句柄
 *  7) 合成 invocation 标记 — onboarding_synthetic_invocations 副表正确写入
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { OnboardingV2Service } from '../../onboarding/onboarding-v2-service.js';

const TENANT = 'tenant-test';
const USER = 'user-test';

function seedUser(db: IDatabase, userId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, 'member', ?, ?, ?)`,
  ).run(userId, `${userId}@test.example`, 'unused-hash', TENANT, now, now);
}

describe('OnboardingV2Service', () => {
  let db: IDatabase;
  let svc: OnboardingV2Service;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedUser(db, USER);
    svc = new OnboardingV2Service(db);
  });

  describe('start()', () => {
    it('创建会话并返回 step=1', () => {
      const session = svc.start(TENANT, USER);
      assert.equal(session.currentStep, 1);
      assert.equal(session.userId, USER);
      assert.equal(session.organizationId, null);
      assert.equal(session.resumed, false);
      assert.ok(session.id.startsWith('onb_'));
    });

    it('同一用户重复调用返回同一会话 (idempotent)', () => {
      const first = svc.start(TENANT, USER);
      const second = svc.start(TENANT, USER);
      assert.equal(second.id, first.id);
      assert.equal(second.resumed, true);
    });

    it('已完成的会话不会被复用', () => {
      const first = svc.start(TENANT, USER);
      svc.complete(first.id, TENANT, USER);
      const second = svc.start(TENANT, USER);
      assert.notEqual(second.id, first.id);
    });
  });

  describe('step 推进与生存性', () => {
    it('step 1 → 2: organization 绑定后 current_step 变为 2', () => {
      const session = svc.start(TENANT, USER);
      const after = svc.recordOrganizationStep(session.id, TENANT, 'org_abc');
      assert.equal(after.currentStep, 2);
      assert.equal(after.organizationId, 'org_abc');
    });

    it('step 2 顺序约束：未完成 step 1 不能直接进 step 2', () => {
      const session = svc.start(TENANT, USER);
      assert.throws(
        () => svc.recordAgentStep(session.id, TENANT, 'agent_abc'),
        /step 1/,
      );
    });

    it('完整 5 步推进，每步 getActiveByUser 能 resume 到正确位置', () => {
      const s0 = svc.start(TENANT, USER);
      svc.recordOrganizationStep(s0.id, TENANT, 'org_1');
      const r1 = svc.getActiveByUser(TENANT, USER);
      assert.equal(r1?.currentStep, 2);

      svc.recordAgentStep(s0.id, TENANT, 'agent_1');
      const r2 = svc.getActiveByUser(TENANT, USER);
      assert.equal(r2?.currentStep, 3);

      svc.recordPolicyStep(s0.id, TENANT);
      const r3 = svc.getActiveByUser(TENANT, USER);
      assert.equal(r3?.currentStep, 4);

      svc.recordSyntheticStep(s0.id, TENANT, []);
      const r4 = svc.getActiveByUser(TENANT, USER);
      assert.equal(r4?.currentStep, 5);
    });
  });

  describe('合成 invocation 标记', () => {
    it('recordSyntheticStep 写入 onboarding_synthetic_invocations', () => {
      const session = svc.start(TENANT, USER);
      svc.recordOrganizationStep(session.id, TENANT, 'org_1');
      svc.recordAgentStep(session.id, TENANT, 'agent_1');
      svc.recordPolicyStep(session.id, TENANT);

      /* 模拟 3 行 tool_invocations 已写入；service 只负责标记 */
      const invIds = ['tinv_a', 'tinv_b', 'tinv_c'];
      const now = Date.now();
      for (const id of invIds) {
        db.prepare(
          `INSERT INTO tool_invocations
             (id, tenant_id, persona_id, tool_id, invoker_type, invoker_id,
              status, input_hash, output_size_bytes, duration_ms, invoked_at)
           VALUES (?, ?, ?, ?, 'internal', ?, 'success', 'fake', 0, 0, ?)`,
        ).run(id, TENANT, 'agent_1', 'github.read_issues', USER, now);
      }

      svc.recordSyntheticStep(session.id, TENANT, invIds);

      const rows = db.prepare<{ invocation_id: string }>(
        'SELECT invocation_id FROM onboarding_synthetic_invocations WHERE session_id = ?',
      ).all(session.id);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map(r => r.invocation_id).sort(), invIds.sort());
    });

    it('buildSyntheticInvocations 返回 3 行 (success/pending_confirmation/denied_permission)', () => {
      const drafts = svc.buildSyntheticInvocations('agent_1', USER);
      assert.equal(drafts.length, 3);
      assert.deepEqual(
        drafts.map(d => d.status),
        ['success', 'pending_confirmation', 'denied_permission'],
      );
      /* denied 行必须带 errorMessage，否则前端无法解释为什么拒绝 */
      assert.ok(drafts[2].errorMessage);
    });
  });

  describe('complete() / skip()', () => {
    it('complete 写入 users.onboarded_at', () => {
      const session = svc.start(TENANT, USER);
      svc.complete(session.id, TENANT, USER);
      assert.equal(svc.hasOnboarded(USER), true);
    });

    it('skip 同样写入 users.onboarded_at 但不标记 session 完成', () => {
      const session = svc.start(TENANT, USER);
      svc.skip(session.id, TENANT, USER);
      assert.equal(svc.hasOnboarded(USER), true);
      /* session 本身仍保留 completed_at = null —— PM 漏斗分析需要这个差异 */
      const row = db.prepare<{ completed_at: number | null }>(
        'SELECT completed_at FROM onboarding_sessions WHERE id = ?',
      ).get(session.id);
      assert.equal(row?.completed_at, null);
    });
  });
});
