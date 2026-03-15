import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';

interface SettlementRow {
  id: string;
  tenant_id: string;
  wallet_id: string;
  total_amount_minor: number;
  currency: string;
  persona_amount_minor: number;
  platform_amount_minor: number;
}

interface WalletTransactionRow {
  id: string;
  wallet_id: string;
  transaction_type: string;
  amount_minor: number;
  currency: string;
}

interface ReconciliationRunRow {
  id: string;
  tenant_id: string;
  checked_settlements: number;
  mismatched_settlements: number;
  repaired_settlements: number;
  deleted_transactions: number;
  inserted_transactions: number;
  orphan_transactions_removed: number;
  report_json: string;
  created_at: number;
}

interface ExpectedLedgerEntry {
  transactionType: string;
  amountMinor: number;
  currency: string;
}

export interface SettlementReconciliationRun {
  runId: string;
  tenantId: string;
  checkedSettlements: number;
  mismatchedSettlements: number;
  repairedSettlements: number;
  deletedTransactions: number;
  insertedTransactions: number;
  orphanTransactionsRemoved: number;
  mismatchedSettlementIds: string[];
  createdAt: string;
}

function toIso(value: number): string {
  return new Date(Number(value)).toISOString();
}

function buildExpectedLedger(settlement: SettlementRow): ExpectedLedgerEntry[] {
  return [
    {
      transactionType: 'task_payment',
      amountMinor: Number(settlement.total_amount_minor),
      currency: settlement.currency,
    },
    {
      transactionType: 'platform_fee',
      amountMinor: -Number(settlement.platform_amount_minor),
      currency: settlement.currency,
    },
    {
      transactionType: 'persona_reserve',
      amountMinor: -Number(settlement.persona_amount_minor),
      currency: settlement.currency,
    },
  ];
}

function toLedgerKey(entry: { transactionType: string; amountMinor: number; currency: string }): string {
  return `${entry.transactionType}:${entry.amountMinor}:${entry.currency}`;
}

function countLedgerEntries(entries: Array<{ transactionType: string; amountMinor: number; currency: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = toLedgerKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isLedgerConsistent(actual: WalletTransactionRow[], settlement: SettlementRow): boolean {
  if (actual.length !== 3) return false;

  const actualCounts = countLedgerEntries(actual.map((row) => ({
    transactionType: row.transaction_type,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
  })));
  const expectedCounts = countLedgerEntries(buildExpectedLedger(settlement));

  if (actualCounts.size !== expectedCounts.size) return false;
  for (const [key, value] of expectedCounts) {
    if (actualCounts.get(key) !== value) return false;
  }
  return true;
}

export class SettlementReconciliationService {
  constructor(private readonly db: IDatabase) {}

  reconcileTenant(tenantId: string): SettlementReconciliationRun {
    const settlements = this.db.prepare<SettlementRow>(
      `SELECT id, tenant_id, wallet_id, total_amount_minor, currency, persona_amount_minor, platform_amount_minor
       FROM wallet_settlements
       WHERE tenant_id = ?
       ORDER BY created_at ASC`,
    ).all(tenantId);

    let mismatchedSettlements = 0;
    let repairedSettlements = 0;
    let deletedTransactions = 0;
    let insertedTransactions = 0;
    const mismatchedSettlementIds: string[] = [];

    for (const settlement of settlements) {
      const actual = this.db.prepare<WalletTransactionRow>(
        `SELECT id, wallet_id, transaction_type, amount_minor, currency
         FROM wallet_transactions
         WHERE tenant_id = ? AND reference_type = 'wallet_settlement' AND reference_id = ?
         ORDER BY created_at ASC, id ASC`,
      ).all(tenantId, settlement.id);

      if (isLedgerConsistent(actual, settlement)) {
        continue;
      }

      mismatchedSettlements += 1;
      mismatchedSettlementIds.push(settlement.id);

      this.db.transaction(() => {
        const deleted = this.db.prepare<void>(
          `DELETE FROM wallet_transactions
           WHERE tenant_id = ? AND reference_type = 'wallet_settlement' AND reference_id = ?`,
        ).run(tenantId, settlement.id).changes;
        deletedTransactions += deleted;

        for (const expected of buildExpectedLedger(settlement)) {
          this.db.prepare<void>(
            `INSERT INTO wallet_transactions (
              id, tenant_id, wallet_id, transaction_type, amount_minor, currency, reference_type, reference_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'wallet_settlement', ?, ?)`,
          ).run(
            `wtx_${randomUUID()}`,
            tenantId,
            settlement.wallet_id,
            expected.transactionType,
            expected.amountMinor,
            expected.currency,
            settlement.id,
            Date.now(),
          );
          insertedTransactions += 1;
        }
      });

      repairedSettlements += 1;
    }

    const orphanTransactionsRemoved = this.db.prepare<void>(
      `DELETE FROM wallet_transactions
       WHERE tenant_id = ?
         AND reference_type = 'wallet_settlement'
         AND reference_id NOT IN (
           SELECT id FROM wallet_settlements WHERE tenant_id = ?
         )`,
    ).run(tenantId, tenantId).changes;

    const now = Date.now();
    const report = {
      mismatchedSettlementIds,
    };
    const runId = `recon_${randomUUID()}`;

    this.db.prepare<void>(
      `INSERT INTO settlement_reconciliation_runs (
        id, tenant_id, checked_settlements, mismatched_settlements, repaired_settlements,
        deleted_transactions, inserted_transactions, orphan_transactions_removed,
        report_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      tenantId,
      settlements.length,
      mismatchedSettlements,
      repairedSettlements,
      deletedTransactions,
      insertedTransactions,
      orphanTransactionsRemoved,
      JSON.stringify(report),
      now,
    );

    return {
      runId,
      tenantId,
      checkedSettlements: settlements.length,
      mismatchedSettlements,
      repairedSettlements,
      deletedTransactions,
      insertedTransactions,
      orphanTransactionsRemoved,
      mismatchedSettlementIds,
      createdAt: toIso(now),
    };
  }

  reconcileTenants(limit = 100): SettlementReconciliationRun[] {
    const tenantRows = this.db.prepare<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM (
         SELECT tenant_id FROM wallet_settlements
         UNION
         SELECT tenant_id FROM wallet_transactions WHERE reference_type = 'wallet_settlement'
       )
       ORDER BY tenant_id ASC
       LIMIT ?`,
    ).all(limit);
    return tenantRows.map((row) => this.reconcileTenant(row.tenant_id));
  }

  listRuns(tenantId: string, limit = 20): SettlementReconciliationRun[] {
    const rows = this.db.prepare<ReconciliationRunRow>(
      `SELECT *
       FROM settlement_reconciliation_runs
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(tenantId, limit);

    return rows.map((row) => {
      const report = JSON.parse(row.report_json) as { mismatchedSettlementIds?: string[] };
      return {
        runId: row.id,
        tenantId: row.tenant_id,
        checkedSettlements: Number(row.checked_settlements),
        mismatchedSettlements: Number(row.mismatched_settlements),
        repairedSettlements: Number(row.repaired_settlements),
        deletedTransactions: Number(row.deleted_transactions),
        insertedTransactions: Number(row.inserted_transactions),
        orphanTransactionsRemoved: Number(row.orphan_transactions_removed),
        mismatchedSettlementIds: report.mismatchedSettlementIds ?? [],
        createdAt: toIso(Number(row.created_at)),
      };
    });
  }
}
