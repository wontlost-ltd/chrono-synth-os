/**
 * 结算对账 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  SettlementRow, WalletTransactionRow, ReconciliationRunRow,
  SettlementTransactionsParams,
  SettlementAcquireLockParams, DeleteSettlementTransactionsParams,
  InsertTransactionParams, DeleteOrphanTransactionsParams,
  InsertRunParams, RunsByTenantParams,
} from '@chrono/kernel';
import {
  SETTLE_QUERY_SETTLEMENTS_BY_TENANT, SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT,
  SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS, SETTLE_QUERY_RUNS_BY_TENANT,
  SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS, SETTLE_CMD_INSERT_TRANSACTION,
  SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS, SETTLE_CMD_INSERT_RUN,
  SETTLE_CMD_ACQUIRE_LOCK,
} from '@chrono/kernel';

export function registerSettlementExecutors(): void {
  /* ── Queries ── */

  registerQuery<readonly SettlementRow[], string>(SETTLE_QUERY_SETTLEMENTS_BY_TENANT, (db, tenantId) => {
    return db.prepare<SettlementRow>(
      `SELECT id, tenant_id, wallet_id, total_amount_minor, currency, persona_amount_minor, platform_amount_minor
       FROM wallet_settlements
       WHERE tenant_id = ?
       ORDER BY created_at ASC`,
    ).all(tenantId);
  });

  registerQuery<readonly WalletTransactionRow[], SettlementTransactionsParams>(SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT, (db, p) => {
    return db.prepare<WalletTransactionRow>(
      `SELECT id, wallet_id, transaction_type, amount_minor, currency
       FROM wallet_transactions
       WHERE tenant_id = ? AND reference_type = 'wallet_settlement' AND reference_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(p.tenantId, p.settlementId);
  });

  registerQuery<readonly { tenant_id: string }[], number>(SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS, (db, limit) => {
    return db.prepare<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM (
         SELECT tenant_id FROM wallet_settlements
         UNION
         SELECT tenant_id FROM wallet_transactions WHERE reference_type = 'wallet_settlement'
       )
       ORDER BY tenant_id ASC
       LIMIT ?`,
    ).all(limit);
  });

  registerQuery<readonly ReconciliationRunRow[], RunsByTenantParams>(SETTLE_QUERY_RUNS_BY_TENANT, (db, p) => {
    return db.prepare<ReconciliationRunRow>(
      `SELECT * FROM settlement_reconciliation_runs
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(p.tenantId, p.limit);
  });

  /* ── Commands ── */

  /**
   * 对账串行化锁（事务级）。
   *
   * PG 默认 READ COMMITTED，复核用的 SELECT 不加行锁 → 复核与 DELETE 之间有 TOCTOU 窗口，
   * 并发结算在此间隙写入的合法流水会被删。用 pg_advisory_xact_lock 把「复核+删+重插」
   * 整段对同一 settlement 串行化，随事务结束自动释放（无需显式解锁、不留行）。
   * 锁按 settlement 粒度而非整租户：不同结算的修复本可并行，锁整租户会无谓拖慢对账。
   *
   * SQLite 是单写者，写事务已由 BEGIN 天然互斥（且 WAL 快照隔离下并发写会直接
   * SQLITE_BUSY 回滚而非误删），故无需额外语句 —— 与 audit 链锁同款处理。
   */
  registerCommand<SettlementAcquireLockParams>(SETTLE_CMD_ACQUIRE_LOCK, (db, p) => {
    if (db.dialect === 'postgres') {
      /* 两参版 hashtext：把 tenant/settlement 映射到 (classid, objid) 两个 int，
       * 比拼字符串再 hash 更不易碰撞。 */
      db.prepare<void>('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))')
        .run(p.tenantId, p.settlementId);
    }
    return { rowsAffected: 0 };
  });

  registerCommand<DeleteSettlementTransactionsParams>(SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM wallet_transactions
       WHERE tenant_id = ? AND reference_type = 'wallet_settlement' AND reference_id = ?`,
    ).run(p.tenantId, p.settlementId);
    return { rowsAffected: result.changes };
  });

  registerCommand<InsertTransactionParams>(SETTLE_CMD_INSERT_TRANSACTION, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO wallet_transactions (
        id, tenant_id, wallet_id, transaction_type, amount_minor, currency, reference_type, reference_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'wallet_settlement', ?, ?)`,
    ).run(p.id, p.tenantId, p.walletId, p.transactionType, p.amountMinor, p.currency, p.settlementId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<DeleteOrphanTransactionsParams>(SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM wallet_transactions
       WHERE tenant_id = ?
         AND reference_type = 'wallet_settlement'
         AND reference_id NOT IN (
           SELECT id FROM wallet_settlements WHERE tenant_id = ?
         )`,
    ).run(p.tenantId, p.tenantId);
    return { rowsAffected: result.changes };
  });

  registerCommand<InsertRunParams>(SETTLE_CMD_INSERT_RUN, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO settlement_reconciliation_runs (
        id, tenant_id, checked_settlements, mismatched_settlements, repaired_settlements,
        deleted_transactions, inserted_transactions, orphan_transactions_removed,
        report_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.checkedSettlements, p.mismatchedSettlements, p.repairedSettlements,
      p.deletedTransactions, p.insertedTransactions, p.orphanTransactionsRemoved, p.reportJson, p.now);
    return { rowsAffected: result.changes };
  });
}
