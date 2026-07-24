import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * 租户分片 Phase 0 · Plan 1c Task 2 —— tenant_bootstrap 标记表 + 历史身份数据回填。
 *
 * 这是「绝不破坏用户空间」铁律的落地（向后兼容硬前置）：升级前的老 users / api_keys /
 * refresh_tokens 没有任何 tenant_identity_directory（v123 建的 coordinator 目录）项，
 * 升级后 login / refresh / api-key 查找会全部落空。本迁移把它们回填成 ACTIVE 目录项，
 * 老用户零中断。
 *
 * 产物 1 —— tenant_bootstrap 标记表（shard 内表）：
 *   register 单事务在落 shard 用户后写一条 COMPLETE 标记，恢复 worker 据此判定「本次 operation
 *   已确认落 shard」。主键 (tenant_id, operation_id) 是 **per-operation 粒度**：SCIM/OIDC 向已有
 *   tenant 加用户是**独立 operation**，不能靠 tenant 级旧 COMPLETE 误证本次完成。status CHECK 只允许
 *   'COMPLETE'（标记存在即完成，不存在即未完成，无中间态）。
 *
 * 产物 2 —— 历史回填（幂等）：把三类历史身份键回填进 tenant_identity_directory，均为
 *   operation_id='backfill' / status='ACTIVE' / pending_password_hash=NULL / previous_lookup_value=NULL
 *   （老 ACTIVE 项不参与 PENDING 续做，NULL 合理），逐类显式填 operation_kind + 全部 NOT NULL 列：
 *     - email 项：operation_kind='REGISTER'、user_id=users.id、lookup_kind='email'、
 *       lookup_value=LOWER(TRIM(email))（**email 归一化**）；
 *     - token 项：operation_kind='TOKEN'、user_id=refresh_tokens.user_id（JOIN users 取 tenant_id）、
 *       lookup_kind='refresh_token_hash'、lookup_value=refresh_tokens.token_hash；
 *     - key 项：operation_kind='API_KEY'、user_id=NULL、lookup_kind='api_key_hash'、
 *       lookup_value=api_keys.key_hash。
 *   幂等：SQLite 用 INSERT OR IGNORE、PG 用 ON CONFLICT (lookup_kind, lookup_value) DO NOTHING
 *   （tenant_identity_directory 的全局唯一键），重跑不重复。
 *
 * 产物 3 —— 同步归一化 users.email（UPDATE users SET email = LOWER(TRIM(email))）：
 *   否则 login 派生的 canonical email（也归一化）与 shard 内原大小写不匹配 → 老用户查不到。
 *   **前置冲突检测（fail-closed）**：归一化后可能撞车（历史脏数据 A@x.com / a@x.com）。归一化 UPDATE
 *   会触发 users.email UNIQUE 约束抛错，但为了在**改任何数据之前**就 fail-closed、给出可审计信号，先跑一段
 *   显式检测：
 *     - SQLite：建一张临时表，其 norm_email 列带 UNIQUE，`INSERT ... SELECT LOWER(TRIM(email)) FROM users`
 *       —— 有重复即抛 UNIQUE constraint failed（表名 _v124_duplicate_email_abort 使信号可审计），随后 DROP；
 *       无重复则临时表建好即删、零副作用。
 *     - PG：DO $$ 块 IF EXISTS(GROUP BY lower(trim(email)) HAVING count(*)>1) THEN RAISE EXCEPTION。
 *   有冲突 → 迁移抛错停止（整个迁移在一个事务里，回滚不落任何回填项，不静默丢数据）；人工清理后再跑。
 *
 * 单库（升级路径）users / directory 同库，回填直接跑；多库跨 shard 汇总留激活部署工具
 * （Phase 0 fail-closed 仍挡多库，只有单库真跑，此降级可接受——known-limitation）。
 *
 * 数据迁移（INSERT SELECT / UPDATE / 条件抛错）无法用 schema DSL（create-table/index 等）表达，
 * 故与 v027/v034 历史回填一致，用 defineRaw 逐 dialect 原样 SQL。
 *
 * 表结构 / 隔离归属：tenant_bootstrap 含 tenant_id 且**按 tenant_id 归属**（register 单事务内写、
 * 按 tenant_id 查恢复），可随 TenantDatabase 自动隔离——故只登记 privacy TENANT_TABLES（随租户导出/擦除），
 * **不进** KNOWN_UNISOLATED（与 tenant_identity_directory 的全局查找语义不同，后者查它才知 tenant 故豁免）。
 *
 * Alias：SQLite v124 / Postgres v126（紧跟 Task 1 tenant_identity_directory / SQLite v123 / Postgres v125）。
 */
