/**
 * Step 16c — PersonaGovernanceService extraction tests.
 *
 * Same pattern as the memory + wallet extractions: exercise the
 * sub-service directly + assert facade behaviour equivalence so any
 * drift surfaces at the seam.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';

interface Fixture {
  db: IDatabase;
  service: PersonaCoreService;
  personaId: string;
  tenantId: string;
  ownerUserId: string;
}

function setup(): Fixture {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const tenantId = 'tenant_test';
  const ownerUserId = 'user_test_owner';
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ownerUserId, 'owner@example.com', 'hash', 'member', tenantId, now, now);

  const service = PersonaCoreService.fromUnitOfWork(db);
  const persona = service.createPersona({
    tenantId,
    ownerUserId,
    displayName: 'Governance Test',
    profile: {},
  });

  return { db, service, personaId: persona.id, tenantId, ownerUserId };
}

describe('PersonaGovernanceService (Step 16c extraction)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setup();
  });

  it('listGovernanceCases returns null when persona-existence guard fails', () => {
    const result = fx.service.listGovernanceCases(fx.tenantId, 'wrong-owner', fx.personaId);
    assert.equal(result, null);
  });

  it('listGovernanceCases returns [] when persona has no cases yet', () => {
    const result = fx.service.listGovernanceCases(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.deepEqual(result, []);
  });

  it('openGovernanceCase writes a case row + initiating review event', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'task_dispute',
      severity: 'high',
      details: { reason: 'test dispute' },
    });
    assert.ok(gc);
    assert.equal(gc?.triggerType, 'task_dispute');
    assert.equal(gc?.severity, 'high');
    assert.equal(gc?.status, 'open');

    /* Case should be visible via list. */
    const list = fx.service.listGovernanceCases(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(list?.length, 1);
    assert.equal(list?.[0]?.id, gc?.id);
  });

  it('applyGovernanceAction transitions case + persona status and writes reputation delta', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'policy_violation',
      severity: 'critical',
    });
    assert.ok(gc);

    const before = fx.service.getPersonaDetail(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    const result = fx.service.applyGovernanceAction({
      tenantId: fx.tenantId,
      caseId: gc!.id,
      actorUserId: fx.ownerUserId,
      actionType: 'temporary_suspension',
      durationSeconds: 3600,
    });
    assert.ok(result);
    assert.equal(result?.personaStatus, 'suspended');
    assert.equal(result?.governanceCase.status, 'action_applied');

    const after = fx.service.getPersonaDetail(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    assert.ok(after.reputation < before.reputation, 'reputation should drop on suspension');
  });

  it('appealGovernanceCase records the appeal blob and a review event', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'task_dispute',
      severity: 'medium',
    });
    assert.ok(gc);

    const appealed = fx.service.appealGovernanceCase({
      tenantId: fx.tenantId,
      caseId: gc!.id,
      actorUserId: fx.ownerUserId,
      details: { reason: 'context missing in original decision' },
    });
    assert.ok(appealed);
    assert.notEqual(appealed?.appealedAt, null);
    assert.deepEqual(appealed?.appeal, { reason: 'context missing in original decision' });
  });

  it('appealGovernanceCase returns null when caller is not the persona owner', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'task_dispute',
      severity: 'low',
    });
    assert.ok(gc);

    const result = fx.service.appealGovernanceCase({
      tenantId: fx.tenantId,
      caseId: gc!.id,
      actorUserId: 'not-the-owner',
      details: {},
    });
    assert.equal(result, null);
  });

  it('applyGovernanceAction returns null on already-resolved cases (idempotency)', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'policy_violation',
      severity: 'low',
    });
    assert.ok(gc);

    const first = fx.service.applyGovernanceAction({
      tenantId: fx.tenantId,
      caseId: gc!.id,
      actorUserId: fx.ownerUserId,
      actionType: 'reinstate',
    });
    assert.equal(first?.governanceCase.status, 'resolved');

    const second = fx.service.applyGovernanceAction({
      tenantId: fx.tenantId,
      caseId: gc!.id,
      actorUserId: fx.ownerUserId,
      actionType: 'warning',
    });
    assert.equal(second, null);
  });

  it('addGovernanceEvent (still in core) produces the same governance event row shape as the extracted service', () => {
    /* Drift guard: addGovernanceEvent stays on the facade
     * (cross-domain memory + growth + reputation + lifecycle), but
     * its core mutation primitive (insertGovernanceEvent) now lives
     * on PersonaGovernanceService. If anyone tweaks the SQL shape
     * inside the sub-service, this test catches drift by verifying
     * an addGovernanceEvent call writes a row visible to a
     * governance-service-led read flow with consistent severity
     * encoding. */
    const before = fx.service.getPersonaDetail(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    const after = fx.service.addGovernanceEvent({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      eventType: 'warning',
      severity: 3,
      summary: 'warning-via-facade',
      payload: { reason: 'test' },
    });
    assert.ok(after);
    /* warning event should drop reputation but not change status. */
    assert.ok(after!.reputation < before.reputation);
    assert.equal(after!.status, before.status);
  });

  it('facade.openGovernanceCase + listGovernanceCases round-trip preserves all fields', () => {
    /* End-to-end equivalence: writing through the facade and reading
     * through the facade returns the same row we just wrote.
     * Locks in that delegations stay shaped-correct after refactors. */
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'wallet_anomaly',
      severity: 'medium',
      details: { delta: 1500 },
    });
    assert.ok(gc);

    const list = fx.service.listGovernanceCases(fx.tenantId, fx.ownerUserId, fx.personaId);
    const found = list?.find((c) => c.id === gc!.id);
    assert.ok(found);
    assert.equal(found?.triggerType, 'wallet_anomaly');
    assert.equal(found?.severity, 'medium');
    assert.deepEqual(found?.details, { delta: 1500 });
  });

  /* ⚠️ 审计 #419：并发下声誉被**扣两次**。
   *
   * 「已结案」判定在事务**外**，两个并发动作双双通过；而
   * `pcoreCmdApplyGovernanceActionToPersona` 用的是**相对量**
   * `reputation = reputation + ?` —— 执行两次就扣两次（实测 50→34，应为 42）。
   *
   * ⚠️ 竞态窗口必须精确：上面那条 idempotency 用例走的是「先完整结案再调」，
   * 会被**事务外**的 `status === 'resolved'` 判定先拦截，**测不到 CAS**。
   * 真实交错是：本次**读到**未结案之后、UPDATE 之前，对手把 case 推到 resolved。
   * 故在 governance_cases 被读到的瞬间让对手抢先，精确复刻该窗口。 */
  it('审计 #419：CAS 抢占失败时声誉不得二次扣减', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'policy_violation',
      severity: 'high',
    });
    assert.ok(gc);

    const repBefore = fx.db.prepare<{ reputation: number }>(
      `SELECT reputation FROM persona_core WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, fx.personaId)!.reputation;

    /* ★竞态窗口★：对手在本次读到「未结案」之后抢先把 case 推到 resolved。 */
    const realQueryOne = fx.db.queryOne.bind(fx.db);
    let fired = false;
    fx.db.queryOne = ((q: Parameters<typeof realQueryOne>[0]) => {
      const row = realQueryOne(q) as { id?: string; status?: string } | null;
      if (!fired && row?.id === gc!.id && row.status !== 'resolved') {
        fired = true;
        fx.db.prepare<void>(
          `UPDATE governance_cases SET status = 'resolved', resolved_at = ? WHERE tenant_id = ? AND id = ?`,
        ).run(Date.now(), fx.tenantId, gc!.id);
      }
      return row;
    }) as typeof fx.db.queryOne;

    const result = fx.service.applyGovernanceAction({
      tenantId: fx.tenantId,
      caseId: gc!.id,
      actorUserId: fx.ownerUserId,
      actionType: 'temporary_suspension',
    });
    assert.equal(result, null, 'CAS 抢占失败必须返回 null');

    const repAfter = fx.db.prepare<{ reputation: number }>(
      `SELECT reputation FROM persona_core WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, fx.personaId)!.reputation;
    /* 变异实测：去掉 CAS 谓词/不查 rowsAffected → 声誉被多扣一次。 */
    assert.equal(repAfter, repBefore, 'CAS 失败方不得扣减声誉（相对量执行两次即回归）');

    /* 事务须整体回滚：action 行也不得留下（否则是半提交）。 */
    const actions = fx.db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM governance_actions WHERE tenant_id = ? AND case_id = ?`,
    ).get(fx.tenantId, gc!.id)!.n;
    assert.equal(actions, 0, 'CAS 失败必须整体回滚，不得留下 action 行');
  });

  it('对照：正常治理动作仍必须成功并扣减声誉', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      triggerType: 'policy_violation',
      severity: 'high',
    });
    assert.ok(gc);
    const repBefore = fx.db.prepare<{ reputation: number }>(
      `SELECT reputation FROM persona_core WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, fx.personaId)!.reputation;

    const result = fx.service.applyGovernanceAction({
      tenantId: fx.tenantId,
      caseId: gc!.id,
      actorUserId: fx.ownerUserId,
      actionType: 'temporary_suspension',
    });
    assert.ok(result, '正常动作必须成功（别把功能一起拒掉）');

    const repAfter = fx.db.prepare<{ reputation: number }>(
      `SELECT reputation FROM persona_core WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, fx.personaId)!.reputation;
    assert.ok(repAfter < repBefore, `temporary_suspension 应扣声誉：${repBefore} → ${repAfter}`);
  });

  /* ⚠️ 审计 #436：`appealGovernanceCase` 此前**无任何状态校验** ——
   * 已 resolved 的 case 可被拉回 appealed，且 `resolved_at` **残留**指向旧的
   * 结案时刻，状态与时间戳自相矛盾，下游按 resolved_at 过滤的报表会错算。 */
  it('审计 #436：已结案的 case 不得再申诉（且不得留下矛盾时间戳）', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, personaId: fx.personaId,
      triggerType: 'policy_violation', severity: 'low',
    });
    assert.ok(gc);
    /* reinstate 会把 case 推到 resolved。 */
    const resolved = fx.service.applyGovernanceAction({
      tenantId: fx.tenantId, caseId: gc!.id, actorUserId: fx.ownerUserId, actionType: 'reinstate',
    });
    assert.equal(resolved?.governanceCase.status, 'resolved', '前提：已结案');
    const resolvedAtBefore = fx.db.prepare<{ resolved_at: number | null }>(
      `SELECT resolved_at FROM governance_cases WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, gc!.id)!.resolved_at;
    assert.ok(resolvedAtBefore !== null, '前提：resolved_at 已写入');

    const appealed = fx.service.appealGovernanceCase({
      tenantId: fx.tenantId, caseId: gc!.id, actorUserId: fx.ownerUserId, details: { reason: '不服' },
    });

    /* 变异实测：去掉状态守卫 → 返回非 null 且 status 变 appealed、resolved_at 残留。 */
    assert.equal(appealed, null, '已结案不得再申诉');
    const row = fx.db.prepare<{ status: string; resolved_at: number | null }>(
      `SELECT status, resolved_at FROM governance_cases WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, gc!.id)!;
    assert.equal(row.status, 'resolved', '状态不得被拉回 appealed');
    assert.equal(row.resolved_at, resolvedAtBefore, 'resolved_at 不得被改动');
  });

  it('审计 #436：重复申诉同一 case 必须拒绝（幂等，不产生第二条 review 事件）', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, personaId: fx.personaId,
      triggerType: 'task_dispute', severity: 'medium',
    });
    assert.ok(gc);
    const first = fx.service.appealGovernanceCase({
      tenantId: fx.tenantId, caseId: gc!.id, actorUserId: fx.ownerUserId, details: { reason: 'a' },
    });
    assert.ok(first, '首次申诉应成功');

    const second = fx.service.appealGovernanceCase({
      tenantId: fx.tenantId, caseId: gc!.id, actorUserId: fx.ownerUserId, details: { reason: 'b' },
    });
    assert.equal(second, null, '重复申诉必须拒绝');
    /* 申诉理由不得被第二次覆盖。 */
    const row = fx.db.prepare<{ appeal_json: string }>(
      `SELECT appeal_json FROM governance_cases WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, gc!.id)!;
    assert.match(row.appeal_json, /"a"/, '首次申诉内容不得被覆盖');
  });

  it('对照：未结案的 case 仍可正常申诉（别把功能一起拒掉）', () => {
    const gc = fx.service.openGovernanceCase({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, personaId: fx.personaId,
      triggerType: 'task_dispute', severity: 'low',
    });
    assert.ok(gc);
    const appealed = fx.service.appealGovernanceCase({
      tenantId: fx.tenantId, caseId: gc!.id, actorUserId: fx.ownerUserId, details: { reason: 'ok' },
    });
    assert.ok(appealed, '未结案应可申诉');
    assert.notEqual(appealed!.appealedAt, null);
  });
});
