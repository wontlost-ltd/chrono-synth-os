/**
 * 租户分片 Phase 0 · Plan 1c Task 4 —— `TenantIdentityDirectory` 协调库门面行为验证。
 *
 * 门面把 Task 3 的 directory / bootstrap executor 包成语义方法（reserve/activate/resolve/record/
 * changeEmail），供 Auth service 层调；每方法经 `resolver.coordinatorDb()` 取协调库落地。本测用
 * `FakeMultiShardResolver`（coordinator 独立 db、shard 另一独立 db），钉死：
 *
 *   ① reserveTenant 写落 **coordinator db 非 shard**、存 pending_password_hash；首次 reserve
 *      `reservedByUs:true` 且 canonical 身份 === 传入、读回 pendingPasswordHash === 传入；
 *   ② **canonical 身份 + 密码 hash 重入锚**：同 operationId 重试（传不同随机 tenantId/userId）→ 仍
 *      `reservedByUs:true` 且 canonicalTenantId === 第一次的（非本次随机）+ pendingPasswordHash === 第一次；
 *   ③ 他人先占（另一 opId 手插 email 行）后本次 reserve（不同 opId）→ `reservedByUs:false`；
 *   ④ reservePasswordlessTenant：新 email→PENDING `reservedByUs:true` + 返 operationId；email 已属他
 *      tenant（先占）→ false（无「tenant_id 相等即属己」的无证明续做）；
 *   ⑤ resolveByEmail PENDING 返 status=PENDING + userId + pendingPasswordHash；activate 后 ACTIVE；
 *   ⑥ resolveByRefreshTokenHash / resolveByApiKeyHash 只在 ACTIVE 命中；
 *   ⑦ recordActiveLookup 遇既存他租户映射 → throw（冲突不假定同映射）；
 *   ⑧ changeEmail 三方法：reserveEmailChange→新 PENDING(kind=EMAIL_CHANGE,previous=old)+旧仍 ACTIVE，
 *      completeEmailChange→新 ACTIVE+旧删，rollbackEmailChange→按 opId 删新 PENDING、旧仍 ACTIVE。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, renderAllForTarget } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import {
  registerCoreSelfExecutors, resetCoreSelfExecutors,
} from '../../storage/executors/index.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { TenantIdentityDirectory } from '../../identity/tenant-identity-directory.js';
import { dirCmdReserve } from '@chrono/kernel';
import { canonicalizeEmail } from '../../identity/email-canonical.js';

/** v124 在 sqlite 侧的 alias（canonical v124 → sqlite v124）。 */
const V124_SQLITE = 'v124';

/** 把 sqlite 迁移逐条应用直到（含）v124，为 directory / bootstrap 表建好结构。 */
function migrateToV124(db: IDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  for (const migration of renderAllForTarget('sqlite-sql')) {
    for (const sql of migration.sql) db.exec(sql);
    db.prepare<void>(
      'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
    ).run(migration.version, migration.description, Date.now());
    if (migration.version === V124_SQLITE) return;
  }
  throw new Error(`目标迁移版本 ${V124_SQLITE} 未在 renderAllForTarget('sqlite-sql') 中找到`);
}

const NOW = 1_700_000_000_000;

