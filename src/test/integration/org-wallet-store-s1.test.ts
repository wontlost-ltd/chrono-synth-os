/**
 * 组织金库 S1（org wallet）store 层测试——锁住 getOrCreate 幂等 / 入账 / CAS / frozen 禁出账 / (tenant,org) 唯一。
 *
 * org_wallets 是「数字组织从任务市场接工单赚钱」的账户地基：组织作为独立经济主体，工单报酬入此账户。
 * 本切片只验证存储原语（建库/入账/守卫），结算逻辑与市场桥接在 S3/S4。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';

describe('OrgWalletStore S1（组织金库存储原语）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let clock: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    clock = 1000;
  });

  it('★getOrCreate 幂等★：首次建 0 余额，重复调返回同一行不重建', () => {
    const w1 = store.getOrCreateOrgWallet('acme', 'wallet-1', clock);
    assert.equal(w1.orgId, 'acme');
    assert.equal(w1.balance, 0);
    assert.equal(w1.currency, 'CRED');
    assert.equal(w1.status, 'active');
    assert.equal(w1.lastSettledAt, null);
    /* 重复调（即使给不同 id）：返回既有，不重建。 */
    const w2 = store.getOrCreateOrgWallet('acme', 'wallet-2-ignored', clock + 1);
    assert.equal(w2.id, w1.id, '幂等：同一金库 id');
    assert.equal(w2.balance, 0);
  });

  it('★getOrgWallet：不存在 → undefined★', () => {
    assert.equal(store.getOrgWallet('ghost'), undefined);
  });

  it('★入账：credit 正数 → 余额增加 + lastSettledAt 更新★', () => {
    store.getOrCreateOrgWallet('acme', 'w', clock);
    const bal = store.creditOrgWallet('acme', 5000, clock + 10);
    assert.equal(bal, 5000, '入账 5000 后余额 5000');
    const w = store.getOrgWallet('acme')!;
    assert.equal(w.balance, 5000);
    assert.equal(w.lastSettledAt, clock + 10, 'lastSettledAt 更新');
    /* 再入账累加。 */
    assert.equal(store.creditOrgWallet('acme', 2500, clock + 20), 7500, '累加到 7500');
  });

  it('★出账：credit 负数 → 余额减少★', () => {
    store.getOrCreateOrgWallet('acme', 'w', clock);
    store.creditOrgWallet('acme', 10000, clock + 1);
    const bal = store.creditOrgWallet('acme', -3000, clock + 2);
    assert.equal(bal, 7000, '出账 3000 后余额 7000');
  });

  it('★金库不存在 → credit 返回 null★', () => {
    assert.equal(store.creditOrgWallet('ghost', 1000, clock), null);
  });

  it('★frozen 禁出账★：status=frozen 时 credit 返回 null，余额不变', () => {
    store.getOrCreateOrgWallet('acme', 'w', clock);
    store.creditOrgWallet('acme', 5000, clock + 1);
    /* 手动冻结（S1 无 freeze API，直接改 DB 模拟治理冻结）。 */
    db.prepare('UPDATE org_wallets SET status = ? WHERE tenant_id = ? AND org_id = ?').run('frozen', 't1', 'acme');
    const bal = store.creditOrgWallet('acme', -1000, clock + 2);
    assert.equal(bal, null, 'frozen 拒绝出账');
    assert.equal(store.getOrgWallet('acme')!.balance, 5000, '余额未变');
  });

  it('★(tenant,org) 唯一★：同租户同组织恰好一个金库；不同组织各自独立', () => {
    store.getOrCreateOrgWallet('acme', 'wa', clock);
    store.getOrCreateOrgWallet('beta', 'wb', clock);
    store.creditOrgWallet('acme', 1000, clock + 1);
    /* beta 金库不受 acme 入账影响。 */
    assert.equal(store.getOrgWallet('acme')!.balance, 1000);
    assert.equal(store.getOrgWallet('beta')!.balance, 0, '不同组织金库独立');
  });

  it('★租户隔离★：不同租户的同 orgId 金库互不可见', () => {
    store.getOrCreateOrgWallet('acme', 'wa', clock);
    store.creditOrgWallet('acme', 9000, clock + 1);
    const store2 = new OrgWorkforceStore(db, 't2');
    /* t2 看不到 t1 的 acme 金库。 */
    assert.equal(store2.getOrgWallet('acme'), undefined, 't2 看不到 t1 金库');
    /* t2 可独立建自己的 acme 金库。 */
    const w2 = store2.getOrCreateOrgWallet('acme', 'wa2', clock + 2);
    assert.equal(w2.balance, 0, 't2 独立金库');
    assert.equal(store.getOrgWallet('acme')!.balance, 9000, 't1 金库不受影响');
  });
});
