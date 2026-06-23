/**
 * 组织金库结算 S3（OrgWalletService.settleOrgTaskPayment）——市场工单报酬两方分账入组织金库。
 *
 * 验证：两方分账（平台抽成 + 组织净留存）算术正确、净额入金库、两笔流水、幂等（同工单只结算一次）、
 * 入参校验（金额≤0/抽成越界拒）、冻结金库拒。确定性可复现。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgWalletService } from '../../workforce/org-wallet-service.js';

describe('OrgWalletService S3（组织金库结算·两方分账·幂等）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: OrgWalletService;
  let clock: number;
  let counter: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    clock = 1000; counter = 0;
    svc = new OrgWalletService(store, () => clock, () => `id-${++counter}`);
  });

  it('★两方分账：total=10000, platform=20% → 平台 2000 / 组织净留存 8000 入金库★', () => {
    const s = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: 'g1', totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 });
    assert.ok(s, '结算成功');
    assert.equal(s!.totalAmountMinor, 10000);
    assert.equal(s!.platformAmountMinor, 2000, '平台抽成 2000');
    assert.equal(s!.orgAmountMinor, 8000, '组织净留存 8000');
    assert.equal(s!.goalId, 'g1', '溯源到目标');
    /* 金库余额 = 组织净留存。 */
    assert.equal(store.getOrgWallet('acme')!.balance, 8000, '金库入账组织净留存');
  });

  it('★两笔流水：task_payment(+total) + platform_fee(-platform)，净=org★', () => {
    const s = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 })!;
    const wallet = store.getOrgWallet('acme')!;
    const txns = store.listOrgWalletTransactions(wallet.id);
    assert.equal(txns.length, 2, '两笔流水');
    const byType = new Map(txns.map((t) => [t.transactionType, t.amountMinor]));
    assert.equal(byType.get('task_payment'), 10000, '报酬入账 +10000');
    assert.equal(byType.get('platform_fee'), -2000, '平台抽成 -2000');
    /* 流水净额 = 入金库余额。 */
    const net = txns.reduce((sum, t) => sum + t.amountMinor, 0);
    assert.equal(net, 8000, '流水净额 = 组织净留存');
    assert.equal(net, store.getOrgWallet('acme')!.balance, '净额 = 金库余额');
    void s;
  });

  it('★幂等：同工单结算两次 → 第二次返回既有，余额不翻倍★', () => {
    const s1 = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 })!;
    const s2 = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 })!;
    assert.equal(s2.id, s1.id, '幂等：返回同一结算记录');
    assert.equal(store.getOrgWallet('acme')!.balance, 8000, '余额不翻倍（仍 8000）');
    assert.equal(store.listOrgWalletTransactions(store.getOrgWallet('acme')!.id).length, 2, '流水未重复（仍 2 笔）');
  });

  it('★平台抽成 0% → 全额入组织★', () => {
    const s = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 5000, currency: 'CRED', platformPct: 0 })!;
    assert.equal(s.platformAmountMinor, 0);
    assert.equal(s.orgAmountMinor, 5000);
    assert.equal(store.getOrgWallet('acme')!.balance, 5000);
  });

  it('★尾差不丢：total=10001, platform=33% → floor 33 → platform 3300 / org 6701（和=total）★', () => {
    const s = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 10001, currency: 'CRED', platformPct: 33 })!;
    assert.equal(s.platformAmountMinor, 3300, 'floor(10001*0.33)=3300');
    assert.equal(s.orgAmountMinor, 6701, '组织拿余下，和=total');
    assert.equal(s.platformAmountMinor + s.orgAmountMinor, 10001, '无尾差丢失');
  });

  it('★入参校验：金额≤0 / 抽成越界 → null★', () => {
    assert.equal(svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'm', goalId: null, totalAmountMinor: 0, currency: 'CRED', platformPct: 20 }), null, '金额 0 拒');
    assert.equal(svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'm', goalId: null, totalAmountMinor: -100, currency: 'CRED', platformPct: 20 }), null, '负金额拒');
    assert.equal(svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'm', goalId: null, totalAmountMinor: 100, currency: 'CRED', platformPct: 101 }), null, '抽成 >100 拒');
    assert.equal(svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'm', goalId: null, totalAmountMinor: 100, currency: 'CRED', platformPct: -1 }), null, '抽成 <0 拒');
  });

  it('★冻结金库 → 结算拒（null），余额不变★', () => {
    /* 先建金库并冻结。 */
    store.getOrCreateOrgWallet('acme', 'w', clock);
    db.prepare('UPDATE org_wallets SET status = ? WHERE tenant_id = ? AND org_id = ?').run('frozen', 't1', 'acme');
    const s = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 });
    assert.equal(s, null, '冻结金库拒绝结算');
    assert.equal(store.getOrgWallet('acme')!.balance, 0, '余额不变');
    /* 无残留结算记录（事务未进入或回滚）。 */
    assert.equal(store.getOrgWalletSettlementBySourceTask('mkt-1'), undefined, '无残留结算记录');
  });

  it('★多工单累加：两个不同工单结算 → 余额累加★', () => {
    svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 });
    svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-2', goalId: null, totalAmountMinor: 5000, currency: 'CRED', platformPct: 20 });
    /* 8000 + 4000 = 12000。 */
    assert.equal(store.getOrgWallet('acme')!.balance, 12000, '两工单组织净留存累加');
  });

  it('★确定性可复现：相同输入 → 相同分账★', () => {
    const a = svc.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 9999, currency: 'CRED', platformPct: 17 })!;
    /* 另一库重放。 */
    const db2 = createMemoryDatabase();
    runDslSqliteMigrations(db2);
    const store2 = new OrgWorkforceStore(db2, 't1');
    let c2 = 0;
    const svc2 = new OrgWalletService(store2, () => clock, () => `id-${++c2}`);
    const b = svc2.settleOrgTaskPayment({ orgId: 'acme', sourceMarketplaceTaskId: 'mkt-1', goalId: null, totalAmountMinor: 9999, currency: 'CRED', platformPct: 17 })!;
    assert.equal(a.platformAmountMinor, b.platformAmountMinor, '相同平台抽成');
    assert.equal(a.orgAmountMinor, b.orgAmountMinor, '相同组织净留存');
  });
});
