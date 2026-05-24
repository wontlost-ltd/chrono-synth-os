/**
 * Persona wallet sub-service — second cut of the Step 16 split.
 *
 * Scope (this PR): wallet read paths + wallet payout flow.
 *   - getWallet, getWalletByIdForOwner, listWalletTransactions
 *   - requestWalletPayout (single-domain — wallet balance update +
 *     payout-request row + transaction journal entry)
 *   - insertWalletTransaction — exposed publicly because the still-
 *     in-core methods that touch wallets (settleTaskPayment,
 *     submitTaskResult, etc.) need the same single-source write path.
 *
 * Out of scope (deliberately left in PersonaCoreService for a future
 * cut):
 *   - settleTaskPayment (cross-domain with task + governance), see
 *     L1514 in persona-core-service.ts. The settlement path touches
 *     marketplace tasks, runtime sessions, and emits observability
 *     events; pulling it out is the natural next pass.
 *   - The task/runtime-session methods (applyToTask, assignTask,
 *     createRuntimeSession, …) — they form their own cluster that
 *     deserves its own service.
 *
 * The §8 plan called for a "PersonaMarketplaceService" doing task +
 * marketplace; this PR delivers the wallet half of that surface,
 * which is the most cohesive sub-cluster (no governance coupling).
 * The remaining marketplace work follows the same pattern.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { FieldEncryption } from '../storage/encryption.js';
import {
  pcoreCmdCreateWalletPayoutRequest,
  pcoreCmdInsertWalletTransaction,
  pcoreCmdUpdateWalletBalance,
  pcoreQueryWalletByIdForOwner,
  pcoreQueryWalletByPersona,
  pcoreQueryWalletByPersonaId,
  pcoreQueryWalletPayoutRequestById,
  pcoreQueryWalletSettlementByAssignmentId,
  pcoreQueryWalletTransactions,
  type PcoreWalletPayoutRequestRow,
  type PcoreWalletRow,
  type PcoreWalletSettlementRow,
  type PcoreWalletTransactionRow,
} from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';
import { fromMinor, toMinor } from './persona-core-utils.js';
import type {
  PersonaWallet,
  RequestWalletPayoutInput,
  TaskWalletSettlement,
  WalletPayoutRequest,
  WalletTransaction,
  WalletTransactionType,
} from './types.js';

/* ── Row mappers (extracted alongside the methods that use them) ── */

/**
 * Wallet row → domain mapper. Exported so `PersonaCoreService`'s
 * listPersonas / getPersonaDetail can synthesize wallet snapshots
 * from JOINed query rows without re-implementing the column→field
 * translation. Single owner — if a new column is added, change here
 * and the facade picks it up.
 */
export function walletFromRow(row: PcoreWalletRow): PersonaWallet {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    walletAddress: row.wallet_address,
    balance: Number(row.balance),
    tokenBalance: Number(row.token_balance),
    currency: row.currency ?? 'CRED',
    status: (row.status ?? 'active') as PersonaWallet['status'],
    lastSettledAt: row.last_settled_at === null ? null : Number(row.last_settled_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function walletTransactionFromRow(row: PcoreWalletTransactionRow): WalletTransaction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    walletId: row.wallet_id,
    transactionType: row.transaction_type as WalletTransaction['transactionType'],
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    createdAt: Number(row.created_at),
  };
}

function walletPayoutRequestFromRow(row: PcoreWalletPayoutRequestRow): WalletPayoutRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    walletId: row.wallet_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status as WalletPayoutRequest['status'],
    requestedByUserId: row.requested_by_user_id,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function walletSettlementFromRow(row: PcoreWalletSettlementRow): TaskWalletSettlement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    walletId: row.wallet_id,
    taskId: row.task_id,
    assignmentId: row.assignment_id,
    totalAmountMinor: Number(row.total_amount_minor),
    currency: row.currency,
    ownerPct: Number(row.owner_pct),
    personaPct: Number(row.persona_pct),
    platformPct: Number(row.platform_pct),
    ownerAmountMinor: Number(row.owner_amount_minor),
    personaAmountMinor: Number(row.persona_amount_minor),
    platformAmountMinor: Number(row.platform_amount_minor),
    status: row.status as TaskWalletSettlement['status'],
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

/* ── Service ───────────────────────────────────────────────────── */

export interface PersonaWalletContext {
  /** Persona-existence + owner check — true iff the persona exists
   *  AND the caller is its owner. Same semantics as
   *  PersonaCoreService.personaExists. */
  personaExists(tenantId: string, ownerUserId: string, personaId: string): boolean;
}

