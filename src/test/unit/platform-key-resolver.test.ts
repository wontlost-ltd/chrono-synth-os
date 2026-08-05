import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { PlatformKeyResolver } from '../../data-plane/platform-key-resolver.js';
import type { IDatabase } from '../../storage/database.js';

const TEST_KEY = Buffer.alloc(32).toString('base64');

function makeResolver(db: IDatabase): PlatformKeyResolver {
  return new PlatformKeyResolver(
    { defaultKeyRef: 'master', keyring: { master: TEST_KEY } },
    db,
  );
}

describe('PlatformKeyResolver', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });

  it('resolve() returns KeyHandle with correct algorithm', async () => {
    const resolver = makeResolver(db);
    const handle = await resolver.resolve('master', 'encrypt');
    assert.equal(handle.keyRef, 'master');
    assert.equal(handle.algorithm, 'aes-256-gcm');
  });

  it('resolve() with decrypt purpose returns valid KeyHandle', async () => {
    const resolver = makeResolver(db);
    const handle = await resolver.resolve('master', 'decrypt');
    assert.equal(handle.keyRef, 'master');
    assert.equal(handle.algorithm, 'aes-256-gcm');
  });

  it('resolve() throws for unknown keyRef', async () => {
    const resolver = makeResolver(db);
    await assert.rejects(() => resolver.resolve('nonexistent', 'encrypt'));
  });

  /* 审计 Warning B5-7：原实现生成 32 字节密钥材料后直接丢弃，只返回
   * `master.v<时间戳>` 这个**永远无法 resolve** 的引用。原两条测试只断言返回值
   * 形状（前缀、算法名），从不验证该引用可用——于是「轮换后数据永久不可解」这一
   * 后果被绿灯掩盖。现契约为显式 fail-closed：本 resolver 不支持轮换。 */
  it('rotate() 显式拒绝——不返回无法解析的密钥引用', async () => {
    const resolver = makeResolver(db);
    await assert.rejects(
      () => resolver.rotate('master'),
      /不支持密钥轮换/,
      '必须明确拒绝，而非返回一个之后 resolve 必然失败的引用',
    );
  });

  it('拒绝轮换后原密钥仍可正常解析（拒绝无副作用）', async () => {
    const resolver = makeResolver(db);
    await assert.rejects(() => resolver.rotate('master'));
    const handle = await resolver.resolve('master', 'decrypt');
    assert.equal(handle.keyRef, 'master');
  });

  it('revoke() is idempotent - second call does not throw', async () => {
    const resolver = makeResolver(db);

    await resolver.revoke('master');
    await assert.doesNotReject(() => resolver.revoke('master'));

    const row = db.prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_key_revocations WHERE key_ref = ?',
    ).get('master');
    assert.equal(row?.count, 1);
  });

  it('revoke() then resolve() throws revoked error', async () => {
    const resolver = makeResolver(db);
    await resolver.revoke('master');
    await assert.rejects(
      () => resolver.resolve('master', 'decrypt'),
      (err: unknown) => err instanceof Error && (err as Error).message.includes('已撤销'),
    );
  });

  it('revoked keys persist across resolver instances', async () => {
    const resolver1 = makeResolver(db);
    await resolver1.revoke('master');

    const resolver2 = makeResolver(db);
    await assert.rejects(() => resolver2.resolve('master', 'decrypt'));
  });
});
