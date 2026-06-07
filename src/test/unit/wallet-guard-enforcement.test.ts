/**
 * ADR-0048 D2：钱包"只增不减"守卫在真实写路径强制（不只是 kernel 纯函数）。
 * 验证 PersonaWalletService.insertWalletTransaction 这个唯一 journal 收口：
 *   - autonomous actor 的 debit（负 amount）→ 抛错拒绝
 *   - autonomous credit / human debit / system debit → 允许
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { PersonaWalletService } from '../../persona-core/persona-wallet-service.js';

describe('Wallet credit-only guard enforced on real write path (ADR-0048 D2)', () => {
  let db: IDatabase;
  let walletId: string;
  let wallet: PersonaWalletService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const now = Date.now();
    db.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('u_owner', 'o@e.com', 'h', 'member', 'default', now, now);
    /* 通过完整服务创建 persona（连带创建钱包） */
    const core = new PersonaCoreService(db);
    const persona = core.createPersona({
      tenantId: 'default', ownerUserId: 'u_owner', displayName: 'Earner',
      profile: { mission: 'work' },
    });
    walletId = persona.wallet.id;
    /* 直接持有 wallet service（同一 db），context 桩 */
    wallet = new PersonaWalletService(db, { personaExists: () => true });
  });

  it('autonomous debit（负 amount）被拒（铁律生效）', () => {
    assert.throws(
      () => wallet.insertWalletTransaction({
        tenantId: 'default', walletId, transactionType: 'owner_payout',
        amountMinor: -500, currency: 'CRED', actorType: 'autonomous',
      }),
      /钱包写入被拒|autonomous actor may not debit/,
    );
  });

  it('autonomous credit（赚）允许', () => {
    const tx = wallet.insertWalletTransaction({
      tenantId: 'default', walletId, transactionType: 'task_payment',
      amountMinor: 500, currency: 'CRED', actorType: 'autonomous',
    });
    assert.equal(tx.amountMinor, 500);
  });

  it('human debit（人类确认提现）允许', () => {
    const tx = wallet.insertWalletTransaction({
      tenantId: 'default', walletId, transactionType: 'owner_payout',
      amountMinor: -300, currency: 'CRED', actorType: 'human',
    });
    assert.equal(tx.amountMinor, -300);
  });

  it('system debit（结算扣平台费）允许', () => {
    const tx = wallet.insertWalletTransaction({
      tenantId: 'default', walletId, transactionType: 'platform_fee',
      amountMinor: -50, currency: 'CRED', actorType: 'system',
    });
    assert.equal(tx.amountMinor, -50);
  });

  it('默认 actor=system：未指定时按 system 处理（settlement 兼容）', () => {
    /* 不传 actorType，负 amount（platform_fee 结算）应允许 */
    const tx = wallet.insertWalletTransaction({
      tenantId: 'default', walletId, transactionType: 'platform_fee',
      amountMinor: -25, currency: 'CRED',
    });
    assert.equal(tx.amountMinor, -25);
  });

  /* ── 方向矩阵在真实写路径生效（ADR-0048）：type 与金额符号语义错配被拒 ── */

  it('owner_payout 正数（应是 debit 却当 credit 入账）被拒——即便 system actor', () => {
    assert.throws(
      () => wallet.insertWalletTransaction({
        tenantId: 'default', walletId, transactionType: 'owner_payout',
        amountMinor: 500, currency: 'CRED', actorType: 'system',
      }),
      /direction matrix|must be debit/,
    );
  });

  it('task_payment 负数（应是 credit 却当 debit）被拒', () => {
    assert.throws(
      () => wallet.insertWalletTransaction({
        tenantId: 'default', walletId, transactionType: 'task_payment',
        amountMinor: -500, currency: 'CRED', actorType: 'human',
      }),
      /direction matrix|must be credit/,
    );
  });

  it('persona_reserve 正数（应是 debit）被拒——修正后矩阵生效', () => {
    assert.throws(
      () => wallet.insertWalletTransaction({
        tenantId: 'default', walletId, transactionType: 'persona_reserve',
        amountMinor: 360, currency: 'CRED', actorType: 'system',
      }),
      /direction matrix|must be debit/,
    );
  });
});
