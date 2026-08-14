/**
 * 租户分片 Phase 0 · Plan 1c Task 2 —— 历史数据回填迁移 v124 的行为验证。
 *
 * v124 是「绝不破坏用户空间」铁律的落地：升级前的老 users/api_keys/refresh_tokens
 * 没有任何 tenant_identity_directory 目录项，v124 把它们回填成 ACTIVE 目录项（operation_id='backfill'），
 * 从而升级后老用户的登录（email）、刷新令牌（refresh_token_hash）、API key（api_key_hash）
 * 都能被 coordinator 目录查找命中，无缝可用。
 *
 * 三条硬约束在此钉死：
 *   ① 回填 6 条 ACTIVE 项（email×3 / api_key×2 / token×1），operation_id='backfill'；
 *   ② email 归一化贯穿：目录项 lookup_value 全小写 + users.email 同步归一化为小写
 *      （否则 login 派生 canonical email 与 shard 内原大小写不符 → 老用户查不到）；
 *   ③ email 项 user_id = 对应 users.id（register 重试复用身份不重生）。
 * 另加：重跑幂等（ON CONFLICT DO NOTHING，无重复）；归一化后 email 冲突 fail-closed（抛错停止，不静默丢数据）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, renderAllForTarget } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';

/** v124 在 sqlite 侧的 alias（VERSION_MAP：canonical v124 → sqlite v124 / postgres v126）。 */
const V124_SQLITE = 'v124';

/**
 * 把 sqlite 迁移按渲染顺序（= VERSION_MAP 顺序）逐条应用，直到（含）目标版本为止。
 * 复用运行时 renderAllForTarget，确保测试跑的正是生产会跑的 SQL。
 */
function runSqliteMigrationsUpTo(db: IDatabase, targetVersion: string): void {
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
    if (migration.version === targetVersion) return;
  }
  throw new Error(`目标迁移版本 ${targetVersion} 未在 renderAllForTarget('sqlite-sql') 中找到`);
}

/** 单独应用一个已知版本的迁移（用于在 seed 之后再跑 v124）。 */
function applySqliteMigration(db: IDatabase, version: string): void {
  const migration = renderAllForTarget('sqlite-sql').find(m => m.version === version);
  assert.ok(migration, `迁移 ${version} 未找到`);
  db.transaction(() => {
    for (const sql of migration!.sql) db.exec(sql);
    db.prepare<void>(
      'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
    ).run(migration!.version, migration!.description, Date.now());
  });
}

/** 找到 v124 的前一个 sqlite 版本（用于把 schema 只跑到 v124 之前）。 */
function versionBefore(target: string): string {
  const versions = renderAllForTarget('sqlite-sql').map(m => m.version);
  const index = versions.indexOf(target);
  assert.ok(index > 0, `找不到 ${target} 的前一个版本`);
  return versions[index - 1];
}

interface DirectoryRow {
  readonly tenant_id: string;
  readonly user_id: string | null;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly lookup_kind: string;
  readonly lookup_value: string;
  readonly status: string;
}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly tenant_id: string;
}

function seedLegacyIdentityData(db: IDatabase): void {
  const now = 1_700_000_000_000;
  /* 3 个老 user：一个大小写混合 email（升级前直接落库的原始大小写）。 */
  const users: readonly [string, string, string][] = [
    ['user_1', 'User@Example.com', 'tenant_a'],
    ['user_2', '  alice@Foo.io ', 'tenant_a'],
    ['user_3', 'bob@bar.net', 'tenant_b'],
  ];
  for (const [id, email, tenant] of users) {
    db.prepare<void>(
      "INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, 'x', 'member', ?, ?, ?)",
    ).run(id, email, tenant, now, now);
  }
  /* 2 个 api_key。 */
  db.prepare<void>(
    "INSERT INTO api_keys (id, tenant_id, key_hash, plan_id, is_revoked, created_at) VALUES ('key_1', 'tenant_a', 'khash_1', 'free', 0, ?)",
  ).run(now);
  db.prepare<void>(
    "INSERT INTO api_keys (id, tenant_id, key_hash, plan_id, is_revoked, created_at) VALUES ('key_2', 'tenant_b', 'khash_2', 'free', 0, ?)",
  ).run(now);
  /* 1 个 refresh_token（挂 user_1，回填时 JOIN users 取 tenant_id=tenant_a）。 */
  db.prepare<void>(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, is_revoked, expires_at, created_at) VALUES ('rt_1', 'user_1', 'thash_1', 0, ?, ?)",
  ).run(now + 1_000_000, now);
}

function allDirectory(db: IDatabase): readonly DirectoryRow[] {
  return db.prepare<DirectoryRow>(
    'SELECT tenant_id, user_id, operation_id, operation_kind, lookup_kind, lookup_value, status FROM tenant_identity_directory ORDER BY lookup_kind, lookup_value',
  ).all();
}

