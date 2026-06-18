import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { CompanionIdentityStore } from '../../storage/companion-identity-store.js';
import type { IDatabase } from '../../storage/database.js';

/* ADR-0055 数字人第一人称身份 store：set/get round-trip + 改名覆盖 + 清洗防御 + 租户隔离。 */
describe('CompanionIdentityStore（ADR-0055 第一人称身份）', () => {
  let db: IDatabase;
  let store: CompanionIdentityStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new CompanionIdentityStore(db, 'tenant-a', 'default');
  });

  it('无 row → undefined（尚未起名）', () => {
    assert.equal(store.getName(), undefined);
  });

  it('setName → getName round-trip', () => {
    store.setName('张三', 1000);
    assert.equal(store.getName(), '张三');
  });

  it('改名覆盖（用户显式定义合法覆盖）', () => {
    store.setName('小黑', 1000);
    store.setName('大白', 2000);
    assert.equal(store.getName(), '大白');
  });

  it('清洗防御：剥离控制字符与尖括号（防 markup）', () => {
    const saved = store.setName('小\n明<script>', 1000);
    assert.equal(saved, '小明script');
    assert.ok(!/[<>\n]/.test(store.getName() ?? ''), '名字不含控制字符/尖括号');
  });

  it('清洗后为空 → 抛错（不落空名字）', () => {
    assert.throws(() => store.setName('<>', 1000), /拒绝落库/);
  });

  it('超长名字截断', () => {
    const saved = store.setName('阿'.repeat(100), 1000);
    assert.ok(saved.length <= 40, '名字截断到 40');
  });

  it('租户隔离：A 的名字 B 看不到', () => {
    store.setName('张三', 1000);
    const storeB = new CompanionIdentityStore(db, 'tenant-b', 'default');
    assert.equal(storeB.getName(), undefined, 'B 租户无名字');
  });
});
