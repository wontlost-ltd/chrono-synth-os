import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLE_QUERY_SETTLEMENTS_BY_TENANT,
  SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT,
  SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS,
  SETTLE_QUERY_RUNS_BY_TENANT,
  SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS,
  SETTLE_CMD_INSERT_TRANSACTION,
  SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS,
  SETTLE_CMD_INSERT_RUN,
} from '@chrono/kernel';
import { settleQueryTransactionsBySettlement } from '@chrono/kernel';
import { SettlementReconciliationService } from '../../billing/settlement-reconciliation-service.js';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveCommandExecutor, resolveQueryExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';

describe('SettlementReconciliationService', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部结算 query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(SETTLE_QUERY_SETTLEMENTS_BY_TENANT));
    assert.ok(resolveQueryExecutor(SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT));
    assert.ok(resolveQueryExecutor(SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS));
    assert.ok(resolveQueryExecutor(SETTLE_QUERY_RUNS_BY_TENANT));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_INSERT_TRANSACTION));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_INSERT_RUN));
  });

  it('空租户对账并持久化运行记录', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const service = new SettlementReconciliationService(db);

    const run = service.reconcileTenant('tenant-a');

    assert.equal(run.checkedSettlements, 0);
    assert.equal(run.mismatchedSettlements, 0);
    assert.equal(run.repairedSettlements, 0);
    assert.equal(run.deletedTransactions, 0);
    assert.equal(run.insertedTransactions, 0);
    assert.equal(run.orphanTransactionsRemoved, 0);

    const runs = service.listRuns('tenant-a');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, run.runId);
    assert.deepEqual(runs[0].mismatchedSettlementIds, []);
  });

  /* ── 审计 Warning #11：零分项结算的对账期望 ─────────────────── */
  describe('审计 W#11：零分项结算不得被判为不一致', () => {
    /** 直接造一笔结算 + 与之匹配的流水（绕开 marketplace，隔离被测命题）。 */
    function seed(db: ReturnType<typeof createMemoryDatabase>, opts: {
      total: number; owner: number; persona: number; platform: number;
    }): string {
      registerCoreSelfExecutors();
      /* 与同文件「并发安全」组同款：本测只验对账的**条数/金额判据**，
       * 与 wallet/task/assignment 的引用完整性无关，故关外键直插，
       * 避免为此铺三层父行而模糊测试意图。 */
      db.exec('PRAGMA foreign_keys = OFF');
      const now = Date.now();
      const sid = 'ws_zero_split';
      db.prepare<void>(
        `INSERT INTO wallet_settlements (id, tenant_id, wallet_id, task_id, assignment_id,
           total_amount_minor, currency, owner_pct, persona_pct, platform_pct,
           owner_amount_minor, persona_amount_minor, platform_amount_minor,
           status, created_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(sid, 'tenant-z', 'wal_1', 'task_1', 'asg_1',
        opts.total, 'CRED', 60, 40, 0,
        opts.owner, opts.persona, opts.platform, 'completed', now, now);

      /* 与写入侧一致：只为**非零**分项写流水。 */
      const rows: Array<[string, number]> = [['task_payment', opts.total]];
      if (opts.platform > 0) rows.push(['platform_fee', -opts.platform]);
      if (opts.persona > 0) rows.push(['persona_reserve', -opts.persona]);
      rows.forEach(([type, amount], i) => {
        db.prepare<void>(
          `INSERT INTO wallet_transactions (id, tenant_id, wallet_id, transaction_type,
             amount_minor, currency, reference_type, reference_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(`wtx_${i}`, 'tenant-z', 'wal_1', type, amount, 'CRED', 'wallet_settlement', sid, now);
      });
      return sid;
    }

    it('platform 分项为零 → 只有 2 条流水，仍判一致', () => {
      /* ⚠️ 修复前 `isLedgerConsistent` 硬编码 `actual.length !== 3`，
       * 会把合法的零分成结算**永久**判为不一致（并触发 delete/reinsert 修复）。 */
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      seed(db, { total: 10_000, owner: 6_000, persona: 4_000, platform: 0 });

      const run = new SettlementReconciliationService(db).reconcileTenant('tenant-z');
      assert.equal(run.checkedSettlements, 1);
      assert.equal(run.mismatchedSettlements, 0, '零分项结算必须判为一致');
      assert.equal(run.deletedTransactions, 0, '不得触发「修复」把好数据删掉');
      assert.equal(run.insertedTransactions, 0);
    });

    it('platform 与 persona 都为零 → 只有 1 条流水，仍判一致', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      seed(db, { total: 10_000, owner: 10_000, persona: 0, platform: 0 });

      const run = new SettlementReconciliationService(db).reconcileTenant('tenant-z');
      assert.equal(run.mismatchedSettlements, 0);
      assert.equal(run.deletedTransactions, 0);
    });

    it('⚠️ 对照：真被篡改时仍必须检出（放松条数判据不等于放松门）', () => {
      /* 只断言「零分项判一致」是不够的——把门改成恒为一致，那条断言同样会过。
       * 故必须同时钉死：金额被改后仍能检出不一致。 */
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      const sid = seed(db, { total: 10_000, owner: 6_000, persona: 4_000, platform: 0 });
      db.prepare<void>(
        `UPDATE wallet_transactions SET amount_minor = -999
         WHERE reference_id = ? AND transaction_type = 'persona_reserve'`,
      ).run(sid);

      const run = new SettlementReconciliationService(db).reconcileTenant('tenant-z');
      assert.equal(run.mismatchedSettlements, 1, '金额被篡改必须仍被检出');
    });

    it('⚠️ 对照：重复流水（多插一条）仍必须检出', () => {
      /* 独立审查 High-2 起：此前对照只有「改金额 / 删流水」两种形态，
       * **重复流水**（同一笔被记两次）这一真实篡改形态零覆盖，故补这条。
       *
       * ⚠️ 本用例**不覆盖**条数判据那一行 —— 实测把它整行删掉，本用例仍绿。
       * 原因是多重集计数相等已蕴含条数相等，条数判据在逻辑上冗余
       * （见 settlement-reconciliation-service.ts 中 isLedgerConsistent 的注释）。
       * 真正检出这条的是 countLedgerEntries 比较。 */
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      const sid = seed(db, { total: 10_000, owner: 6_000, persona: 4_000, platform: 0 });
      const now = Date.now();
      db.prepare<void>(
        `INSERT INTO wallet_transactions (id, tenant_id, wallet_id, transaction_type,
           amount_minor, currency, reference_type, reference_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run('wtx_dup', 'tenant-z', 'wal_1', 'persona_reserve', -4_000, 'CRED',
        'wallet_settlement', sid, now);

      const run = new SettlementReconciliationService(db).reconcileTenant('tenant-z');
      assert.equal(run.mismatchedSettlements, 1, '重复流水必须被检出（否则同一笔被记两次）');
    });

    it('⚠️ 对照：分项非零却缺流水，仍必须检出', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      const sid = seed(db, { total: 10_000, owner: 6_000, persona: 4_000, platform: 0 });
      db.prepare<void>(
        `DELETE FROM wallet_transactions WHERE reference_id = ? AND transaction_type = 'persona_reserve'`,
      ).run(sid);

      const run = new SettlementReconciliationService(db).reconcileTenant('tenant-z');
      assert.equal(run.mismatchedSettlements, 1, '非零分项缺流水必须仍被检出');
    });
  });

  /* 审计 Warning B4-7：修复是「事务外判定不一致 → 事务内 delete/reinsert」。
   * 判定与修复之间没有复核，也没有租约：
   *   - 并发结算在此窗口补齐了流水 → 会被 delete 掉；
   *   - 两个对账实例同时跑 → 互相覆盖对方的修复结果。
   * 现改为事务内重新核对，已一致则整体跳过（不删不插）。 */
  describe('并发安全：事务内复核', () => {
    /** 插一条结算 + 指定的流水集合。
     *  本测只验对账 SQL 的并发语义，与 wallet/task/assignment 的引用完整性无关，
     *  故关掉外键约束直插，避免为此铺三层父行而模糊测试意图。 */
    function seed(db: ReturnType<typeof createMemoryDatabase>, opts: { withLedger: boolean }): void {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare<void>(
        `INSERT INTO wallet_settlements (id, tenant_id, wallet_id, task_id, assignment_id,
           total_amount_minor, currency, owner_pct, persona_pct, platform_pct,
           owner_amount_minor, persona_amount_minor, platform_amount_minor,
           status, created_at, completed_at)
         VALUES ('st_1','tenant-a','w_1','t_1','as_1',10000,'CRED',50,30,20,5000,3000,2000,'completed',1000,1000)`,
      ).run();
      if (!opts.withLedger) return;
      seedLedger(db);
    }

    /** 只插正确的三条流水（与 buildExpectedLedger 一致：符号由 signedAmountForTransaction 决定）。 */
    function seedLedger(db: ReturnType<typeof createMemoryDatabase>): void {
      db.exec('PRAGMA foreign_keys = OFF');
      const rows: Array<[string, string, number]> = [
        ['wtx_a', 'task_payment', 10000],
        ['wtx_b', 'platform_fee', -2000],
        ['wtx_c', 'persona_reserve', -3000],  /* debit：方向矩阵定为负 */
      ];
      for (const [id, type, amt] of rows) {
        db.prepare<void>(
          `INSERT INTO wallet_transactions (id, tenant_id, wallet_id, transaction_type,
             amount_minor, currency, reference_type, reference_id, created_at)
           VALUES (?, 'tenant-a', 'w_1', ?, ?, 'CRED', 'wallet_settlement', 'st_1', 1000)`,
        ).run(id, type, amt);
      }
    }

    it('账本缺失 → 判定不一致并真的修复', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      seed(db, { withLedger: false });

      /* service 在构造期捕获 tx 引用，故必须**先装桩再构造**。 */
      const run = new SettlementReconciliationService(db).reconcileTenant('tenant-a');
      assert.equal(run.mismatchedSettlements, 1);
      assert.equal(run.repairedSettlements, 1, '应真的修了一条');
      assert.equal(run.insertedTransactions, 3, '补齐三条流水');
    });

    it('重复对账幂等：第二轮不再删改（事务内复核发现已一致）', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      seed(db, { withLedger: false });
      const service = new SettlementReconciliationService(db);

      service.reconcileTenant('tenant-a');
      const second = service.reconcileTenant('tenant-a');

      assert.equal(second.mismatchedSettlements, 0, '首轮修完后应已一致');
      assert.equal(second.repairedSettlements, 0);
      assert.equal(second.deletedTransactions, 0, '不得再删已正确的流水');
      assert.equal(second.insertedTransactions, 0);
    });

    /* 直接把守「事务内复核」本身：外层判定必须看到不一致、内层必须看到已一致。
     * 用一次性的陈旧视图制造该交错——service 首次读流水时返回空（外层判定不一致），
     * 之后的读走真实数据（内层复核发现已一致）。这正是「并发结算已补齐」的真实形态。 */
    it('外层判定不一致但事务内已一致 → 跳过，不删并发写入的流水', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      seed(db, { withLedger: true });   /* 库中流水本就是正确的 */

      const realQueryMany = db.queryMany.bind(db);
      let staleServed = false;
      (db as { queryMany: typeof realQueryMany }).queryMany = ((q: Parameters<typeof realQueryMany>[0]) => {
        if (!staleServed && (q as { kind?: string }).kind === SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT) {
          staleServed = true;
          return [] as ReturnType<typeof realQueryMany>;
        }
        return realQueryMany(q);
      }) as typeof realQueryMany;

      const run = new SettlementReconciliationService(db).reconcileTenant('tenant-a');
      (db as { queryMany: typeof realQueryMany }).queryMany = realQueryMany;

      assert.equal(run.mismatchedSettlements, 1, '外层按陈旧视图判定为不一致');
      assert.equal(run.repairedSettlements, 0, '事务内复核已一致 → 不计为修复');
      assert.equal(run.deletedTransactions, 0, '绝不能删掉并发写入的合法流水');
      assert.equal(run.insertedTransactions, 0);

      /* 库中原有的三条流水必须原封不动。 */
      const remaining = realQueryMany(settleQueryTransactionsBySettlement('tenant-a', 'st_1'));
      assert.equal(remaining.length, 3, '合法流水不得被删');
    });
  });
});