describe('v124 历史身份数据回填（老用户零中断）', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    /* 只把 schema 跑到 v124 之前（v123 已建 tenant_identity_directory 空表），再手动 seed 老数据。 */
    runSqliteMigrationsUpTo(db, versionBefore(V124_SQLITE));
    seedLegacyIdentityData(db);
  });

  it('回填 6 条 ACTIVE 目录项（email×3 / api_key×2 / token×1），operation_id=backfill', () => {
    applySqliteMigration(db, V124_SQLITE);

    const rows = allDirectory(db);
    assert.equal(rows.length, 6, '应回填 6 条目录项');
    assert.ok(rows.every(r => r.status === 'ACTIVE'), '全部 ACTIVE');
    assert.ok(rows.every(r => r.operation_id === 'backfill'), '全部 operation_id=backfill');

    const byKind = (kind: string) => rows.filter(r => r.lookup_kind === kind);
    assert.equal(byKind('email').length, 3, 'email 项 3 条');
    assert.equal(byKind('refresh_token_hash').length, 1, 'token 项 1 条');
    assert.equal(byKind('api_key_hash').length, 2, 'api_key 项 2 条');

    /* operation_kind 逐类正确。 */
    assert.ok(byKind('email').every(r => r.operation_kind === 'REGISTER'), 'email 项 operation_kind=REGISTER');
    assert.ok(byKind('refresh_token_hash').every(r => r.operation_kind === 'TOKEN'), 'token 项 operation_kind=TOKEN');
    assert.ok(byKind('api_key_hash').every(r => r.operation_kind === 'API_KEY'), 'key 项 operation_kind=API_KEY');
  });

  it('email 归一化贯穿：目录 lookup_value 全小写 + users.email 同步归一化', () => {
    applySqliteMigration(db, V124_SQLITE);

    const emailRows = allDirectory(db).filter(r => r.lookup_kind === 'email');
    const values = emailRows.map(r => r.lookup_value).sort();
    assert.deepEqual(values, ['alice@foo.io', 'bob@bar.net', 'user@example.com'], 'email 目录项全小写去空白');

    /* users.email 也必须被归一化（login 派生 canonical email 与 shard 内一致的关键）。 */
    const users = db.prepare<UserRow>('SELECT id, email, tenant_id FROM users ORDER BY id').all();
    assert.deepEqual(
      users.map(u => u.email).sort(),
      ['alice@foo.io', 'bob@bar.net', 'user@example.com'],
      'users.email 已归一化为小写去空白',
    );
  });

  it('email 项 user_id = 对应 users.id + tenant_id 正确', () => {
    applySqliteMigration(db, V124_SQLITE);

    const emailRows = allDirectory(db).filter(r => r.lookup_kind === 'email');
    const byValue = new Map(emailRows.map(r => [r.lookup_value, r]));
    assert.equal(byValue.get('user@example.com')?.user_id, 'user_1');
    assert.equal(byValue.get('user@example.com')?.tenant_id, 'tenant_a');
    assert.equal(byValue.get('alice@foo.io')?.user_id, 'user_2');
    assert.equal(byValue.get('bob@bar.net')?.user_id, 'user_3');
    assert.equal(byValue.get('bob@bar.net')?.tenant_id, 'tenant_b');

    /* token 项 user_id=refresh_tokens.user_id，JOIN users 取 tenant_id。 */
    const tokenRow = allDirectory(db).find(r => r.lookup_kind === 'refresh_token_hash');
    assert.equal(tokenRow?.user_id, 'user_1');
    assert.equal(tokenRow?.tenant_id, 'tenant_a');
    assert.equal(tokenRow?.lookup_value, 'thash_1');

    /* key 项 user_id=NULL。 */
    const keyRows = allDirectory(db).filter(r => r.lookup_kind === 'api_key_hash');
    assert.ok(keyRows.every(r => r.user_id === null), 'key 项 user_id=NULL');
  });

  it('重跑幂等：第二次 v124 不新增、不重复、不报错', () => {
    applySqliteMigration(db, V124_SQLITE);
    const first = allDirectory(db);

    /* 直接重放 v124 的 SQL（不再插 schema_migrations，模拟迁移体本身重入安全）。 */
    const migration = renderAllForTarget('sqlite-sql').find(m => m.version === V124_SQLITE)!;
    db.transaction(() => {
      for (const sql of migration.sql) db.exec(sql);
    });

    const second = allDirectory(db);
    assert.equal(second.length, first.length, '重跑无新增');
    assert.equal(second.length, 6, '仍为 6 条');
  });

  it('归一化后 email 冲突 → fail-closed 抛错停止（不静默丢数据）', () => {
    /* 造两条归一化后相同的 email（历史脏数据 A@x.com / a@x.com）。 */
    const now = 1_700_000_000_001;
    db.prepare<void>(
      "INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES ('dup_1', 'A@x.com', 'x', 'member', 'tenant_c', ?, ?)",
    ).run(now, now);
    db.prepare<void>(
      "INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES ('dup_2', 'a@x.com', 'x', 'member', 'tenant_c', ?, ?)",
    ).run(now, now);

    /* 归一化后重复 email 触发 fail-closed 前置检测（临时表唯一约束抛错），迁移停止。 */
    assert.throws(
      () => applySqliteMigration(db, V124_SQLITE),
      /_v124_duplicate_email_abort/,
    );

    /* 事务回滚后不应留下任何 backfill 目录项（fail-closed，不静默丢）。 */
    const rows = allDirectory(db);
    assert.equal(rows.length, 0, 'fail-closed 后目录表无残留回填项');
  });
});
