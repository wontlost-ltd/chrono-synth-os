/**
 * 单元测试：UserOauthTokenService（F2）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { UserOauthTokenService } from '../../agent/user-oauth-token-service.js';
import { FieldEncryption } from '../../storage/encryption.js';

function makeService() {
  const db = createMemoryDatabase();
  runMigrations(db);
  const masterKey = randomBytes(32).toString('base64');
  const encryption = new FieldEncryption({
    enabled: true,
    masterKey,
    keyRotationIntervalDays: 90,
  });
  const service = new UserOauthTokenService(db, encryption);
  return { db, service, encryption };
}

describe('UserOauthTokenService', () => {
  it('upsert + get 解密返回明文 access/refresh', () => {
    const { db, service } = makeService();
    try {
      const expiresAt = Date.now() + 3600_000;
      service.upsert({
        tenantId: 'default',
        userId: 'user_a',
        provider: 'google',
        scope: 'https://www.googleapis.com/auth/calendar',
        accessToken: 'plain_access',
        refreshToken: 'plain_refresh',
        accessExpiresAt: expiresAt,
      });
      const token = service.get({
        tenantId: 'default',
        userId: 'user_a',
        provider: 'google',
        scope: 'https://www.googleapis.com/auth/calendar',
      });
      assert.ok(token);
      assert.equal(token?.accessToken, 'plain_access');
      assert.equal(token?.refreshToken, 'plain_refresh');
      assert.equal(token?.accessExpiresAt, expiresAt);
    } finally { db.close(); }
  });

  it('upsert 同 (tenant,user,provider,scope) 复用同一行 ID', () => {
    const { db, service } = makeService();
    try {
      const r1 = service.upsert({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's1',
        accessToken: 'a1', refreshToken: 'r1',
        accessExpiresAt: Date.now() + 1000_000,
      });
      const r2 = service.upsert({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's1',
        accessToken: 'a2', refreshToken: null,
        accessExpiresAt: Date.now() + 2000_000,
      });
      assert.equal(r1.id, r2.id);
      const token = service.get({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's1',
      });
      assert.equal(token?.accessToken, 'a2');
      /* refresh 留存（不被 null 覆盖） */
      assert.equal(token?.refreshToken, 'r1');
    } finally { db.close(); }
  });

  it('revoke 后 get 返回 null', () => {
    const { db, service } = makeService();
    try {
      const { id } = service.upsert({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's1',
        accessToken: 'a', refreshToken: 'r',
        accessExpiresAt: Date.now() + 1000_000,
      });
      const ok = service.revoke(id, 'user_initiated');
      assert.equal(ok, true);
      const token = service.get({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's1',
      });
      assert.equal(token, null);
    } finally { db.close(); }
  });

  it('listByUser 不包含 revoked，且不暴露明文 token', () => {
    const { db, service } = makeService();
    try {
      service.upsert({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's1',
        accessToken: 'a1', refreshToken: 'r1',
        accessExpiresAt: Date.now() + 1000_000,
      });
      const { id } = service.upsert({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's2',
        accessToken: 'a2', refreshToken: 'r2',
        accessExpiresAt: Date.now() + 1000_000,
      });
      service.revoke(id, 'cleanup');
      const list = service.listByUser('default', 'user_a');
      assert.equal(list.length, 1);
      assert.equal(list[0].scope, 's1');
      /* metadata-only 类型 */
      assert.equal((list[0] as unknown as Record<string, unknown>).accessToken, undefined);
      assert.equal((list[0] as unknown as Record<string, unknown>).refreshToken, undefined);
    } finally { db.close(); }
  });

  it('upsert 拒绝过期时间 <= now', () => {
    const { db, service } = makeService();
    try {
      assert.throws(() => service.upsert({
        tenantId: 'default', userId: 'user_a', provider: 'google', scope: 's1',
        accessToken: 'a', refreshToken: null,
        accessExpiresAt: Date.now() - 1,
      }));
    } finally { db.close(); }
  });
});
