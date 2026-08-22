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

import type { FieldEncryption } from '../storage/encryption.js';
import {
  pcoreCmdCreateWalletPayoutRequest,
  pcoreCmdInsertWalletTransaction,
  pcoreCmdDebitWalletBalance,
  pcoreQueryWalletByIdForOwner,
  pcoreQueryWalletByPersona,
  pcoreQueryWalletByPersonaId,
  pcoreQueryWalletPayoutRequestById,
  pcoreQueryWalletPayoutByIdempotencyKey,
  pcoreQueryWalletSettlementByAssignmentId,
  pcoreQueryWalletTransactions,
  type PcoreWalletPayoutRequestRow,
  type PcoreWalletRow,
  type PcoreWalletSettlementRow,
  type PcoreWalletTransactionRow,
  assertWalletMutationAllowed,
  type WalletActorType,
  type WalletDirection,
} from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
import { toMinor } from './persona-core-utils.js';
import type { PersonaCoreSource, TransactionContext } from './persona-core-source.js';
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

/**
 * 是否为提现幂等索引冲突 —— 只认这一类做 catch-and-refetch 收敛，其余约束/故障照抛。
 * 匹配索引名或通用 UNIQUE 冲突文案（SQLite/PG 措辞不同，兼容两者）。
 * 与 `learning-request-service.isActiveUniqueConflict` 同款范式。
 */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  /* ⚠️ 必须**精确到这一个索引**，不能用「任意 UNIQUE 冲突」兜底。
   * 两种方言的消息形态不同（均已实测）：
   *   PG    : `duplicate key value violates unique constraint "uq_wallet_payout_idempotency"`
   *           —— 带**索引名**，可直接匹配。
   *   SQLite: `UNIQUE constraint failed: wallet_payout_requests.tenant_id, ...idempotency_key`
   *           —— **只带列名、不带索引名**，故必须匹配列组合。
   *
   * 为什么不能宽松匹配：同一事务里主键 `id` 冲突的消息是
   * `UNIQUE constraint failed: wallet_payout_requests.id`（实测），
   * 宽松匹配会把它当成幂等命中 → 去查 idempotency_key 反查、
   * 返回一条**不相关**的既有提现记录，把真错误伪装成幂等成功。 */
  const pgIndexHit = /unique constraint "uq_wallet_payout_idempotency"/i.test(msg);
  const sqliteColumnHit = /UNIQUE constraint failed:[^\n]*\bidempotency_key\b/i.test(msg);
  return pgIndexHit || sqliteColumnHit;
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
    /* db 取源（双入口）：public 读方法经 source.forTenant 解析；写路径走 InTx 变体收外层 tx。 */
    private readonly source: PersonaCoreSource,
    private readonly ctx: PersonaWalletContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _staticEncryption?: FieldEncryption,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _encryptionResolver?: (tenantId: string) => FieldEncryption | undefined,
  ) {}

  /* ── Public API ─────────────────────────────────────────────── */

  getWallet(tenantId: string, ownerUserId: string, personaId: string): PersonaWallet | null {
    if (!this.ctx.personaExists(tenantId, ownerUserId, personaId)) return null;
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryWalletByPersona({ tenantId, personaId }));
    return row ? walletFromRow(row) : null;
  }

  getWalletByIdForOwner(tenantId: string, ownerUserId: string, walletId: string): PersonaWallet | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryWalletByIdForOwner({ tenantId, walletId }));
    if (!row || row.owner_user_id !== ownerUserId) return null;
    return walletFromRow(row);
  }

  listWalletTransactions(tenantId: string, ownerUserId: string, walletId: string): WalletTransaction[] | null {
    const wallet = this.getWalletByIdForOwner(tenantId, ownerUserId, walletId);
    if (!wallet) return null;
    return this.source.forTenant(tenantId).queryMany(pcoreQueryWalletTransactions({ tenantId, walletId })).map(walletTransactionFromRow);
  }

  /**
   * 幂等键反查（catch-and-refetch）。与 learning-request-service 的
   * `isActiveUniqueConflict` 同款范式：只认唯一索引冲突做收敛，其余照抛。
   */
  private findPayoutByIdempotencyKey(tenantId: string, idempotencyKey: string): WalletPayoutRequest | null {
    const row = this.source.forTenant(tenantId)
      .queryOne(pcoreQueryWalletPayoutByIdempotencyKey({ tenantId, idempotencyKey }));
    return row ? walletPayoutRequestFromRow(row) : null;
  }

  requestWalletPayout(input: RequestWalletPayoutInput): WalletPayoutRequest | null {
    const wallet = this.getWalletByIdForOwner(input.tenantId, input.ownerUserId, input.walletId);
    if (!wallet || wallet.status !== 'active') return null;

    const amountMinor = Math.max(0, Math.round(input.amountMinor));
    /* 事务外的余额检查只是快速失败（省掉明显无望的事务开销）——**不是**授权判据。
     * 真正的余额把关在事务内的条件原子扣减里，见下方注释。 */
    if (amountMinor <= 0 || amountMinor > toMinor(wallet.balance)) return null;

    const now = Date.now();
    const payoutId = generatePrefixedId('wpr');
    const currency = wallet.currency;

    const db = this.source.forTenant(input.tenantId);
    /* 余额不足时用哨兵回滚整个事务：此时提现请求行与流水都不能留下。
     * 与真异常区分——余额不足是正常业务结果（返回 null），不该向上抛。 */
    const INSUFFICIENT = Symbol('insufficient-balance');
    try {
      db.transaction(() => {
        db.execute(pcoreCmdCreateWalletPayoutRequest({
          id: payoutId,
          tenantId: input.tenantId,
          walletId: input.walletId,
          amountMinor,
          currency,
          requestedByUserId: input.ownerUserId,
          now,
          idempotencyKey: input.idempotencyKey ?? null,
        }));

        /* 条件原子扣减：相对扣减 + 同语句余额校验。
         * 原实现在事务**外**读余额、事务内写算好的绝对值——余额 100 的钱包并发提现
         * 两笔 80，两者都读到 100、都写 20：账面只扣一次，却产生两条 80 的提现记录。
         * rowsAffected=0 表示余额已被其它并发请求扣走，本次必须整体回滚。 */
        const debited = db.execute(pcoreCmdDebitWalletBalance({
          tenantId: input.tenantId,
          walletId: input.walletId,
          amountMinor,
          now,
        }));
        if (debited.rowsAffected !== 1) throw INSUFFICIENT;

        this.insertWalletTransactionInTx(db, {
          tenantId: input.tenantId,
          walletId: input.walletId,
          transactionType: 'owner_payout',
          amountMinor: -amountMinor,
          currency,
          referenceType: 'wallet_payout_request',
          referenceId: payoutId,
          actorType: 'human', /* 提现由 owner 经 HTTP 发起，已 owner 校验（ADR-0048 D2） */
        });
      });
    } catch (err) {
      if (err === INSUFFICIENT) return null;
      /* ⚠️ 审计 P4：领域幂等。带 idempotencyKey 重复提交时，
       * `(tenant_id, idempotency_key)` 部分唯一索引会在**数据库层**拒绝插入，
       * 整个事务回滚 → **余额不会二次扣减**。此时返回**既有**的那条提现请求，
       * 让重试对调用方表现为幂等成功（而不是抛 500 或再扣一次）。
       *
       * 为什么必须锚在领域数据上：HTTP 幂等插件把 claim 与业务写入放在两个事务，
       * claim 后崩溃、或 TTL（默认 24h）过期清理后重放，业务侧没有任何东西能识别
       * 「这笔已经处理过」。实测（无锚时）：同一笔提现连发两次 → 余额 1000 → 800。 */
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = this.findPayoutByIdempotencyKey(input.tenantId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }

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
  insertWalletTransactionInTx(tx: TransactionContext, input: {
    tenantId: string;
    walletId: string;
    transactionType: WalletTransactionType;
    amountMinor: number;
    currency: string;
    referenceType?: string | null;
    referenceId?: string | null;
    /** ADR-0048 D2：发起方类型。autonomous 不得 debit（负 amount）。默认 system。 */
    actorType?: WalletActorType;
  }): WalletTransaction {
    /* ADR-0048 D2 铁律在真实写路径强制：autonomous actor 不得出账。
     * 这是所有钱包 journal 写入的单一收口，覆盖 payout + settlement。 */
    const actorType: WalletActorType = input.actorType ?? 'system';
    const direction: WalletDirection = input.amountMinor < 0 ? 'debit' : 'credit';
    const guard = assertWalletMutationAllowed({
      actorType,
      direction,
      transactionType: input.transactionType,
      amountMinor: Math.abs(input.amountMinor),
    });
    if (!guard.allowed) {
      throw new ValidationError(`钱包写入被拒: ${guard.reason}`, ErrorCode.AUTH_INSUFFICIENT_ROLE);
    }
    const now = Date.now();
    const id = generatePrefixedId('wtx');
    tx.execute(pcoreCmdInsertWalletTransaction({
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
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryWalletByPersonaId({ tenantId, personaId }));
    return row ? walletFromRow(row) : null;
  }

  /**
   * @internal — used internally by requestWalletPayout's return
   * path. External callers should not assume this stays public.
   */
  getWalletPayoutRequestById(tenantId: string, payoutId: string): WalletPayoutRequest | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryWalletPayoutRequestById({ tenantId, payoutId }));
    return row ? walletPayoutRequestFromRow(row) : null;
  }

  /**
   * @internal — used by settleTaskPayment (still in core) to enforce
   * idempotency (don't double-pay). Will become private once the
   * settlement path is extracted into a marketplace sub-service.
   */
  getWalletSettlementByAssignmentId(tenantId: string, assignmentId: string): TaskWalletSettlement | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryWalletSettlementByAssignmentId({ tenantId, assignmentId }));
    return row ? walletSettlementFromRow(row) : null;
  }
}
