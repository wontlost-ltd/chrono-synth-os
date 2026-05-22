/**
 * P0-D #2 — JwtKeyStore persistence integration tests.
 *
 * Scenarios:
 *   - boot-time load on empty DB returns undefined (caller falls back to env seed);
 *   - persist + reload round-trips the full ring (active + grace);
 *   - rotate() in-memory followed by persist+reload preserves the new active;
 *   - multi-instance simulation: two stores against the same DB observe the
 *     same active key after rotate+persist from one side.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';
import { JwtKeyStore } from '../../server/plugins/jwt-key-store.js';
import { KeyRing, type JwtKeyEntry } from '../../server/plugins/jwt-keyring.js';
import { FieldEncryption } from '../../storage/encryption.js';
import {
  SqliteDatabase,
  runDslSqliteMigrations,
  type IDatabase,
} from '../../storage/index.js';

const TEST_MASTER_KEY = randomBytes(32).toString('base64');

function fieldCrypto(): FieldEncryption {
  return new FieldEncryption({
    enabled: true,
    masterKey: TEST_MASTER_KEY,
    keyRotationIntervalDays: 90,
  });
}

const SECRET_A = 'secret-A-'.padEnd(48, 'a');
const SECRET_B = 'secret-B-'.padEnd(48, 'b');
const SECRET_C = 'secret-C-'.padEnd(48, 'c');

function entry(kid: string, state: 'active' | 'grace' | 'retired' | 'compromised', secret: string): JwtKeyEntry {
  return { kid, state, algorithm: 'HS256', privateKey: '', publicKey: '', secret };
}

describe('P0-D #2 — JwtKeyStore persistence', () => {
  const opened: IDatabase[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function freshDb(): IDatabase {
    const db = new SqliteDatabase(':memory:');
    runDslSqliteMigrations(db);
    opened.push(db);
    return db;
  }

  function sharedFileDb(): { dbA: IDatabase; dbB: IDatabase } {
    const dir = mkdtempSync(join(tmpdir(), 'chrono-jwt-store-'));
    tempDirs.push(dir);
    const path = join(dir, 'keys.sqlite');
    const dbA = new SqliteDatabase(path);
    runDslSqliteMigrations(dbA);
    const dbB = new SqliteDatabase(path);
    opened.push(dbA, dbB);
    return { dbA, dbB };
  }

  it('loadKeyRing returns undefined on an empty database', () => {
    const store = new JwtKeyStore(freshDb());
    assert.equal(store.loadKeyRing(), undefined);
  });

  it('persist + reload round-trips the active + grace entries', () => {
    const db = freshDb();
    const store = new JwtKeyStore(db);
    const initial = new KeyRing([
      entry('kA', 'active', SECRET_A),
      entry('kB', 'grace', SECRET_B),
    ]);
    store.persistKeyRing(initial);

    const reloaded = store.reloadKeyRing();
    assert.ok(reloaded);
    assert.equal(reloaded!.activeKid(), 'kA');
    const view = reloaded!.snapshot();
    assert.deepEqual(view.graceKeys.map(k => k.kid), ['kB']);
  });

  it('rotate + persist updates the visible active for a fresh store on the same DB', () => {
    const { dbA, dbB } = sharedFileDb();
    const storeA = new JwtKeyStore(dbA);
    const storeB = new JwtKeyStore(dbB);

    const ring = new KeyRing([entry('kA', 'active', SECRET_A)]);
    storeA.persistKeyRing(ring);

    /* B 在 rotate 前看到 kA */
    const beforeRotate = storeB.reloadKeyRing();
    assert.equal(beforeRotate?.activeKid(), 'kA');

    /* A 旋转到 kC，旧 active kA 进入 grace */
    ring.rotate({
      newActiveKid: 'kC',
      addNew: [entry('kC', 'grace', SECRET_C)],
    });
    storeA.persistKeyRing(ring);

    /* B 重新加载，应能看到新 active = kC，kA 在 grace 列表里 */
    const afterRotate = storeB.reloadKeyRing();
    assert.ok(afterRotate);
    assert.equal(afterRotate!.activeKid(), 'kC');
    const snap = afterRotate!.snapshot();
    assert.deepEqual(snap.graceKeys.map(k => k.kid), ['kA']);
  });

  it('persistKeyRing is atomic — partial failure does not leave the table in a half-state', () => {
    const db = freshDb();
    const store = new JwtKeyStore(db);
    const ring = new KeyRing([entry('kA', 'active', SECRET_A)]);
    store.persistKeyRing(ring);

    /* 模拟 broken store：手工破坏 prepare 语句应抛错，事务回滚后表保持旧版本 */
    const broken = new JwtKeyStore({
      ...db,
      prepare: () => { throw new Error('simulated SQL prepare failure'); },
    } as unknown as IDatabase);
    assert.throws(() => broken.persistKeyRing(new KeyRing([entry('kZ', 'active', SECRET_B)])));

    const reloaded = store.reloadKeyRing();
    assert.equal(reloaded?.activeKid(), 'kA');
  });

  it('persistKeyRing rolls back when an insert fails mid-transaction (DELETE not visible)', () => {
    const db = freshDb();
    const store = new JwtKeyStore(db);
    store.persistKeyRing(new KeyRing([entry('kA', 'active', SECRET_A), entry('kB', 'grace', SECRET_B)]));

    /* 制造一个在第二行 INSERT 时失败的 store：让 prepare 在第 N 次调用时
     * 返回一个 run 抛错的 stmt。第一次（DELETE 的 prepare 不被调用——exec 直接走 db.exec）
     * 我们包装 prepare 让其返回 .run 抛错，模拟 INSERT 失败。 */
    let preparesAfterDelete = 0;
    const failingDb = {
      ...db,
      prepare: <T>(sql: string) => {
        const real = db.prepare<T>(sql);
        if (sql.trim().startsWith('INSERT INTO jwt_signing_keys')) {
          preparesAfterDelete += 1;
          if (preparesAfterDelete === 2) {
            /* 第二条 INSERT 失败 */
            return {
              run: () => { throw new Error('simulated insert failure on second row'); },
              get: real.get.bind(real),
              all: real.all.bind(real),
            };
          }
        }
        return real;
      },
    };
    const sabotagedStore = new JwtKeyStore(failingDb as unknown as IDatabase);

    assert.throws(() => sabotagedStore.persistKeyRing(
      new KeyRing([entry('kC', 'active', SECRET_C), entry('kD', 'grace', SECRET_A)]),
    ));

    /* 事务回滚后，原表应保持 kA/kB 状态 */
    const reloaded = store.reloadKeyRing();
    assert.ok(reloaded);
    assert.equal(reloaded.activeKid(), 'kA');
    assert.deepEqual(reloaded.snapshot().graceKeys.map(k => k.kid), ['kB']);
  });

  it('encrypts private_key and secret at rest when fieldCrypto is provided', () => {
    const db = freshDb();
    const crypto = fieldCrypto();
    const store = new JwtKeyStore(db, { fieldCrypto: crypto });
    store.persistKeyRing(new KeyRing([entry('kE', 'active', SECRET_A)]));

    /* 直接读 raw secret 列 — 必须密文，不能是明文 SECRET_A */
    const row = db.prepare<{ secret: string }>(
      `SELECT secret FROM jwt_signing_keys WHERE kid = ?`,
    ).get('kE');
    assert.ok(row, 'row should exist');
    assert.notEqual(row!.secret, SECRET_A, '密钥必须密文存储');

    /* reload 后能正确解密 */
    const reloaded = store.reloadKeyRing();
    assert.ok(reloaded);
    assert.equal(reloaded.allEntries().find(e => e.kid === 'kE')?.secret, SECRET_A);
  });

  it('preserves all four states on reload (retired + compromised)', () => {
    const db = freshDb();
    const store = new JwtKeyStore(db);
    const ring = new KeyRing([
      entry('a', 'active', SECRET_A),
      entry('g', 'grace', SECRET_B),
      entry('r', 'retired', ''),
      entry('c', 'compromised', ''),
    ]);
    store.persistKeyRing(ring);

    const reloaded = store.reloadKeyRing();
    assert.ok(reloaded);
    const states = new Map(reloaded.allEntries().map(e => [e.kid, e.state]));
    assert.equal(states.get('a'), 'active');
    assert.equal(states.get('g'), 'grace');
    assert.equal(states.get('r'), 'retired');
    assert.equal(states.get('c'), 'compromised');
  });

  it('preserves created_at and state_changed_at across persist when metadata is passed', () => {
    const db = freshDb();
    const store = new JwtKeyStore(db);
    const ring = new KeyRing([entry('p', 'active', SECRET_A)]);
    store.persistKeyRing(ring, { now: new Date('2026-01-01T00:00:00Z') });

    const meta = store.loadMetadata();
    assert.equal(meta.get('p')?.createdAt, '2026-01-01T00:00:00.000Z');

    /* Re-persist later with the metadata snapshot preserves the original created_at */
    store.persistKeyRing(ring, { metadata: meta, now: new Date('2026-05-01T00:00:00Z') });
    const meta2 = store.loadMetadata();
    assert.equal(meta2.get('p')?.createdAt, '2026-01-01T00:00:00.000Z');
  });

  it('applyRemoteStates propagates retire/compromise across instances', () => {
    const { dbA, dbB } = sharedFileDb();
    const storeA = new JwtKeyStore(dbA);
    const storeB = new JwtKeyStore(dbB);

    const ringA = new KeyRing([
      entry('kA', 'active', SECRET_A),
      entry('kB', 'grace', SECRET_B),
    ]);
    storeA.persistKeyRing(ringA);

    /* B 启动时 load */
    const ringB = storeB.reloadKeyRing();
    assert.ok(ringB);
    assert.equal(ringB.get('kB')?.state, 'grace');

    /* A 把 kB 标记为 compromised 并持久化 */
    ringA.applyRemoteStates(new Map([['kB', 'compromised']]));
    storeA.persistKeyRing(ringA);

    /* B 周期 reload 后应该看到 kB compromised */
    const fresh = storeB.reloadKeyRing();
    assert.equal(fresh?.get('kB')?.state, 'compromised');
    const changed = ringB.applyRemoteStates(new Map([['kB', 'compromised']]));
    assert.deepEqual(changed, ['kB']);
    assert.equal(ringB.get('kB')?.state, 'compromised');

    /* 安全检查：applyRemoteStates 不应允许把 kB 重新提升为 active */
    const changed2 = ringB.applyRemoteStates(new Map([['kB', 'active']]));
    assert.deepEqual(changed2, [], 'remote cannot promote a non-active kid to active');
    assert.equal(ringB.activeKid(), 'kA');

    /* 安全检查：revocation monotonicity — compromised 不可被复活为 grace/active */
    const changedResurrect = ringB.applyRemoteStates(new Map([['kB', 'grace']]));
    assert.deepEqual(changedResurrect, [], 'remote snapshot must not resurrect a compromised key');
    assert.equal(ringB.get('kB')?.state, 'compromised', 'compromised key state is monotonic');
  });

  it('applyRemoteStates allows retired → compromised escalation but not de-escalation', () => {
    const { dbA } = sharedFileDb();
    const store = new JwtKeyStore(dbA);
    const ring = new KeyRing([
      entry('kA', 'active', SECRET_A),
      entry('kR', 'retired', ''),
    ]);
    store.persistKeyRing(ring);

    /* retired → compromised：允许（升级吊销级别） */
    const escalated = ring.applyRemoteStates(new Map([['kR', 'compromised']]));
    assert.deepEqual(escalated, ['kR']);
    assert.equal(ring.get('kR')?.state, 'compromised');

    /* compromised → retired：拒绝（降级吊销级别） */
    const noChange = ring.applyRemoteStates(new Map([['kR', 'retired']]));
    assert.deepEqual(noChange, []);
    assert.equal(ring.get('kR')?.state, 'compromised');
  });

  it('encryption keyRef defaults to "master" but can be overridden', () => {
    const db = freshDb();
    /* 自定义 keyring 包含两条密钥；使用非默认 keyRef 加密以校验
     * 配置传播是否生效（密文前缀 v2.<keyRef>.）。 */
    const crypto = new FieldEncryption({
      enabled: true,
      masterKey: TEST_MASTER_KEY,
      keyring: { 'rotation-2026': randomBytes(32).toString('base64') },
      keyRotationIntervalDays: 90,
    });
    const store = new JwtKeyStore(db, { fieldCrypto: crypto, keyRef: 'rotation-2026' });
    store.persistKeyRing(new KeyRing([entry('rk', 'active', SECRET_A)]));

    const row = db.prepare<{ secret: string }>(
      `SELECT secret FROM jwt_signing_keys WHERE kid = ?`,
    ).get('rk');
    assert.ok(row?.secret.startsWith('v2.rotation-2026.'), `expected non-master keyRef ciphertext prefix, got: ${row?.secret.slice(0, 40)}`);

    const reloaded = store.reloadKeyRing();
    assert.equal(reloaded?.allEntries().find(e => e.kid === 'rk')?.secret, SECRET_A);
  });
});