export const v124_tenant_bootstrap_backfill: RawMigration = defineRaw({
  id: 'tenant-bootstrap-backfill',
  version: 'v124',
  aliases: { postgres: 'v126', 'sqlite-sql': 'v124' },
  description: 'Tenant sharding Phase 0 Plan 1c: tenant_bootstrap marker (PK tenant+op) + historical identity backfill into tenant_identity_directory (email normalized; duplicate-email fail-closed)',
  reason: '向后兼容硬前置：建 tenant_bootstrap 完成标记表 + 把老 users/api_keys/refresh_tokens 回填成 ACTIVE 目录项（email 经 LOWER(TRIM) 归一化 + 同步归一化 users.email + 归一化后重复 email fail-closed 抛错停止）；数据迁移无法用 schema DSL 表达，逐 dialect 原样 SQL',
  postgres: rawSql([
    /* 产物 1：tenant_bootstrap 完成标记表（PK (tenant_id, operation_id) per-operation 粒度）。 */
    `CREATE TABLE IF NOT EXISTS tenant_bootstrap (
      tenant_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('COMPLETE')),
      created_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, operation_id)
    )`,
    /* 产物 3 前置：归一化后重复 email fail-closed（改任何数据前先抛，给可审计信号）。 */
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM users GROUP BY lower(trim(email)) HAVING count(*) > 1
       ) THEN
         RAISE EXCEPTION 'v124 tenant-bootstrap-backfill aborted: duplicate normalized email in users (LOWER(TRIM(email))); manual cleanup required before re-running (_v124_duplicate_email_abort)';
       END IF;
     END $$`,
    /* 产物 3：同步归一化 users.email（与 login 派生的 canonical email 对齐）。 */
    `UPDATE users SET email = lower(trim(email))`,
    /* 产物 2：email 项回填（归一化 lookup_value；operation_kind=REGISTER；user_id=users.id）。 */
    `INSERT INTO tenant_identity_directory (tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at)
     SELECT tenant_id, id, 'backfill', 'REGISTER', NULL, NULL, 'email', lower(trim(email)), 'ACTIVE', created_at, updated_at
     FROM users
     ON CONFLICT (lookup_kind, lookup_value) DO NOTHING`,
    /* 产物 2：refresh_token 项回填（JOIN users 取 tenant_id；operation_kind=TOKEN；user_id=refresh_tokens.user_id）。 */
    `INSERT INTO tenant_identity_directory (tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at)
     SELECT u.tenant_id, rt.user_id, 'backfill', 'TOKEN', NULL, NULL, 'refresh_token_hash', rt.token_hash, 'ACTIVE', rt.created_at, rt.created_at
     FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
     ON CONFLICT (lookup_kind, lookup_value) DO NOTHING`,
    /* 产物 2：api_key 项回填（operation_kind=API_KEY；user_id=NULL）。 */
    `INSERT INTO tenant_identity_directory (tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at)
     SELECT tenant_id, NULL, 'backfill', 'API_KEY', NULL, NULL, 'api_key_hash', key_hash, 'ACTIVE', created_at, created_at
     FROM api_keys
     ON CONFLICT (lookup_kind, lookup_value) DO NOTHING`,
  ]),
  sqlite: rawSql([
    /* 产物 1：tenant_bootstrap 完成标记表（PK (tenant_id, operation_id) per-operation 粒度）。 */
    `CREATE TABLE IF NOT EXISTS tenant_bootstrap (
      tenant_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('COMPLETE')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, operation_id)
    )`,
    /* 产物 3 前置：归一化后重复 email fail-closed。临时表 norm_email 列带 UNIQUE，
     * INSERT SELECT 有重复即抛 UNIQUE constraint failed（表名 _v124_duplicate_email_abort 可审计）；
     * 无重复则临时表建好即删、零副作用。DROP IF EXISTS 兜住前次失败残留（TEMP 表跨语句可见）。 */
    `DROP TABLE IF EXISTS _v124_duplicate_email_abort`,
    `CREATE TEMP TABLE _v124_duplicate_email_abort (must_be_unique_normalized_email TEXT NOT NULL UNIQUE)`,
    `INSERT INTO _v124_duplicate_email_abort (must_be_unique_normalized_email) SELECT LOWER(TRIM(email)) FROM users`,
    `DROP TABLE _v124_duplicate_email_abort`,
    /* 产物 3：同步归一化 users.email（与 login 派生的 canonical email 对齐）。 */
    `UPDATE users SET email = LOWER(TRIM(email))`,
    /* 产物 2：email 项回填（归一化 lookup_value；operation_kind=REGISTER；user_id=users.id）。 */
    `INSERT OR IGNORE INTO tenant_identity_directory (tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at)
     SELECT tenant_id, id, 'backfill', 'REGISTER', NULL, NULL, 'email', LOWER(TRIM(email)), 'ACTIVE', created_at, updated_at
     FROM users`,
    /* 产物 2：refresh_token 项回填（JOIN users 取 tenant_id；operation_kind=TOKEN；user_id=refresh_tokens.user_id）。
     * safe:if-table-exists 守卫某些 v047-onwards 部分 bootstrap 路径下 refresh_tokens 尚未建出的情形（同 v072/v073）。 */
    `/* safe:if-table-exists:refresh_tokens */ INSERT OR IGNORE INTO tenant_identity_directory (tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at)
     SELECT u.tenant_id, rt.user_id, 'backfill', 'TOKEN', NULL, NULL, 'refresh_token_hash', rt.token_hash, 'ACTIVE', rt.created_at, rt.created_at
     FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id`,
    /* 产物 2：api_key 项回填（operation_kind=API_KEY；user_id=NULL）。 */
    `/* safe:if-table-exists:api_keys */ INSERT OR IGNORE INTO tenant_identity_directory (tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at)
     SELECT tenant_id, NULL, 'backfill', 'API_KEY', NULL, NULL, 'api_key_hash', key_hash, 'ACTIVE', created_at, created_at
     FROM api_keys`,
  ]),
});
