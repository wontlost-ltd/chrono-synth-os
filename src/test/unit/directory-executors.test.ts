/**
 * 租户分片 Phase 0 · Plan 1c Task 3 —— directory / bootstrap SQL 执行器行为验证。
 *
 * 这是 coordinator 目录（tenant_identity_directory）与 shard 内完成标记（tenant_bootstrap）
 * 的纯 SQL 工厂 + executor。本测在内存 sqlite（迁移到 v124）上钉死四条硬语义：
 *   ① reserve PENDING（带 userId + pendingPasswordHash）→ dirQueryByLookup 全元数据读回正确；
 *   ② 重复 reserve 同 lookup 不同 tenant/user/op（ON CONFLICT DO NOTHING）→ 不报错、行不变
 *      （operation_id/user_id 仍第一次的）—— 幂等占位而非撞错，canonical 身份来自读回；
 *   ③ dirCmdActivate 是 CAS：正确 operationId → rowsAffected=1 status=ACTIVE；错 operationId
 *      或已 ACTIVE 再激活 → rowsAffected=0（防他人越权激活），全靠 result.changes 判定；
 *   ④ bootCmdMarkComplete per-operation：markComplete 后 byOperation(tenant,op)=COMPLETE，
 *      不同 operation_id 查同 tenant → null（不被旧 COMPLETE 误证），重复 mark 幂等；
 *   另加：dirCmdDeleteByLookup / dirCmdDeleteByLookupOp（后者只删匹配 opId 的 PENDING）后查返 null。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, renderAllForTarget } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import {
  registerCoreSelfExecutors, resetCoreSelfExecutors,
} from '../../storage/executors/index.js';
import {
  resolveQueryExecutor, resolveCommandExecutor,
} from '../../storage/legacy-sync-bridge.js';
import {
  dirCmdReserve, dirCmdActivate, dirQueryByLookup, dirQueryPendingBefore,
  dirCmdDeleteByLookup, dirCmdDeleteByLookupOp,
  bootCmdMarkComplete, bootQueryByOperation,
} from '@chrono/kernel';
import type {
  DirectoryRow, DirectoryPendingRow, BootstrapRow,
  Query, Command,
} from '@chrono/kernel';

/** v124 在 sqlite 侧的 alias（canonical v124 → sqlite v124 / postgres v126）。 */
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

/** 直接经注册表跑一条 Query（单结果）—— 复用生产 executor，不重写 SQL。 */
function runQueryOne<TResult, TParams>(db: IDatabase, q: Query<TResult | null, TParams>): TResult | null {
  const executor = resolveQueryExecutor(q.kind);
  assert.ok(executor, `未注册的查询: ${q.kind}`);
  return (executor!(db, q.params) as TResult | null) ?? null;
}

/** 直接经注册表跑一条 Query（多结果）。 */
function runQueryMany<TResult, TParams>(db: IDatabase, q: Query<TResult, TParams>): readonly TResult[] {
  const executor = resolveQueryExecutor(q.kind);
  assert.ok(executor, `未注册的查询: ${q.kind}`);
  return executor!(db, q.params) as readonly TResult[];
}

/** 直接经注册表跑一条 Command，返回 rowsAffected（CAS 判定依据）。 */
function runCommand<TParams>(db: IDatabase, cmd: Command<TParams>): number {
  const executor = resolveCommandExecutor(cmd.kind);
  assert.ok(executor, `未注册的命令: ${cmd.kind}`);
  return executor!(db, cmd.params).rowsAffected;
}

const NOW = 1_700_000_000_000;

