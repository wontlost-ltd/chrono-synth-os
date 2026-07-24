import { defineMigration, type Migration } from '../../index.js';

/**
 * 租户分片 Phase 0 · Plan 1c Task 1 —— coordinator 身份目录表 tenant_identity_directory。
 *
 * 这是后续 Auth mixed-scope 状态机的地基：一张 coordinator（协调器）上的全局目录表，
 * 把「登录/注册用的身份查找键」（email、refresh token 哈希、api key 哈希）映射到租户，
 * 从而在多分片部署下先由 coordinator 定位租户、再路由到对应 shard。
 *
 * 字段决策：
 *   - tenant_id：目标租户；shardId 由 tenantId 纯函数派生，**故本表无 shard_id 列**。
 *   - user_id：canonical userId，供 register 重试复用同一身份而不重生（可空——token/key 项无关）。
 *   - operation_id / operation_kind：恢复 worker 据 operation_kind 选分支
 *     （REGISTER / EMAIL_CHANGE / TOKEN / API_KEY）。
 *   - previous_lookup_value：EMAIL_CHANGE 的 oldEmail，其他操作为 NULL。
 *   - pending_password_hash：register PENDING 的首次 argon2 hash，续做时用 argon2.verify 校验密码、
 *     shard user 复用；SSO / token / key 项为 NULL。
 *   - lookup_kind / lookup_value：身份查找键的类型与值。
 *   - status：PENDING（登记中，尚未确认落 shard）→ ACTIVE（已激活）。
 *
 * 约束：
 *   - UNIQUE(lookup_kind, lookup_value)：查找键**全局唯一**，挡并发 register（同 email 只能一次成功）。
 *   - idx_tid_tenant(tenant_id)：按租户列出目录项。
 *
 * Alias：SQLite v123 / Postgres v125（紧跟 v122 GitHub 发布段 sqlite v122 / pg v124）。
 */
export const v123_tenant_identity_directory: Migration = defineMigration({
  kind: 'schema',
  id: '123-tenant-identity-directory',
  aliases: { postgres: 'v125', 'sqlite-sql': 'v123' },
  description: 'Tenant sharding Phase 0 Plan 1c: coordinator tenant_identity_directory (email/token/key lookup → tenant; PENDING/ACTIVE mixed-scope state)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'tenant_identity_directory',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false },
          /* canonical userId：register 重试复用身份不重生；token/key 项可 NULL。 */
          { name: 'user_id', type: 'text' },
          { name: 'operation_id', type: 'text', nullable: false },
          /* 恢复 worker 据此选分支。 */
          { name: 'operation_kind', type: 'text', nullable: false, check: "operation_kind IN ('REGISTER', 'EMAIL_CHANGE', 'TOKEN', 'API_KEY')" },
          /* EMAIL_CHANGE 的 oldEmail，其他 NULL。 */
          { name: 'previous_lookup_value', type: 'text' },
          /* register PENDING 的首次 argon2 hash（续做校验密码 + shard user 复用）；SSO/token/key 项 NULL。 */
          { name: 'pending_password_hash', type: 'text' },
          { name: 'lookup_kind', type: 'text', nullable: false, check: "lookup_kind IN ('email', 'refresh_token_hash', 'api_key_hash')" },
          { name: 'lookup_value', type: 'text', nullable: false },
          { name: 'status', type: 'text', nullable: false, check: "status IN ('PENDING', 'ACTIVE')" },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        constraints: [
          /* 查找键全局唯一：挡并发 register（同一 email/token/key 只能有一条目录项）。 */
          { kind: 'unique', columns: ['lookup_kind', 'lookup_value'] },
        ],
      },
    },
    /* 按租户列出目录项。 */
    { kind: 'create-index', index: { name: 'idx_tid_tenant', table: 'tenant_identity_directory', columns: ['tenant_id'], ifNotExists: true } },
  ],
});