export class PersonaWalletService {
  /**
   * Constructor accepts optional encryption args for shape parity with
   * `PersonaCoreService`'s constructor signature — they are
   * deliberately unused today because no wallet column is
   * field-encrypted. If a future schema introduces encrypted balances
   * or addresses, wire the precedence logic at the call site
   * (resolver wins over static) before reading those columns.
   */
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly ctx: PersonaWalletContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _staticEncryption?: FieldEncryption,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _encryptionResolver?: (tenantId: string) => FieldEncryption | undefined,
  ) {}

  /* ── Public API ─────────────────────────────────────────────── */

  getWallet(tenantId: string, ownerUserId: string, personaId: string): PersonaWallet | null {
    if (!this.ctx.personaExists(tenantId, ownerUserId, personaId)) return null;
    const row = this.tx.queryOne(pcoreQueryWalletByPersona({ tenantId, personaId }));
    return row ? walletFromRow(row) : null;
  }

  getWalletByIdForOwner(tenantId: string, ownerUserId: string, walletId: string): PersonaWallet | null {
    const row = this.tx.queryOne(pcoreQueryWalletByIdForOwner({ tenantId, walletId }));
    if (!row || row.owner_user_id !== ownerUserId) return null;
    return walletFromRow(row);
  }

  listWalletTransactions(tenantId: string, ownerUserId: string, walletId: string): WalletTransaction[] | null {
    const wallet = this.getWalletByIdForOwner(tenantId, ownerUserId, walletId);
    if (!wallet) return null;
    return this.tx.queryMany(pcoreQueryWalletTransactions({ tenantId, walletId })).map(walletTransactionFromRow);
  }

  requestWalletPayout(input: RequestWalletPayoutInput): WalletPayoutRequest | null {
    const wallet = this.getWalletByIdForOwner(input.tenantId, input.ownerUserId, input.walletId);
    if (!wallet || wallet.status !== 'active') return null;

    const amountMinor = Math.max(0, Math.round(input.amountMinor));
    if (amountMinor <= 0 || amountMinor > toMinor(wallet.balance)) return null;

    const now = Date.now();
    const payoutId = generatePrefixedId('wpr');
    const nextBalanceMinor = toMinor(wallet.balance) - amountMinor;

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateWalletPayoutRequest({
        id: payoutId,
        tenantId: input.tenantId,
        walletId: input.walletId,
        amountMinor,
        currency: wallet.currency,
        requestedByUserId: input.ownerUserId,
        now,
      }));

      this.tx.execute(pcoreCmdUpdateWalletBalance({
        tenantId: input.tenantId,
        walletId: input.walletId,
        balance: fromMinor(nextBalanceMinor),
        now,
      }));

      this.insertWalletTransaction({
        tenantId: input.tenantId,
        walletId: input.walletId,
        transactionType: 'owner_payout',
        amountMinor: -amountMinor,
        currency: wallet.currency,
        referenceType: 'wallet_payout_request',
        referenceId: payoutId,
      });
    });

    return this.getWalletPayoutRequestById(input.tenantId, payoutId);
  }

  /* ── Internal API (used by the still-in-core methods that touch
   *    wallets but haven't been extracted yet — e.g. settleTaskPayment,
   *    submitTaskResult). Exposing these maintains a single source
   *    of truth for wallet writes + lookups across the split.
   *
   *    Methods below carry `@internal` so a future API docs pass
   *    (typedoc / api-extractor) can hide them from the public
   *    surface. They're NOT for external callers — once the task/
   *    runtime-session split lands, these become private again
   *    (collapsed into the facades that need them). */

  /**
   * @internal — call only from PersonaCoreService or other sibling
   * sub-services during the incremental split. Has no owner check
   * by design — callers must validate authorization before invoking.
   * Insert a wallet transaction journal entry. The amount can be
   * negative (debit) — caller owns sign convention.
   */
  insertWalletTransaction(input: {
    tenantId: string;
    walletId: string;
    transactionType: WalletTransactionType;
    amountMinor: number;
    currency: string;
    referenceType?: string | null;
    referenceId?: string | null;
  }): WalletTransaction {
    const now = Date.now();
    const id = generatePrefixedId('wtx');
    this.tx.execute(pcoreCmdInsertWalletTransaction({
      id,
      tenantId: input.tenantId,
      walletId: input.walletId,
      transactionType: input.transactionType,
      amountMinor: Math.round(input.amountMinor),
      currency: input.currency,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      now,
    }));
    return {
      id,
      tenantId: input.tenantId,
      walletId: input.walletId,
      transactionType: input.transactionType,
      amountMinor: Math.round(input.amountMinor),
      currency: input.currency,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      createdAt: now,
    };
  }

  /**
   * @internal — call only from PersonaCoreService or other sibling
   * sub-services. Look up wallet by its owning persona — used by
   * settlement and task-completion flows still in core. No owner
   * check; caller must enforce authorization.
   */
  getWalletByPersonaId(tenantId: string, personaId: string): PersonaWallet | null {
    const row = this.tx.queryOne(pcoreQueryWalletByPersonaId({ tenantId, personaId }));
    return row ? walletFromRow(row) : null;
  }

  /**
   * @internal — used internally by requestWalletPayout's return
   * path. External callers should not assume this stays public.
   */
  getWalletPayoutRequestById(tenantId: string, payoutId: string): WalletPayoutRequest | null {
    const row = this.tx.queryOne(pcoreQueryWalletPayoutRequestById({ tenantId, payoutId }));
    return row ? walletPayoutRequestFromRow(row) : null;
  }

  /**
   * @internal — used by settleTaskPayment (still in core) to enforce
   * idempotency (don't double-pay). Will become private once the
   * settlement path is extracted into a marketplace sub-service.
   */
  getWalletSettlementByAssignmentId(tenantId: string, assignmentId: string): TaskWalletSettlement | null {
    const row = this.tx.queryOne(pcoreQueryWalletSettlementByAssignmentId({ tenantId, assignmentId }));
    return row ? walletSettlementFromRow(row) : null;
  }
}
