/**
 * Step 16d — PersonaMarketplaceService extraction tests.
 *
 * Final cut of the Step 16 split. Tests cover the highest-value
 * extracted flows: publishTask + acceptTask + completeTask round
 * trip, applyToTask, assignTask, and facade behaviour equivalence
 * through the same lifecycle.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { pcoreCmdCompleteMarketplaceTask, pcoreCmdReopenMarketplaceTask } from '@chrono/kernel';

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
    displayName: 'Marketplace Test',
    profile: {},
  });

  return { db, service, personaId: persona.id, tenantId, ownerUserId };
}

describe('PersonaMarketplaceService (Step 16d extraction)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setup();
  });

  it('publishTask + listMarketplaceTasks round-trips through the facade', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Test task',
      description: 'A test task description',
      category: 'writing',
      reward: 100,
    });
    assert.ok(task);
    assert.equal(task.title, 'Test task');
    assert.equal(task.status, 'open');

    const all = fx.service.listMarketplaceTasks(fx.tenantId);
    assert.ok(all.some((t) => t.id === task.id));

    const byId = fx.service.getMarketplaceTaskById(fx.tenantId, task.id);
    assert.deepEqual(byId, task);
  });

  it('acceptTask transitions task status + writes a task memory', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Accept me',
      description: 'desc',
      category: 'general',
      reward: 50,
    });
    const accepted = fx.service.acceptTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(accepted);
    assert.equal(accepted?.status, 'accepted');
    assert.equal(accepted?.assigneePersonaId, fx.personaId);

    /* The memory write should be visible. */
    const mems = fx.service.listPersonaMemories(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.ok(mems?.some((m) => m.kind === 'task'));
  });

  it('并发完成同一任务不得重复结算（审计 P1：状态迁移 CAS）', () => {
    /* 服务层在**事务外**读任务并判 `status !== 'accepted'`，两个并发调用会都读到
     * 'accepted' 并都通过判定。真正的互斥点必须在 SQL 上：
     * `UPDATE ... WHERE ... AND status = 'accepted'`。
     *
     * 实测（无 CAS 时）：reward=100 的任务交错完成两次 → 钱包 90 变 **180**。
     * 这里直接驱动执行器模拟交错，验证第二次 rowsAffected=0（调用方据此中止）。 */
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'CAS', description: 'd', category: 'general', reward: 100,
    });
    fx.service.acceptTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });

    const now = Date.now();
    const claimOnce = (): number => fx.db.execute(pcoreCmdCompleteMarketplaceTask({
      tenantId: fx.tenantId, taskId: task.id, qualityScore: 0.9, growthDelta: 1, now,
    })).rowsAffected;

    assert.equal(claimOnce(), 1, '第一次应抢到状态迁移');
    assert.equal(claimOnce(), 0, '第二次必须抢不到（否则可重复结算）');
  });

  it('completeTask 二次调用返回 null 且不再加钱', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'Twice', description: 'd', category: 'general', reward: 100,
    });
    fx.service.acceptTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    const first = fx.service.completeTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id, qualityScore: 0.9,
    });
    assert.ok(first, '首次完成应成功');
    const balanceAfterFirst = first!.wallet.balance;

    const second = fx.service.completeTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id, qualityScore: 0.9,
    });
    assert.equal(second, null, '二次完成必须返回 null');

    const detail = fx.service.getPersonaDetail(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    assert.equal(detail.wallet?.balance, balanceAfterFirst, '余额不得因二次调用增加');
  });

  it('completeTask awards growth + drops task into completed state', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Complete me',
      description: 'desc',
      category: 'general',
      reward: 200,
    });
    fx.service.acceptTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    const before = fx.service.getPersonaDetail(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    const completed = fx.service.completeTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      qualityScore: 0.9,
      ownerTrainingHours: 2,
    });
    assert.ok(completed);
    assert.equal(completed?.task.status, 'completed');
    /* growthIndex should rise post-completion. */
    assert.ok(completed!.persona.growthIndex > before.growthIndex);
  });

  it('acceptTask returns null when persona is not active', () => {
    fx.service.markDeceased(fx.tenantId, fx.ownerUserId, fx.personaId, 'test');
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Cannot accept',
      description: 'desc',
      category: 'general',
      reward: 10,
    });
    const result = fx.service.acceptTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.equal(result, null);
  });

  it('applyToTask + assignTask round-trip via the facade', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Apply then assign',
      description: 'desc',
      category: 'general',
      reward: 30,
    });
    const application = fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(application);
    assert.equal(application?.status, 'submitted');

    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(assignment);
    assert.equal(assignment?.status, 'assigned');
    assert.equal(assignment?.personaId, fx.personaId);
  });

  it('listTaskApplicants 列工单的 persona 申请者（含 personaName，ADR-0058）', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'task with applicants',
      description: 'desc',
      category: 'general',
      reward: 50,
    });
    /* 申请前：无申请者。 */
    assert.equal(fx.service.listTaskApplicants(fx.tenantId, task.id).length, 0);
    /* persona 申请。 */
    fx.service.applyToTask({ tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, personaId: fx.personaId, taskId: task.id });
    const applicants = fx.service.listTaskApplicants(fx.tenantId, task.id);
    assert.equal(applicants.length, 1, '1 个 persona 申请者');
    assert.equal(applicants[0]!.personaId, fx.personaId);
    assert.equal(applicants[0]!.status, 'submitted');
    /* personaName 来自 persona_core.display_name（join），发布者据此选委派。 */
    assert.ok(applicants[0]!.personaName, '带 persona display_name');
  });

  it('验收 CAS 抢占失败时必须整体回滚（不得留下 accepted 的 result/assignment）', () => {
    /* ⚠️ 这条防的是**我自己第一版修复引入的**缺陷：
     * `IDatabase.transaction()` 只在回调**抛异常**时 ROLLBACK，提前 `return`
     * 会照常 COMMIT（已实测：回调里先 INSERT 再 return，行数仍为 1）。
     * 而 acceptSubmittedTask 在 CAS **之前**已写了 acceptTaskResult /
     * acceptTaskAssignment 两条 —— 靠 return 退出会把它们留在库里，
     * 造成「result/assignment 是 accepted，任务却没 completed 也没结算」。
     * 故 CAS 失败必须**抛哨兵异常**让事务整体回滚。 */
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'CAS rollback', description: 'd', category: 'general', reward: 100,
    });
    fx.service.applyToTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    assert.ok(assignment);
    fx.service.submitTaskResult({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id,
      assignmentId: assignment!.id, resultUri: 's3://t/r', evaluation: { quality: 0.9 },
    });

    /* 制造 CAS 必败：抢先把任务推进到 completed（模拟并发对手先赢）。 */
    fx.db.execute(pcoreCmdCompleteMarketplaceTask({
      tenantId: fx.tenantId, taskId: task.id, qualityScore: 0.5, growthDelta: 0, now: Date.now(),
    }));

    const accepted = fx.service.acceptSubmittedTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId,
      taskId: task.id, clientRating: 5, qualityScore: 0.9,
    });
    assert.equal(accepted, null, 'CAS 失败应返回 null');

    const asgRow = fx.db.prepare<{ status: string }>(
      'SELECT status FROM task_assignments WHERE id = ?',
    ).all(assignment!.id)[0];
    const resRow = fx.db.prepare<{ status: string }>(
      'SELECT status FROM task_results WHERE assignment_id = ?',
    ).all(assignment!.id)[0];
    assert.equal(asgRow?.status, 'submitted', 'assignment 不得被留在 accepted');
    assert.equal(resRow?.status, 'submitted', 'result 不得被留在 accepted');
  });

  it('已付款（completed）的任务不得被 reopen 退回市场（审计 P1：accept/reject 竞态）', () => {
    /* 独立审查发现：`acceptSubmittedTask` 与 `rejectSubmittedTask` 都只在事务外判
     * `assignment.status !== 'submitted'`，两者可同时通过。accept 侧完成 CAS、
     * **付了钱**、任务变 completed 后，reject 侧的 `REOPEN_MARKETPLACE_TASK`
     * （原本无谓词）会把已付款任务重新置为 open 并清空 assignee
     * ⇒ 钱已付出、任务重回市场可被再次承接。
     * 实测（修复前）：结算记录=1 的任务 reopen 后 status 变回 'open'。 */
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'Paid', description: 'd', category: 'general', reward: 100,
    });
    fx.service.applyToTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    fx.service.submitTaskResult({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id,
      assignmentId: assignment!.id, resultUri: 's3://t/r', evaluation: { quality: 0.9 },
    });
    const accepted = fx.service.acceptSubmittedTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId,
      taskId: task.id, clientRating: 5, qualityScore: 0.9,
    });
    assert.ok(accepted, '验收应成功并付款');

    /* 模拟并发 reject 侧随后执行 reopen —— 必须无效。 */
    const reopened = fx.db.execute(pcoreCmdReopenMarketplaceTask({
      tenantId: fx.tenantId, taskId: task.id, now: Date.now(),
    }));
    assert.equal(reopened.rowsAffected, 0, '已付款任务的 reopen 必须抢不到（rowsAffected=0）');

    const after = fx.service.getMarketplaceTaskById(fx.tenantId, task.id);
    assert.equal(after?.status, 'completed', '任务必须仍是 completed，不得退回 open');
  });

  it('零/负奖励任务从源头拒绝发布（审计 P1：消除特殊情况而非逐个入口打补丁）', () => {
    /* 背景：API 曾允许 `reward = 0`（`z.number().min(0)`），而结算路径有
     * `totalAmountMinor <= 0 → return null`。我第一版只在 acceptSubmittedTask
     * 前置拒绝，**漏了 completeTask** —— 独立审查实测：`completeTask(reward=0)`
     * 仍能把任务推到 completed 且零结算记录（它走 wallet 直更、不产生结算行）。
     *
     * 逐个入口打补丁必然漏，故在**源头**消灭这类任务：零奖励任务不存在，
     * 两个完成入口就都不必特判。 */
    assert.throws(
      () => fx.service.publishTask({
        tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
        title: 'Zero', description: 'd', category: 'general', reward: 0,
      }),
      /奖励必须为正数/,
      'reward=0 必须在发布时就被拒绝',
    );
    assert.throws(
      () => fx.service.publishTask({
        tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
        title: 'Negative', description: 'd', category: 'general', reward: -5,
      }),
      /奖励必须为正数/,
      '负奖励同样必须被拒绝',
    );
    /* 对照：正常奖励仍可发布（避免「一律抛错」的假通过）。 */
    const ok = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'Normal', description: 'd', category: 'general', reward: 10,
    });
    assert.equal(ok.reward, 10);
  });

  it('submitTaskResult + acceptSubmittedTask round-trips through the facade', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Submit + accept',
      description: 'desc',
      category: 'general',
      reward: 50,
    });
    const application = fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(application);
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(assignment);

    const result = fx.service.submitTaskResult({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: 's3://test/result',
      evaluation: { quality: 0.85 },
    });
    assert.ok(result);
    assert.equal(result?.status, 'submitted');

    const accepted = fx.service.acceptSubmittedTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      taskId: task.id,
      clientRating: 5,
      qualityScore: 0.9,
    });
    assert.ok(accepted);
    assert.equal(accepted?.result.status, 'accepted');
    assert.equal(accepted?.task.status, 'completed');
  });

  it('rejectSubmittedTask transitions result to rejected', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Reject me',
      description: 'desc',
      category: 'general',
      reward: 20,
    });
    fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    fx.service.submitTaskResult({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: 's3://test/result',
      evaluation: {},
    });

    const rejected = fx.service.rejectSubmittedTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      taskId: task.id,
      reason: 'quality too low',
    });
    assert.ok(rejected);
    assert.equal(rejected?.result.status, 'rejected');
    assert.equal(rejected?.result.rejectionReason, 'quality too low');
  });

  it('disputeTask opens a governance case via the facade governance hook', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Disputed',
      description: 'desc',
      category: 'general',
      reward: 40,
    });
    fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    fx.service.submitTaskResult({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: 's3://test/result',
      evaluation: {},
    });

    const disputed = fx.service.disputeTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      taskId: task.id,
      reason: 'output does not match requirements',
    });
    assert.ok(disputed);
    assert.ok(disputed!.governanceCase);
    assert.equal(disputed!.governanceCase.triggerType, 'task_dispute');
    /* The dispute should also surface via listGovernanceCases. */
    const cases = fx.service.listGovernanceCases(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.ok(cases?.some((c) => c.id === disputed!.governanceCase.id));
  });

  it('recoverTimedOutRuntimeSessions returns the counter shape worker callers expect', () => {
    /* Even with no timed-out sessions, the contract is:
     * { scanned: number, recovered: number, timedOut: number, shardErrors: {shard,error}[] }
     * The runtime-recovery worker reads all four fields, so the
     * shape must stay locked in across the cross-tenant fan-out (#3 Task 2). */
    const result = fx.service.recoverTimedOutRuntimeSessions({
      now: Date.now(),
      sessionTimeoutMs: 60_000,
      maxRetries: 3,
      limit: 10,
    });
    assert.equal(typeof result.scanned, 'number');
    assert.equal(typeof result.recovered, 'number');
    assert.equal(typeof result.timedOut, 'number');
    assert.ok(Array.isArray(result.shardErrors));
    /* No sessions exist → all counters 0, single healthy shard → no shardErrors. */
    assert.equal(result.scanned, 0);
    assert.deepEqual(result.shardErrors, []);
  });

  it('publishTask + getMarketplaceTaskById are byte-equal across the facade pass-through', () => {
    /* The facade delegates to marketplaceService.publishTask, and
     * getMarketplaceTaskById delegates to marketplaceService too —
     * verify that round-tripping through both delegations preserves
     * the task object byte-for-byte. */
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Byte-equal',
      description: 'desc',
      category: 'general',
      reward: 80,
    });
    const reread = fx.service.getMarketplaceTaskById(fx.tenantId, task.id);
    assert.deepEqual(reread, task);
  });

  /* ── 审计 Warning #10 / #11：结算的币种与零分项 ────────────────── */

  /** 建一条走到「已指派」的任务，供结算用例复用。 */
  function assignedTask(): { taskId: string; assignmentId: string } {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'Settle', description: 'settle target', category: 'operations', reward: 100,
    });
    assert.ok(fx.service.applyToTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id, personaId: fx.personaId,
    }));
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId: task.id, personaId: fx.personaId,
    });
    assert.ok(assignment);
    return { taskId: task.id, assignmentId: assignment!.id };
  }

  it('审计 W#10：结算币种与钱包不一致必须拒绝（不得改写钱包币种）', () => {
    /* ⚠️ 修复前：`SET ... currency = ?` 无条件用入参覆盖钱包币种。实测 CRED 钱包收到
     * 一笔 currency:'USD' 的结算后变成 USD、余额 160 —— 把两种货币的金额直接相加，
     * 账目从此不可信，且**全程无报错**。结算不是货币兑换，唯一正确动作是拒绝。 */
    const { taskId, assignmentId } = assignedTask();
    const before = fx.service.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(before?.currency, 'CRED', '前置：钱包默认 CRED');

    const settled = fx.service.settleTaskPayment({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId, assignmentId,
      totalAmountMinor: 10_000, currency: 'USD',
      split: { ownerPct: 60, personaPct: 20, platformPct: 20 },
    });
    assert.equal(settled, null, '币种不一致必须拒绝');

    const after = fx.service.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(after?.currency, 'CRED', '钱包币种不可变');
    assert.equal(after?.balance, before?.balance, '拒绝路径不得动账');
    const rows = fx.db.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM wallet_transactions WHERE wallet_id = ?',
    ).all(after!.id);
    assert.equal(rows[0]?.c, 0, '拒绝路径不得留下任何流水');
  });

  it('审计 W#10 对照：币种一致时结算照常成功（别把功能一起拒掉）', () => {
    const { taskId, assignmentId } = assignedTask();
    const settled = fx.service.settleTaskPayment({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId, assignmentId,
      totalAmountMinor: 10_000, currency: 'CRED',
      split: { ownerPct: 60, personaPct: 20, platformPct: 20 },
    });
    assert.ok(settled, '币种一致必须成功');
    const wallet = fx.service.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(wallet?.currency, 'CRED');
    assert.ok((wallet?.balance ?? 0) > 0, '余额应已入账');
  });

  it('审计 W#11：零分成结算必须成功，且只写非零分项的流水', () => {
    /* ⚠️ 修复前：钱包写入门只接受**正整数** amountMinor，零分项送进 `-0` 会抛
     * 「amountMinor must be a positive integer」→ **整笔结算回滚**。
     * 实测两个合法输入都被打回、流水 0 条：platformPct=0（免抽成活动）、
     * 1 分钱按 60/20/20 拆分（floor 后分项为 0）。
     * 零分项在账目上本就没有发生，跳过即可；分账守恒不受影响。 */
    const { taskId, assignmentId } = assignedTask();
    const settled = fx.service.settleTaskPayment({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId, assignmentId,
      totalAmountMinor: 10_000, currency: 'CRED',
      split: { ownerPct: 60, personaPct: 40, platformPct: 0 },
    });
    assert.ok(settled, 'platformPct=0 是合法输入，必须成功');
    assert.equal(settled!.platformAmountMinor, 0);
    assert.equal(
      settled!.ownerAmountMinor + settled!.personaAmountMinor + settled!.platformAmountMinor,
      settled!.totalAmountMinor,
      '分账守恒：三项之和等于总额',
    );

    const rows = fx.db.prepare<{ transaction_type: string }>(
      'SELECT transaction_type FROM wallet_transactions WHERE reference_id = ?',
    ).all(settled!.id);
    assert.equal(rows.length, 2, '只写 task_payment + persona_reserve 两条（platform_fee 为零，跳过）');
    assert.ok(!rows.some((r) => r.transaction_type === 'platform_fee'), '不得写零金额的 platform_fee');
  });

  it('审计 W#11：1 分钱任务（floor 后出现零分项）同样必须成功', () => {
    const { taskId, assignmentId } = assignedTask();
    const settled = fx.service.settleTaskPayment({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId, assignmentId,
      totalAmountMinor: 1, currency: 'CRED',
      split: { ownerPct: 60, personaPct: 20, platformPct: 20 },
    });
    assert.ok(settled, '1 分钱是合法金额，不得整单回滚');
    /* floor 后 owner/persona 均为 0，余数归 platform —— 守恒仍成立。 */
    assert.equal(
      settled!.ownerAmountMinor + settled!.personaAmountMinor + settled!.platformAmountMinor,
      1,
    );
  });
});
