import { defineMigration, type Migration } from '../../index.js';

/**
 * P0-D #2 — JWT 签名密钥环持久化 (jwt_signing_keys)。
 *
 * KeyRing 的 4 状态机已存在（active/grace/retired/compromised），但实例
 * 仍然在启动时从 env 加载静态密钥，rotate() 只在内存生效。多 Pod /
 * 多节点部署需要：
 *   - 一次 rotate 在所有实例可见 → 通过 DB 持久化 + 定期 reload；
 *   - 重启不丢历史 grace key → DB 持久化即可；
 *   - kid 唯一 → UNIQUE 索引。
 *
 * 字段决策：
 *   - private_key / public_key 列存 PEM 文本；对称密钥用 secret 列。
 *     生产环境必须配合应用层字段加密（src/storage/encryption.ts），本
 *     迁移仅创建 schema，加密由消费方负责；
 *   - state 用文本枚举（CHECK 约束），SQLite/PG 同形；
 *   - state_changed_at + created_at + retired_at 提供审计轨迹。
 *
 * Alias：SQLite v078 / Postgres v080（紧跟 v077 audit anchors）。
 */
export const v078_jwt_signing_keys: Migration = defineMigration({
  kind: 'schema',
  id: '078-jwt-signing-keys',
  aliases: { postgres: 'v080', 'sqlite-sql': 'v078' },
  description: 'P0-D #2: durable jwt_signing_keys with KeyRing state machine',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'jwt_signing_keys',
        ifNotExists: true,
        columns: [
          { name: 'kid', type: 'text', primaryKey: true },
          { name: 'state', type: 'text', nullable: false, check: "state IN ('active','grace','retired','compromised')" },
          { name: 'algorithm', type: 'text', nullable: false },
          { name: 'private_key', type: 'text', nullable: false, default: '' },
          { name: 'public_key', type: 'text', nullable: false, default: '' },
          { name: 'secret', type: 'text', nullable: false, default: '' },
          { name: 'created_at', type: 'text', nullable: false },
          { name: 'state_changed_at', type: 'text', nullable: false },
          { name: 'retired_at', type: 'text' },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_jwt_signing_keys_state',
        table: 'jwt_signing_keys',
        columns: ['state'],
        ifNotExists: true,
      },
    },
  ],
});
