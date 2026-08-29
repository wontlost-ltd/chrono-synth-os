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

  /* ⚠️ 审计 #397：`completeTask` 曾是绕开全部资金防护的**第二条付款路径** ——
   * 直接改 balance，不写 `wallet_transactions`、不写 `wallet_settlements`。
   * 现有 3 个 completeTask 用例**无一断言账本**，故该缺陷零覆盖（变异验证：
   * 把账本写入整段删掉，旧用例全绿）。
   *
   * 判据用**全表不变量**而非单条断言：钱包余额（minor）必须恒等于该钱包
   * 全部流水的净和。这条不变量对「漏写分录」「多写分录」「金额不符」三类
   * 缺陷同时敏感，且不依赖具体分账口径。 */
  it('completeTask 写入账本：余额(minor) == 流水净和（全表不变量）', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'Ledger', description: 'd', category: 'general', reward: 100,
    });
    fx.service.acceptTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    const completed = fx.service.completeTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id, qualityScore: 0.9,
    });
    assert.ok(completed, '完成应成功');

    const walletRow = fx.db.prepare<{ id: string; balance: number }>(
      `SELECT id, balance FROM persona_wallets WHERE tenant_id = ? AND persona_id = ?`,
    ).get(fx.tenantId, fx.personaId);
    assert.ok(walletRow, '钱包应存在');

    const journal = fx.db.prepare<{ n: number; net: number | null }>(
      `SELECT COUNT(*) AS n, SUM(amount_minor) AS net
         FROM wallet_transactions WHERE tenant_id = ? AND wallet_id = ?`,
    ).get(fx.tenantId, walletRow!.id)!;

    /* 先断言「有流水」——否则下面的净和比较在 0 == 0 时会变成重言式恒过。 */
    assert.ok(journal.n > 0, `completeTask 必须写账本分录，实际 ${journal.n} 条`);

    const balanceMinor = Math.round(walletRow!.balance * 100);
    assert.equal(journal.net ?? 0, balanceMinor, '余额(minor) 必须等于流水净和');

    /* 结算行是两条付款路径的**共同幂等锚**（#398），必须落库。 */
    const settlements = fx.db.prepare<{ n: number; total: number | null }>(
      `SELECT COUNT(*) AS n, SUM(total_amount_minor) AS total
         FROM wallet_settlements WHERE tenant_id = ? AND task_id = ?`,
    ).get(fx.tenantId, task.id)!;
    assert.equal(settlements.n, 1, 'completeTask 必须写且只写一条结算行');
    assert.equal(settlements.total, balanceMinor, '结算行金额必须等于实际入账额');
  });

  /* ⚠️ 审计 #398：两条付款路径的幂等锚此前互不相交，
   * 实测 reward=100 的工单经 completeTask + settleTaskPayment 实付 160。
   * 锚统一到 `wallet_settlements` 后，先跑的一方会让另一方短路。 */
  it('completeTask 之后 settleTaskPayment 不得二次付款（幂等锚统一）', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'DoublePay', description: 'd', category: 'general', reward: 100,
    });
    fx.service.acceptTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    const completed = fx.service.completeTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id, qualityScore: 1.0,
    });
    assert.ok(completed, '完成应成功');
    const balanceAfterComplete = completed!.wallet.balance;

    const assignment = fx.db.prepare<{ id: string }>(
      `SELECT id FROM task_assignments WHERE tenant_id = ? AND task_id = ? ORDER BY assigned_at DESC LIMIT 1`,
    ).get(fx.tenantId, task.id);
    assert.ok(assignment, 'assignment 应存在');

    const second = fx.service.settleTaskPayment({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      taskId: task.id,
      assignmentId: assignment!.id,
      totalAmountMinor: 10000,
      currency: 'CRED',
      split: { ownerPct: 60, personaPct: 20, platformPct: 20 },
    });

    const detail = fx.service.getPersonaDetail(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    assert.equal(
      detail.wallet?.balance,
      balanceAfterComplete,
      `第二条路径不得再次付款（实付 ${detail.wallet?.balance}，应为 ${balanceAfterComplete}）`,
    );
    /* 幂等短路应返回既有结算而非新建；无论返回既有还是 null，都不得新增结算行。 */
    const n = fx.db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wallet_settlements WHERE tenant_id = ? AND task_id = ?`,
    ).get(fx.tenantId, task.id)!.n;
    assert.equal(n, 1, `结算行必须恰好 1 条，实际 ${n} 条（second=${second ? 'settlement' : 'null'}）`);
  });

  /* ⚠️ 审计 #397：冻结钱包 / 币种不符必须在**任何写入之前**拒绝。
   * 若放到 CAS 之后，会留下「任务 completed、零结算、余额 0、重试被终态拒绝」的死局。 */
  it('completeTask 对冻结钱包前置拒绝，且任务保持可重试（不落终态）', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'Frozen', description: 'd', category: 'general', reward: 100,
    });
    fx.service.acceptTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      personaId: fx.personaId, taskId: task.id,
    });
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET status = 'frozen' WHERE tenant_id = ? AND persona_id = ?`,
    ).run(fx.tenantId, fx.personaId);

    const result = fx.service.completeTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id, qualityScore: 0.9,
    });
    assert.equal(result, null, '冻结钱包必须拒绝付款');

    const row = fx.db.prepare<{ status: string }>(
      `SELECT status FROM marketplace_tasks WHERE tenant_id = ? AND id = ?`,
    ).get(fx.tenantId, task.id)!;
    assert.notEqual(row.status, 'completed', '拒绝后任务不得停在终态（否则无法补救）');

    const n = fx.db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wallet_transactions WHERE tenant_id = ?`,
    ).get(fx.tenantId)!.n;
    assert.equal(n, 0, '拒绝路径不得留下任何流水');
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

    /* 抛错而非返回 null（独立审查 High-1）：路由把 null 映射成 404「不存在」，
     * 会把币种问题伪装成查无此物；同仓 org-wallet-service 对同一关切也是抛错。 */
    assert.throws(
      () => fx.service.settleTaskPayment({
        tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId, assignmentId,
        totalAmountMinor: 10_000, currency: 'USD',
        split: { ownerPct: 60, personaPct: 20, platformPct: 20 },
      }),
      (err: unknown) => err instanceof Error && /钱包币种不符/.test(err.message),
      '币种不一致必须抛错',
    );

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

  it('⚠️ 审计 W#10 Critical 端到端：验收链不得留下「已完成但没付钱」的任务', () => {
    /* 这条用例存在的理由：我原来只测了 `settleTaskPayment` **直接调用**，
     * 而真实回归发生在 `acceptSubmittedTask` 的**两阶段时序**上 ——
     * 单元测直调结算全绿，真实路径却坏掉。审查正是这样抓到的。
     * 故此处走完整验收链，并断言「不存在已完成却零结算的任务」这一账目不变量。 */
    const task = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'E2E', description: 'accept chain', category: 'operations', reward: 100,
    });
    assert.ok(fx.service.applyToTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: task.id, personaId: fx.personaId,
    }));
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId: task.id, personaId: fx.personaId,
    });
    assert.ok(assignment);
    assert.ok(fx.service.submitTaskResult({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      taskId: task.id, assignmentId: assignment!.id, resultUri: 'https://example.com/r',
    }));

    const accepted = fx.service.acceptSubmittedTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId,
      taskId: task.id, clientRating: 5, qualityScore: 0.9,
    });
    assert.ok(accepted, '验收必须成功');

    /* 账目不变量：completed 的任务必须有结算记录、且钱包真的收到了钱。 */
    const taskRow = fx.db.prepare<{ status: string }>(
      'SELECT status FROM marketplace_tasks WHERE id = ?',
    ).all(task.id)[0];
    assert.equal(taskRow?.status, 'completed');

    const settlements = fx.db.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM wallet_settlements WHERE assignment_id = ?',
    ).all(assignment!.id);
    assert.equal(settlements[0]?.c, 1, 'completed 的任务必须有且仅有一条结算记录（不得「完成却没付钱」）');

    const wallet = fx.service.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.ok((wallet?.balance ?? 0) > 0, '钱包必须真的收到钱');
    assert.equal(wallet?.currency, 'CRED', '钱包币种不得被结算改写');

    /* ⚠️ 关键：还要走一遍**会触发结算失败**的路径，否则这条用例挡不住真正的回归。
     * 我原来的坏版本正是「publishTask 放行非 CRED + 结算处 return null」——
     * 若本用例只发 CRED 任务，就永远走不到那条路径（实测：变异后本用例仍全绿）。
     * 故这里绕过 publishTask 的源头校验直接插一条 USD 任务（模拟**历史脏数据**，
     * 这也是源头校验上线前就已入库的真实形态），再走完整验收链。 */
    const dirtyId = 'mkt_legacy_usd';
    const ts = Date.now();
    fx.db.prepare<void>(
      `INSERT INTO marketplace_tasks (id, tenant_id, publisher_user_id, title, description,
         category, reward, currency, status, published_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(dirtyId, fx.tenantId, fx.ownerUserId, 'legacy USD', 'dirty', 'operations',
      100, 'USD', 'open', ts, ts, ts);
    assert.ok(fx.service.applyToTask({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, taskId: dirtyId, personaId: fx.personaId,
    }));
    const dirtyAsg = fx.service.assignTask({
      tenantId: fx.tenantId, actorUserId: fx.ownerUserId, taskId: dirtyId, personaId: fx.personaId,
    });
    assert.ok(dirtyAsg);
    assert.ok(fx.service.submitTaskResult({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      taskId: dirtyId, assignmentId: dirtyAsg!.id, resultUri: 'https://example.com/r2',
    }));
    /* 币种在**任何写入之前**被判掉 → 返回 null、任务保持 submitted，
     * 与同处的 reward<=0 前置拒绝同款语义（出路是 rejectSubmittedTask 退回重开）。
     * 关键不是「抛错还是 null」，而是**绝不允许**「验收落库、结算没落」的半成品状态。 */
    /* ⚠️ 必须**包住**这次调用：若前置守卫失效，结算侧会抛错，未捕获的异常会让用例
     * 死在这一行，**根本走不到下面的不变量断言** —— 那样最强的那条断言就成了摆设
     * （复审的过程建议）。捕获后继续往下判「有没有留下 completed 孤儿」，
     * 使不变量断言成为真正承重的那一条。 */
    let dirtyAccepted: unknown = 'not-called';
    let dirtyThrew: string | null = null;
    try {
      dirtyAccepted = fx.service.acceptSubmittedTask({
        tenantId: fx.tenantId, actorUserId: fx.ownerUserId,
        taskId: dirtyId, clientRating: 5, qualityScore: 0.9,
      });
    } catch (err) {
      dirtyThrew = err instanceof Error ? err.message : String(err);
    }
    /* 先判**账目不变量**（最强、最该承重的一条），再判返回值语义：
     * 回归的形态是「留下 completed 孤儿」，不是「返回值不对」。 */
    const orphanedAfterDirty = fx.db.prepare<{ c: number }>(
      `SELECT COUNT(*) AS c FROM marketplace_tasks t
        WHERE t.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM wallet_settlements s WHERE s.task_id = t.id)`,
    ).all();
    assert.equal(orphanedAfterDirty[0]?.c, 0,
      `脏数据被拒后不得留下「已完成但零结算」的任务（若抛错：${dirtyThrew ?? '无'}）`);
    assert.equal(dirtyAccepted ?? null, null,
      `历史脏数据（非 CRED）验收必须被拒（若抛错：${dirtyThrew ?? '无'}）`);

    const dirtyRow = fx.db.prepare<{ status: string }>(
      'SELECT status FROM marketplace_tasks WHERE id = ?',
    ).all(dirtyId)[0];
    assert.notEqual(dirtyRow?.status, 'completed',
      '被拒的任务不得被推进到 completed（否则就是「干了活没人付钱」且无法补救）');

    /* ⚠️ 全局不变量（这一段才是真正能挡住「两阶段时序」类回归的断言）：
     * 不允许存在**任何**已 completed 却没有结算记录的任务。 */
    const orphaned = fx.db.prepare<{ c: number }>(
      `SELECT COUNT(*) AS c FROM marketplace_tasks t
        WHERE t.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM wallet_settlements s WHERE s.task_id = t.id)`,
    ).all();
    assert.equal(orphaned[0]?.c, 0, '不得存在「已完成但零结算」的任务（钱没付出去且无法补救）');
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

  it('⚠️ 审计 W#10 Critical：非 CRED 任务必须在 publishTask 就被拒（否则验收后永久卡死）', () => {
    /* 独立审查抓出的**我自己引入的 Critical**：
     *
     * 我第一版只在结算处 `return null`。但验收是「先提交验收事务、再另开事务结算」
     * 的两阶段时序 —— 结算失败时验收**已经落库**。实测（修复前）：
     *   task.status = completed / assignment = accepted / settlement 0 条 /
     *   钱包余额 0 / 重试 accept 仍 null（终态拒绝，**永久卡死无法补救**）
     * 即：persona 干完了活，任务标记完成，**没有人拿到钱**，且无法补救。
     * 这比原本的「静默串币」更糟。
     *
     * 而 persona 钱包**恒为 CRED**（createWallet 的 INSERT 不写 currency 列），
     * 所以「非 CRED 任务」= 永远结算不了的任务。故照 reward<=0 的既有先例
     * （「逐个入口打补丁必然漏，故改在源头消灭这种任务」）在发布时就拒。 */
    assert.throws(
      () => fx.service.publishTask({
        tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
        title: 'USD task', description: 'unsettleable', category: 'operations',
        reward: 100, currency: 'USD',
      }),
      (err: unknown) => err instanceof Error && /任务币种必须为 CRED/.test(err.message),
      '非 CRED 任务必须在发布时就被拒绝',
    );

    /* 对照：CRED（以及缺省）任务照常发布 —— 别把功能一起拒掉。 */
    const explicit = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'CRED task', description: 'ok', category: 'operations',
      reward: 100, currency: 'CRED',
    });
    assert.equal(explicit.currency, 'CRED');
    const defaulted = fx.service.publishTask({
      tenantId: fx.tenantId, publisherUserId: fx.ownerUserId,
      title: 'default task', description: 'ok', category: 'operations', reward: 100,
    });
    assert.equal(defaulted.currency, 'CRED', '不传 currency 应默认 CRED');
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
