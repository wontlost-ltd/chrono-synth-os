/**
 * Unit tests for EP-3.5 push token invalidation persistence.
 *
 * Covers:
 *   - v071 SQLite migration adds is_invalid_at column + partial index
 *   - markTokenInvalid writes the timestamp (idempotently)
 *   - findById returns the new field
 *   - updatePushToken clears the invalidation marker (re-registration
 *     is presumed-valid)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';

function makeService(): { db: IDatabase; svc: MobileDeviceService } {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const svc = new MobileDeviceService(db);
  return { db, svc };
}

describe('MobileDeviceService — token invalidation (EP-3.5)', () => {
  it('v071 migration adds is_invalid_at column to devices table', () => {
    const { db } = makeService();
    try {
      const cols = db
        .prepare<{ name: string }>('PRAGMA table_info(devices)')
        .all() as Array<{ name: string }>;
      const hasInvalid = cols.some((c) => c.name === 'is_invalid_at');
      assert.equal(hasInvalid, true, 'expected is_invalid_at column on devices');
    } finally {
      db.close();
    }
  });

  it('register persists a device with is_invalid_at = null by default', () => {
    const { db, svc } = makeService();
    try {
      const reg = svc.register('tenant_1', 'user_1', {
        deviceUid: 'uid-1',
        platform: 'ios',
        pushToken: 'TOKEN_A',
      });
      const row = svc.findById(reg.id);
      assert.ok(row, 'device should be findable by id');
      assert.equal(row!.is_invalid_at, null);
      assert.equal(row!.push_token, 'TOKEN_A');
    } finally {
      db.close();
    }
  });

  it('markTokenInvalid sets is_invalid_at on the row', () => {
    const { db, svc } = makeService();
    try {
      const reg = svc.register('tenant_1', 'user_1', {
        deviceUid: 'uid-2',
        platform: 'ios',
        pushToken: 'TOKEN_B',
      });
      svc.markTokenInvalid(reg.id, 'BadDeviceToken');
      const row = svc.findById(reg.id);
      assert.ok(row);
      assert.ok(typeof row!.is_invalid_at === 'number' && row!.is_invalid_at > 0);
    } finally {
      db.close();
    }
  });

  it('markTokenInvalid is idempotent — second call keeps the earlier timestamp', async () => {
    const { db, svc } = makeService();
    try {
      const reg = svc.register('tenant_1', 'user_1', {
        deviceUid: 'uid-3',
        platform: 'ios',
        pushToken: 'TOKEN_C',
      });
      svc.markTokenInvalid(reg.id, 'first');
      const first = svc.findById(reg.id)!.is_invalid_at;
      /* Real wall-clock advancement so the second timestamp would
       * differ if we accidentally overwrote on idempotent re-mark. */
      await new Promise((r) => setTimeout(r, 5));
      svc.markTokenInvalid(reg.id, 'second');
      const second = svc.findById(reg.id)!.is_invalid_at;
      assert.equal(second, first, 'COALESCE should preserve the earliest timestamp');
    } finally {
      db.close();
    }
  });

  it('updatePushToken clears is_invalid_at — re-registration is presumed valid', () => {
    const { db, svc } = makeService();
    try {
      const reg = svc.register('tenant_1', 'user_1', {
        deviceUid: 'uid-4',
        platform: 'ios',
        pushToken: 'TOKEN_OLD',
      });
      svc.markTokenInvalid(reg.id);
      assert.ok(svc.findById(reg.id)!.is_invalid_at !== null);

      svc.updatePushToken(reg.id, 'user_1', 'TOKEN_NEW');
      const row = svc.findById(reg.id)!;
      assert.equal(row.is_invalid_at, null, 'new token should clear the invalidation marker');
      assert.equal(row.push_token, 'TOKEN_NEW');
    } finally {
      db.close();
    }
  });

  it('register on existing device path clears prior invalidation when a fresh token is provided', () => {
    /* 移动端（usePushSync）现把 POST /api/v1/devices 注册作为 push token 注册路径——失效后重装/
     * 重注册带新 token，必须清 is_invalid_at，否则 dispatcher 永久跳过该设备、push 不可恢复
     * （Codex 交叉审查 High）。updateOnRegister 现在在 pushToken 非空时清失效标记（与 updatePushToken
     * 同语义：新 token 推定有效）。 */
    const { db, svc } = makeService();
    try {
      const reg = svc.register('tenant_1', 'user_1', {
        deviceUid: 'uid-5',
        platform: 'ios',
        pushToken: 'TOKEN_X',
      });
      svc.markTokenInvalid(reg.id);
      assert.ok(svc.findById(reg.id)!.is_invalid_at !== null, '先确认已标失效');
      /* 重注册同 deviceUid 带新 token（模拟重装）→ 走 updateOnRegister 分支。 */
      svc.register('tenant_1', 'user_1', {
        deviceUid: 'uid-5',
        platform: 'ios',
        pushToken: 'TOKEN_Y',
      });
      const row = svc.findById(reg.id)!;
      assert.equal(row.is_invalid_at, null, '带新 token 的重注册清除失效标记（push 可恢复）');
      assert.equal(row.push_token, 'TOKEN_Y');
    } finally {
      db.close();
    }
  });

  it('register on existing device WITHOUT a token (metadata-only) keeps the invalidation marker', () => {
    /* 纯元数据重注册（pushToken 缺省 → null）不应误清失效标记——只有携带新 token 才推定有效。 */
    const { db, svc } = makeService();
    try {
      const reg = svc.register('tenant_1', 'user_1', { deviceUid: 'uid-6', platform: 'ios', pushToken: 'TOKEN_Z' });
      svc.markTokenInvalid(reg.id);
      svc.register('tenant_1', 'user_1', { deviceUid: 'uid-6', platform: 'android' }); // 无 pushToken
      assert.notEqual(svc.findById(reg.id)!.is_invalid_at, null, '无新 token 的元数据重注册保留失效标记');
    } finally {
      db.close();
    }
  });
});
