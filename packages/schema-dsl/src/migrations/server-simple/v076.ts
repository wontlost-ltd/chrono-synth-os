import { defineMigration, type Migration } from '../../index.js';

/**
 * P1-M v2 — 多实例可信任的破窗令牌（break-glass）JTI 消费账本。
 *
 * 单实例的内存 Map 只能在一个进程内防止重放；多 Pod / 多节点部署
 * 下，攻击者可以在每个进程上各使用一次同一个紧急令牌。本表把
 * "已消费" 状态落到数据库，依赖 UNIQUE(tenant_id, jti) 索引作为
 * 分布式互斥：第一条 INSERT 胜出，其它实例的同一 jti 触发 ON
 * CONFLICT 并被判定为重放。
 *
 * 字段决策：
 *   - consumed_at 使用 ISO-8601 文本以保证 SQLite/Postgres 字典序
 *     与时间顺序一致，便于按时间窗口裁剪；
 *   - audit_seq 可空，用于将来把消费记录与 audit_log 行号绑定，
 *     当前版本暂存 NULL。
 *
 * Alias：SQLite v076 / Postgres v078（紧跟 v075_legal_holds）。
 */
export const v076_break_glass_jti_consumptions: Migration = defineMigration({
  kind: 'schema',
  id: '076-break-glass-jti-consumptions',
  aliases: { postgres: 'v078', 'sqlite-sql': 'v076' },
  description: 'P1-M v2: durable break-glass JTI consumption ledger',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'break_glass_jti_consumptions',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false },
          { name: 'jti', type: 'text', nullable: false },
          { name: 'token_scope', type: 'text', nullable: false },
          { name: 'consumed_at', type: 'text', nullable: false },
          { name: 'consumed_by', type: 'text' },
          { name: 'request_ip', type: 'text' },
          { name: 'audit_seq', type: 'bigint' },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_break_glass_jti_unique',
        table: 'break_glass_jti_consumptions',
        columns: ['tenant_id', 'jti'],
        unique: true,
        ifNotExists: true,
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_break_glass_jti_consumed_at',
        table: 'break_glass_jti_consumptions',
        columns: ['consumed_at'],
        ifNotExists: true,
      },
    },
  ],
});
