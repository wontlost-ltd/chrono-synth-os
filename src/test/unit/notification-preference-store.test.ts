import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { NotificationPreferenceStore } from '../../storage/notification-preference-store.js';
import type { IDatabase } from '../../storage/database.js';

/**
 * 通知偏好 store（ADR-0054 红线 9）：默认关 + set/get round-trip + 安静时段 + 租户隔离。
 */
describe('NotificationPreferenceStore（ADR-0054 红线 9 同意层）', () => {
  let db: IDatabase;
  let store: NotificationPreferenceStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new NotificationPreferenceStore(db, () => 1000, 'tenant-a');
  });

  it('无 row → DEFAULT（推送默认关，红线 9）', () => {
    const p = store.get('user-1');
    assert.equal(p.nudgePushEnabled, false);
    assert.equal(p.quietStartMinute, null);
    assert.equal(p.quietEndMinute, null);
  });

  it('set → get round-trip（开 + 安静时段）', () => {
    store.set('user-1', { nudgePushEnabled: true, quietStartMinute: 1320, quietEndMinute: 420 });
    const p = store.get('user-1');
    assert.equal(p.nudgePushEnabled, true);
    assert.equal(p.quietStartMinute, 1320);
    assert.equal(p.quietEndMinute, 420);
  });

  it('upsert 覆盖（再 set 同 user 改值）', () => {
    store.set('user-1', { nudgePushEnabled: true, quietStartMinute: null, quietEndMinute: null });
    store.set('user-1', { nudgePushEnabled: false, quietStartMinute: 600, quietEndMinute: 660 });
    const p = store.get('user-1');
    assert.equal(p.nudgePushEnabled, false);
    assert.equal(p.quietStartMinute, 600);
  });

  it('安静时段越界（>1439 / 负数）→ null（不静默，安全侧）', () => {
    store.set('user-1', { nudgePushEnabled: true, quietStartMinute: 9999, quietEndMinute: -5 });
    const p = store.get('user-1');
    assert.equal(p.quietStartMinute, null);
    assert.equal(p.quietEndMinute, null);
  });

  it('租户隔离：A 设了不影响 B（B 仍 DEFAULT 关）', () => {
    store.set('user-1', { nudgePushEnabled: true, quietStartMinute: null, quietEndMinute: null });
    const storeB = new NotificationPreferenceStore(db, () => 1000, 'tenant-b');
    const pB = storeB.get('user-1');
    assert.equal(pB.nudgePushEnabled, false, 'tenant-b 同 userId 仍是 DEFAULT 关');
  });

  it('user 隔离：同租户另一 user 仍 DEFAULT', () => {
    store.set('user-1', { nudgePushEnabled: true, quietStartMinute: null, quietEndMinute: null });
    assert.equal(store.get('user-2').nudgePushEnabled, false);
  });
});