describe('TenantIdentityDirectory 协调库门面', () => {
  let coordinator: IDatabase;
  let shard: IDatabase;
  let dir: TenantIdentityDirectory;

  beforeEach(() => {
    resetCoreSelfExecutors();
    registerCoreSelfExecutors();
    coordinator = createMemoryDatabase();
    shard = createMemoryDatabase();
    migrateToV124(coordinator);
    migrateToV124(shard);
    /* tenant → shard 映射：仅供 dbForTenant，本门面只用 coordinatorDb，shard 用来断言「没写错库」。 */
    dir = new TenantIdentityDirectory(new FakeMultiShardResolver({
      coordinator,
      shards: { s0: shard },
      tenantToShard: { tenant_a: 's0', tenant_b: 's0' },
    }));
  });

  /** 直接查协调库某 email 目录项（绕门面，验证「真落 coordinator」）。 */
  function coordRow(email: string): { tenant_id: string; status: string; pending_password_hash: string | null } | undefined {
    return coordinator.prepare<{ tenant_id: string; status: string; pending_password_hash: string | null }>(
      'SELECT tenant_id, status, pending_password_hash FROM tenant_identity_directory WHERE lookup_kind = ? AND lookup_value = ?',
    ).get('email', canonicalizeEmail(email));
  }

  describe('reserveTenant（register）', () => {
    it('首次 reserve：reservedByUs:true + canonical===传入 + 落 coordinator 非 shard + 存 pendingPasswordHash', () => {
      const out = dir.reserveTenant({
        tenantId: 'tenant_a', userId: 'user_1', operationId: 'reg:op1',
        pendingPasswordHash: 'argon2_hash_A', email: 'Alice@Example.com',
      });

      assert.equal(out.reservedByUs, true, '首次 reserve 属己');
      assert.equal(out.canonicalTenantId, 'tenant_a');
      assert.equal(out.canonicalUserId, 'user_1');
      assert.equal(out.pendingPasswordHash, 'argon2_hash_A', '读回 pendingPasswordHash === 传入');

      /* 真落 coordinator（email 已归一化小写）。 */
      const row = coordRow('Alice@Example.com');
      assert.ok(row, 'reserve 写落 coordinator db');
      assert.equal(row!.tenant_id, 'tenant_a');
      assert.equal(row!.status, 'PENDING');
      assert.equal(row!.pending_password_hash, 'argon2_hash_A', 'coordinator 存 pending_password_hash');

      /* 没有误写进 shard（shard 目录表应空）。 */
      const shardRow = shard.prepare(
        'SELECT tenant_id FROM tenant_identity_directory WHERE lookup_kind = ? AND lookup_value = ?',
      ).get('email', 'alice@example.com');
      assert.equal(shardRow, undefined, 'reserve 不写 shard db');
    });

    it('canonical 身份重入锚：同 operationId 重试（传不同随机 tenantId/userId）→ 仍属己 + canonical===第一次 + hash===第一次', () => {
      dir.reserveTenant({
        tenantId: 'tenant_first', userId: 'user_first', operationId: 'reg:same',
        pendingPasswordHash: 'hash_first', email: 'retry@example.com',
      });

      /* 重试：客户端重发同 Idempotency-Key（operationId），但本地生成的 tenantId/userId 是新随机值。 */
      const retry = dir.reserveTenant({
        tenantId: 'tenant_SECOND_random', userId: 'user_SECOND_random', operationId: 'reg:same',
        pendingPasswordHash: 'hash_SECOND', email: 'retry@example.com',
      });

      assert.equal(retry.reservedByUs, true, '同 opId 重试仍属己（幂等重入）');
      assert.equal(retry.canonicalTenantId, 'tenant_first', 'canonical 身份是第一次持久化的，非本次随机');
      assert.equal(retry.canonicalUserId, 'user_first', 'canonicalUserId 是第一次的');
      assert.equal(retry.pendingPasswordHash, 'hash_first', 'pendingPasswordHash 复用第一次的（密码 hash 重入）');
    });

    it('他人先占 email（另一 opId 手插）后本次 reserve（不同 opId）→ reservedByUs:false', () => {
      /* 模拟另一并发流程先占了同 email（不同 operationId）。 */
      coordinator.execute(dirCmdReserve({
        tenantId: 'tenant_other', userId: 'user_other', operationId: 'reg:other',
        operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: 'hash_other',
        lookupKind: 'email', lookupValue: 'taken@example.com', status: 'PENDING', now: NOW,
      }));

      const out = dir.reserveTenant({
        tenantId: 'tenant_mine', userId: 'user_mine', operationId: 'reg:mine',
        pendingPasswordHash: 'hash_mine', email: 'taken@example.com',
      });

      assert.equal(out.reservedByUs, false, '他人先占 → 不属己');
      assert.equal(out.canonicalTenantId, 'tenant_other', 'canonical 是先占者的');
      assert.equal(out.canonicalUserId, 'user_other');
      assert.equal(out.pendingPasswordHash, 'hash_other', '读回先占者持久化的 hash');
    });

    it('撞遗留 passwordless PENDING（pending_password_hash=NULL）→ reservedByUs:false 不抛 500', () => {
      /* 崩溃遗留：SSO/SCIM 的 reservePasswordlessTenant 写过一条 PENDING（pending_password_hash=NULL）。 */
      coordinator.execute(dirCmdReserve({
        tenantId: 'tenant_sso', userId: 'user_sso', operationId: 'reg:sso_pre',
        operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
        lookupKind: 'email', lookupValue: 'collide@example.com', status: 'PENDING', now: NOW,
      }));

      /* 密码 register 撞同 email（不同 operationId）：读回行 hash 为 NULL，但因 reservedByUs:false，
       * requireHash 不求值——绝不抛 StorageError(500)，而是返回 pendingPasswordHash:null 供调用方转 409。 */
      let out!: ReturnType<TenantIdentityDirectory['reserveTenant']>;
      assert.doesNotThrow(() => {
        out = dir.reserveTenant({
          tenantId: 'tenant_mine', userId: 'user_mine', operationId: 'reg:mine',
          pendingPasswordHash: 'hash_mine', email: 'collide@example.com',
        });
      }, '撞 passwordless 遗留 PENDING 绝不抛 500/StorageError');

      assert.equal(out.reservedByUs, false, '他人先占（passwordless）→ 不属己');
      assert.equal(out.canonicalTenantId, 'tenant_sso', 'canonical 是既存 passwordless 行的');
      assert.equal(out.canonicalUserId, 'user_sso');
      assert.equal(out.pendingPasswordHash, null, 'passwordless 遗留行 hash 为 null，原样返回不抛');
    });
  });

  describe('reservePasswordlessTenant（SSO/SCIM）', () => {
    it('新 email → PENDING reservedByUs:true + 返回随机 operationId', () => {
      const out = dir.reservePasswordlessTenant({
        tenantId: 'tenant_a', userId: 'user_sso', email: 'Sso@Example.com',
      });

      assert.equal(out.reservedByUs, true, '新 email 属己');
      assert.equal(out.canonicalTenantId, 'tenant_a');
      assert.equal(out.canonicalUserId, 'user_sso');
      assert.ok(out.operationId.startsWith('reg:'), 'operationId 形如 reg:<uuid>');

      const row = coordRow('Sso@Example.com');
      assert.ok(row);
      assert.equal(row!.status, 'PENDING');
      assert.equal(row!.pending_password_hash, null, 'passwordless 无 pendingPasswordHash');
    });

    it('email 已属他 tenant（先占）→ reservedByUs:false（无 tenant 相等即续做）', () => {
      coordinator.execute(dirCmdReserve({
        tenantId: 'tenant_a', userId: 'user_pre', operationId: 'reg:pre',
        operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
        lookupKind: 'email', lookupValue: 'ssotaken@example.com', status: 'PENDING', now: NOW,
      }));

      const out = dir.reservePasswordlessTenant({
        tenantId: 'tenant_a', userId: 'user_new', email: 'ssotaken@example.com',
      });

      assert.equal(out.reservedByUs, false, '冲突一律不属己（哪怕 tenant_id 相等）');
      assert.equal(out.canonicalTenantId, 'tenant_a');
      assert.equal(out.operationId, 'reg:pre', '返回读回行的 canonical operationId');
    });
  });

  describe('activateTenant + resolveByEmail', () => {
    it('reserve→resolveByEmail 返 PENDING+userId+pendingPasswordHash；activate 后 ACTIVE', () => {
      dir.reserveTenant({
        tenantId: 'tenant_a', userId: 'user_1', operationId: 'reg:act',
        pendingPasswordHash: 'hash_act', email: 'act@example.com',
      });

      const pending = dir.resolveByEmail('Act@Example.com');
      assert.ok(pending);
      assert.equal(pending!.tenantId, 'tenant_a');
      assert.equal(pending!.userId, 'user_1');
      assert.equal(pending!.status, 'PENDING');
      assert.equal(pending!.operationKind, 'REGISTER');
      assert.equal(pending!.pendingPasswordHash, 'hash_act');

      const ok = dir.activateTenant({ email: 'act@example.com', operationId: 'reg:act' });
      assert.equal(ok, true, 'CAS 命中 → 激活成功');

      const active = dir.resolveByEmail('act@example.com');
      assert.equal(active!.status, 'ACTIVE', '激活后 ACTIVE');
    });

    it('activate 错 operationId → false（CAS 防越权），resolveByEmail 未命中 → null', () => {
      dir.reserveTenant({
        tenantId: 'tenant_a', userId: 'user_1', operationId: 'reg:right',
        pendingPasswordHash: 'h', email: 'cas@example.com',
      });
      assert.equal(dir.activateTenant({ email: 'cas@example.com', operationId: 'reg:WRONG' }), false);
      assert.equal(dir.resolveByEmail('nobody@example.com'), null);
    });
  });

  describe('resolveByRefreshTokenHash / resolveByApiKeyHash（只 ACTIVE 命中）', () => {
    it('recordActiveLookup 建 ACTIVE token/key 项 → 各自 resolve 返 tenantId', () => {
      dir.recordActiveLookup({ tenantId: 'tenant_a', lookupKind: 'refresh_token_hash', lookupValue: 'rt_hash_1' });
      dir.recordActiveLookup({ tenantId: 'tenant_b', lookupKind: 'api_key_hash', lookupValue: 'ak_hash_1' });

      assert.deepEqual(dir.resolveByRefreshTokenHash('rt_hash_1'), { tenantId: 'tenant_a' });
      assert.deepEqual(dir.resolveByApiKeyHash('ak_hash_1'), { tenantId: 'tenant_b' });
      assert.equal(dir.resolveByRefreshTokenHash('rt_missing'), null);
      assert.equal(dir.resolveByApiKeyHash('ak_missing'), null);
    });

    it('PENDING 的 token 键不被 resolveByRefreshTokenHash 命中（只 ACTIVE）', () => {
      /* 手插一条 PENDING token 键（正常不会出现，但守卫须只认 ACTIVE）。 */
      coordinator.execute(dirCmdReserve({
        tenantId: 'tenant_a', userId: null, operationId: 'op:t', operationKind: 'TOKEN',
        previousLookupValue: null, pendingPasswordHash: null,
        lookupKind: 'refresh_token_hash', lookupValue: 'rt_pending', status: 'PENDING', now: NOW,
      }));
      assert.equal(dir.resolveByRefreshTokenHash('rt_pending'), null, 'PENDING 不命中');
    });

    it('recordActiveLookup 遇既存他租户映射 → throw（冲突不假定同映射）', () => {
      dir.recordActiveLookup({ tenantId: 'tenant_a', lookupKind: 'refresh_token_hash', lookupValue: 'rt_conflict' });
      assert.throws(
        () => dir.recordActiveLookup({ tenantId: 'tenant_b', lookupKind: 'refresh_token_hash', lookupValue: 'rt_conflict' }),
        /租户|冲突|conflict|拒绝/,
        '同键映射到不同 tenant → 抛错',
      );
    });

    it('recordActiveLookup 幂等：同租户同键重复 → 不抛错', () => {
      dir.recordActiveLookup({ tenantId: 'tenant_a', lookupKind: 'api_key_hash', lookupValue: 'ak_idem' });
      assert.doesNotThrow(
        () => dir.recordActiveLookup({ tenantId: 'tenant_a', lookupKind: 'api_key_hash', lookupValue: 'ak_idem' }),
        '同映射重复 record 幂等',
      );
    });
  });

  describe('changeEmail 三方法', () => {
    beforeEach(() => {
      /* 旧 email 已 ACTIVE（老用户在用）。 */
      dir.reserveTenant({
        tenantId: 'tenant_a', userId: 'user_1', operationId: 'reg:old',
        pendingPasswordHash: 'h', email: 'old@example.com',
      });
      dir.activateTenant({ email: 'old@example.com', operationId: 'reg:old' });
    });

    it('reserveEmailChange → 新 email PENDING(kind=EMAIL_CHANGE,previous=old) + 旧仍 ACTIVE', () => {
      dir.reserveEmailChange({
        tenantId: 'tenant_a', userId: 'user_1',
        oldEmail: 'old@example.com', newEmail: 'New@Example.com', operationId: 'ec:1',
      });

      const created = dir.resolveByEmail('new@example.com');
      assert.ok(created);
      assert.equal(created!.status, 'PENDING');
      assert.equal(created!.operationKind, 'EMAIL_CHANGE');
      assert.equal(created!.previousLookupValue, 'old@example.com', 'previous_lookup_value=canon(oldEmail)');

      const oldRow = dir.resolveByEmail('old@example.com');
      assert.equal(oldRow!.status, 'ACTIVE', '旧 email 项保留、仍 ACTIVE');
    });

    it('reserveEmailChange 新 email 冲突他人 → throw', () => {
      /* 他人已占了目标 email。 */
      dir.reserveTenant({
        tenantId: 'tenant_b', userId: 'user_2', operationId: 'reg:conf',
        pendingPasswordHash: 'h2', email: 'wanted@example.com',
      });
      assert.throws(
        () => dir.reserveEmailChange({
          tenantId: 'tenant_a', userId: 'user_1',
          oldEmail: 'old@example.com', newEmail: 'wanted@example.com', operationId: 'ec:conf',
        }),
        /冲突|conflict|已被/i,
        '新 email 被他人占 → 抛错',
      );
    });

    it('completeEmailChange → 新 ACTIVE + 旧删', () => {
      dir.reserveEmailChange({
        tenantId: 'tenant_a', userId: 'user_1',
        oldEmail: 'old@example.com', newEmail: 'fresh@example.com', operationId: 'ec:2',
      });
      dir.completeEmailChange({ oldEmail: 'old@example.com', newEmail: 'fresh@example.com', operationId: 'ec:2' });

      assert.equal(dir.resolveByEmail('fresh@example.com')!.status, 'ACTIVE', '新 email ACTIVE');
      assert.equal(dir.resolveByEmail('old@example.com'), null, '旧 email 已删');
    });

    it('completeEmailChange 错 operationId（CAS 未命中）→ throw + 旧 email 仍 ACTIVE + 新未激活（不锁死账号）', () => {
      /* 新 email 已 reserve（正确 opId=ec:cas），但恢复 worker/重试用了 stale/错 operationId 调 complete。 */
      dir.reserveEmailChange({
        tenantId: 'tenant_a', userId: 'user_1',
        oldEmail: 'old@example.com', newEmail: 'target@example.com', operationId: 'ec:cas',
      });

      /* CAS 按 operationId 匹配 PENDING→ACTIVE；传错 opId → 不命中，须抛错且绝不删旧。 */
      assert.throws(
        () => dir.completeEmailChange({ oldEmail: 'old@example.com', newEmail: 'target@example.com', operationId: 'ec:WRONG' }),
        /CAS|未命中|失败/,
        'CAS 未命中 → 抛错通知调用方完成失败',
      );

      /* 铁律「绝不破坏用户空间」：旧 email 仍权威 ACTIVE，用户可继续 login。 */
      const oldRow = dir.resolveByEmail('old@example.com');
      assert.equal(oldRow!.status, 'ACTIVE', 'CAS 未命中 → 旧 email 保留、仍 ACTIVE（未锁死账号）');
      /* 新 email 未激活（仍 PENDING）。 */
      assert.equal(dir.resolveByEmail('target@example.com')!.status, 'PENDING', 'CAS 未命中 → 新 email 未激活');
    });

    it('rollbackEmailChange → 按 opId 删新 PENDING、旧仍 ACTIVE', () => {
      dir.reserveEmailChange({
        tenantId: 'tenant_a', userId: 'user_1',
        oldEmail: 'old@example.com', newEmail: 'aborted@example.com', operationId: 'ec:3',
      });
      dir.rollbackEmailChange({ newEmail: 'aborted@example.com', operationId: 'ec:3' });

      assert.equal(dir.resolveByEmail('aborted@example.com'), null, '未竟新 PENDING 已删');
      assert.equal(dir.resolveByEmail('old@example.com')!.status, 'ACTIVE', '旧 email 仍权威 ACTIVE');
    });
  });

  describe('removeLookup + listPending', () => {
    it('removeLookup 尽力清目录项', () => {
      dir.recordActiveLookup({ tenantId: 'tenant_a', lookupKind: 'refresh_token_hash', lookupValue: 'rt_rm' });
      dir.removeLookup('refresh_token_hash', 'rt_rm');
      assert.equal(dir.resolveByRefreshTokenHash('rt_rm'), null, 'removeLookup 后不命中');
    });

    it('listPending(cutoff) 返 updated_at < cutoff 的 PENDING 工单（含 operationKind/previous/lookup）', () => {
      /* 手插一条老 PENDING（updated_at 早于 cutoff）。 */
      coordinator.execute(dirCmdReserve({
        tenantId: 'tenant_a', userId: 'user_stale', operationId: 'ec:stale', operationKind: 'EMAIL_CHANGE',
        previousLookupValue: 'was@example.com', pendingPasswordHash: null,
        lookupKind: 'email', lookupValue: 'stale@example.com', status: 'PENDING', now: NOW,
      }));

      const pending = dir.listPending(NOW + 1_000);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].tenantId, 'tenant_a');
      assert.equal(pending[0].userId, 'user_stale');
      assert.equal(pending[0].operationId, 'ec:stale');
      assert.equal(pending[0].operationKind, 'EMAIL_CHANGE');
      assert.equal(pending[0].previousLookupValue, 'was@example.com');
      assert.equal(pending[0].lookupKind, 'email');
      assert.equal(pending[0].lookupValue, 'stale@example.com');
    });
  });
});