describe('directory / bootstrap SQL 执行器', () => {
  let db: IDatabase;

  beforeEach(() => {
    resetCoreSelfExecutors();
    registerCoreSelfExecutors();
    db = createMemoryDatabase();
    migrateToV124(db);
  });

  describe('目录 reserve / byLookup', () => {
    it('reserve PENDING（带 userId + pendingPasswordHash）→ byLookup 全元数据读回正确', () => {
      const affected = runCommand(db, dirCmdReserve({
        tenantId: 'tenant_a',
        userId: 'user_1',
        operationId: 'op_1',
        operationKind: 'REGISTER',
        previousLookupValue: null,
        pendingPasswordHash: 'argon2_hash_1',
        lookupKind: 'email',
        lookupValue: 'alice@example.com',
        status: 'PENDING',
        now: NOW,
      }));
      assert.equal(affected, 1, 'reserve 首次插入 rowsAffected=1');

      const row = runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'alice@example.com'));
      assert.ok(row, '应能按 lookup 读回');
      assert.equal(row!.tenant_id, 'tenant_a');
      assert.equal(row!.user_id, 'user_1', 'user_id 读回正确');
      assert.equal(row!.status, 'PENDING');
      assert.equal(row!.operation_id, 'op_1');
      assert.equal(row!.operation_kind, 'REGISTER');
      assert.equal(row!.previous_lookup_value, null);
      assert.equal(row!.pending_password_hash, 'argon2_hash_1', 'pending_password_hash 读回正确');
    });

    it('byLookup 未命中 → null', () => {
      const row = runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'nobody@example.com'));
      assert.equal(row, null);
    });

    it('重复 reserve 同 lookup 不同 tenant/user/op（ON CONFLICT DO NOTHING）→ 不报错、行不变、幂等', () => {
      runCommand(db, dirCmdReserve({
        tenantId: 'tenant_a', userId: 'user_1', operationId: 'op_1', operationKind: 'REGISTER',
        previousLookupValue: null, pendingPasswordHash: 'hash_1',
        lookupKind: 'email', lookupValue: 'dup@example.com', status: 'PENDING', now: NOW,
      }));

      /* 第二次 reserve 同 lookup（不同 tenant/user/op）→ DO NOTHING，rowsAffected=0，不抛错。 */
      const second = runCommand(db, dirCmdReserve({
        tenantId: 'tenant_b', userId: 'user_2', operationId: 'op_2', operationKind: 'REGISTER',
        previousLookupValue: null, pendingPasswordHash: 'hash_2',
        lookupKind: 'email', lookupValue: 'dup@example.com', status: 'PENDING', now: NOW + 1,
      }));
      assert.equal(second, 0, '重复 reserve 冲突 → rowsAffected=0（幂等，非撞错）');

      /* canonical 身份仍是第一次的（tenant_a / user_1 / op_1）。 */
      const row = runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'dup@example.com'));
      assert.equal(row!.tenant_id, 'tenant_a', '行不变：tenant 仍是第一次的');
      assert.equal(row!.user_id, 'user_1', '行不变：user_id 仍是第一次的');
      assert.equal(row!.operation_id, 'op_1', '行不变：operation_id 仍是第一次的');
    });
  });

  describe('目录 activate（CAS）', () => {
    beforeEach(() => {
      runCommand(db, dirCmdReserve({
        tenantId: 'tenant_a', userId: 'user_1', operationId: 'op_1', operationKind: 'REGISTER',
        previousLookupValue: null, pendingPasswordHash: 'hash_1',
        lookupKind: 'email', lookupValue: 'cas@example.com', status: 'PENDING', now: NOW,
      }));
    });

    it('正确 operationId → rowsAffected=1、status=ACTIVE', () => {
      const affected = runCommand(db, dirCmdActivate({
        operationId: 'op_1', lookupKind: 'email', lookupValue: 'cas@example.com', now: NOW + 100,
      }));
      assert.equal(affected, 1, 'CAS 命中 → rowsAffected=1');

      const row = runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'cas@example.com'));
      assert.equal(row!.status, 'ACTIVE', '激活后 status=ACTIVE');
    });

    it('错 operationId activate → rowsAffected=0（CAS 防他人激活）', () => {
      const affected = runCommand(db, dirCmdActivate({
        operationId: 'op_WRONG', lookupKind: 'email', lookupValue: 'cas@example.com', now: NOW + 100,
      }));
      assert.equal(affected, 0, '错 operationId → rowsAffected=0');

      const row = runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'cas@example.com'));
      assert.equal(row!.status, 'PENDING', '未被越权激活，仍 PENDING');
    });

    it('已 ACTIVE 再 activate → rowsAffected=0（无中间态重入）', () => {
      assert.equal(runCommand(db, dirCmdActivate({
        operationId: 'op_1', lookupKind: 'email', lookupValue: 'cas@example.com', now: NOW + 100,
      })), 1);

      const again = runCommand(db, dirCmdActivate({
        operationId: 'op_1', lookupKind: 'email', lookupValue: 'cas@example.com', now: NOW + 200,
      }));
      assert.equal(again, 0, '已 ACTIVE 再激活 → rowsAffected=0');
    });
  });

  describe('目录 pendingBefore / delete', () => {
    it('pendingBefore(cutoff) 只返 updated_at < cutoff 的 PENDING 项，含 operation_kind/previous/user', () => {
      runCommand(db, dirCmdReserve({
        tenantId: 'tenant_a', userId: 'user_old', operationId: 'op_old', operationKind: 'EMAIL_CHANGE',
        previousLookupValue: 'old@example.com', pendingPasswordHash: null,
        lookupKind: 'email', lookupValue: 'new@example.com', status: 'PENDING', now: NOW,
      }));
      runCommand(db, dirCmdReserve({
        tenantId: 'tenant_a', userId: 'user_fresh', operationId: 'op_fresh', operationKind: 'REGISTER',
        previousLookupValue: null, pendingPasswordHash: 'h',
        lookupKind: 'email', lookupValue: 'fresh@example.com', status: 'PENDING', now: NOW + 10_000,
      }));

      const stale = runQueryMany<DirectoryPendingRow, number>(db, dirQueryPendingBefore(NOW + 5_000));
      assert.equal(stale.length, 1, '只有 updated_at < cutoff 的一条');
      assert.equal(stale[0].operation_id, 'op_old');
      assert.equal(stale[0].operation_kind, 'EMAIL_CHANGE', 'operation_kind 返回（worker 分支）');
      assert.equal(stale[0].previous_lookup_value, 'old@example.com', 'previous_lookup_value 返回');
      assert.equal(stale[0].user_id, 'user_old', 'user_id 返回');
    });

    it('dirCmdDeleteByLookup 后查返 null（撤销清目录）', () => {
      runCommand(db, dirCmdReserve({
        tenantId: 'tenant_a', userId: 'u', operationId: 'op', operationKind: 'REGISTER',
        previousLookupValue: null, pendingPasswordHash: null,
        lookupKind: 'email', lookupValue: 'del@example.com', status: 'PENDING', now: NOW,
      }));
      assert.equal(runCommand(db, dirCmdDeleteByLookup('email', 'del@example.com')), 1);
      assert.equal(runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'del@example.com')), null);
    });

    it('dirCmdDeleteByLookupOp 只删匹配 opId 的 PENDING（不误删他人 / 已 ACTIVE）', () => {
      runCommand(db, dirCmdReserve({
        tenantId: 'tenant_a', userId: 'u', operationId: 'op_mine', operationKind: 'EMAIL_CHANGE',
        previousLookupValue: 'x@x.com', pendingPasswordHash: null,
        lookupKind: 'email', lookupValue: 'delop@example.com', status: 'PENDING', now: NOW,
      }));

      /* 错 op → 不删（0），行仍在。 */
      assert.equal(runCommand(db, dirCmdDeleteByLookupOp('email', 'delop@example.com', 'op_other')), 0);
      assert.ok(runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'delop@example.com')), '错 op 未删');

      /* 对 op → 删（1），查返 null。 */
      assert.equal(runCommand(db, dirCmdDeleteByLookupOp('email', 'delop@example.com', 'op_mine')), 1);
      assert.equal(runQueryOne<DirectoryRow, unknown>(db, dirQueryByLookup('email', 'delop@example.com')), null);
    });
  });

  describe('bootstrap markComplete / byOperation（per-operation）', () => {
    it('markComplete 后 byOperation(tenant,op)=COMPLETE', () => {
      assert.equal(runCommand(db, bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'op_1', now: NOW })), 1);
      const row = runQueryOne<BootstrapRow, unknown>(db, bootQueryByOperation('tenant_a', 'op_1'));
      assert.ok(row);
      assert.equal(row!.status, 'COMPLETE');
      assert.equal(row!.tenant_id, 'tenant_a');
      assert.equal(row!.operation_id, 'op_1');
    });

    it('不同 operationId 查同 tenant → null（per-operation 粒度，旧 COMPLETE 不误证）', () => {
      runCommand(db, bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'op_1', now: NOW }));
      const row = runQueryOne<BootstrapRow, unknown>(db, bootQueryByOperation('tenant_a', 'op_2'));
      assert.equal(row, null, '不同 operation_id 查同 tenant 应 null');
    });

    it('重复 markComplete 幂等（rowsAffected=0，不报错）', () => {
      assert.equal(runCommand(db, bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'op_1', now: NOW })), 1);
      const second = runCommand(db, bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'op_1', now: NOW + 1 }));
      assert.equal(second, 0, '重复 mark → rowsAffected=0（幂等）');
    });
  });
});
