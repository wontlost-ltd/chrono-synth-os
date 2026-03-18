/**
 * 结算对账 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const SETTLE_QUERY_SETTLEMENTS_BY_TENANT = 'settlement.by-tenant' as const;
export const SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT = 'settlement.transactions-by-settlement' as const;
export const SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS = 'settlement.tenants-with-settlements' as const;
export const SETTLE_QUERY_RUNS_BY_TENANT = 'settlement.runs-by-tenant' as const;

/* ── Command Kinds ── */

export const SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS = 'settlement.delete-settlement-transactions' as const;
export const SETTLE_CMD_INSERT_TRANSACTION = 'settlement.insert-transaction' as const;
export const SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS = 'settlement.delete-orphan-transactions' as const;
export const SETTLE_CMD_INSERT_RUN = 'settlement.insert-run' as const;

/* ── 行类型 ── */

export interface SettlementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly wallet_id: string;
  readonly total_amount_minor: number;
  readonly currency: string;
  readonly persona_amount_minor: number;
  readonly platform_amount_minor: number;
}

export interface WalletTransactionRow {
  readonly id: string;
  readonly wallet_id: string;
  readonly transaction_type: string;
  readonly amount_minor: number;
  readonly currency: string;
}

export interface ReconciliationRunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly checked_settlements: number;
  readonly mismatched_settlements: number;
  readonly repaired_settlements: number;
  readonly deleted_transactions: number;
  readonly inserted_transactions: number;
  readonly orphan_transactions_removed: number;
  readonly report_json: string;
  readonly created_at: number;
}

/* ── 参数类型 ── */

export interface SettlementTransactionsParams {
  tenantId: string;
  settlementId: string;
}

export interface DeleteSettlementTransactionsParams {
  tenantId: string;
  settlementId: string;
}

export interface InsertTransactionParams {
  id: string;
  tenantId: string;
  walletId: string;
  transactionType: string;
  amountMinor: number;
  currency: string;
  settlementId: string;
  now: number;
}

export interface DeleteOrphanTransactionsParams {
  tenantId: string;
}

export interface InsertRunParams {
  id: string;
  tenantId: string;
  checkedSettlements: number;
  mismatchedSettlements: number;
  repairedSettlements: number;
  deletedTransactions: number;
  insertedTransactions: number;
  orphanTransactionsRemoved: number;
  reportJson: string;
  now: number;
}

export interface RunsByTenantParams {
  tenantId: string;
  limit: number;
}

/* ── Query 工厂 ── */

export function settleQuerySettlementsByTenant(tenantId: string): Query<SettlementRow, string> {
  return { kind: SETTLE_QUERY_SETTLEMENTS_BY_TENANT, params: tenantId };
}

export function settleQueryTransactionsBySettlement(tenantId: string, settlementId: string): Query<WalletTransactionRow, SettlementTransactionsParams> {
  return { kind: SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT, params: { tenantId, settlementId } };
}

export function settleQueryTenantsWithSettlements(limit: number): Query<{ tenant_id: string }, number> {
  return { kind: SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS, params: limit };
}

export function settleQueryRunsByTenant(tenantId: string, limit: number): Query<ReconciliationRunRow, RunsByTenantParams> {
  return { kind: SETTLE_QUERY_RUNS_BY_TENANT, params: { tenantId, limit } };
}

/* ── Command 工厂 ── */

export function settleCmdDeleteSettlementTransactions(params: DeleteSettlementTransactionsParams): Command<DeleteSettlementTransactionsParams> {
  return { kind: SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS, params };
}

export function settleCmdInsertTransaction(params: InsertTransactionParams): Command<InsertTransactionParams> {
  return { kind: SETTLE_CMD_INSERT_TRANSACTION, params };
}

export function settleCmdDeleteOrphanTransactions(params: DeleteOrphanTransactionsParams): Command<DeleteOrphanTransactionsParams> {
  return { kind: SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS, params };
}

export function settleCmdInsertRun(params: InsertRunParams): Command<InsertRunParams> {
  return { kind: SETTLE_CMD_INSERT_RUN, params };
}
