import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0047 + ADR-0048 — 数字人级并发锁 (persona_leases)。
 *
 * 两个 ADR 都把「多实例部署前必须有 per-persona 锁」列为硬约束（gating item）：
 *   - ADR-0048：earning cycle 前获取 purpose='earning' 锁，防两个并发 cycle 各自
 *     读到 stale 的 24h reward exposure 而双双超 daily cap；
 *   - ADR-0047：DistillationService compile 前获取 purpose='compile' 锁，防全局
 *     restoreFromSnapshot 回滚被并发写者互相覆盖快照。
 *
 * 字段决策：
 *   - 主键 (tenant_id, persona_id, purpose)：保证同一数字人同一用途同时只有一个
 *     持有者——这正是 ADR-0048 要求的「unique running cycle per persona」；
 *   - holder_token：持有者随机令牌，release/refresh 必须匹配，杜绝 A 释放 B 的锁；
 *   - acquired_at / expires_at 为 epoch ms（ADR-0029，与 distilled_artifacts 一致）；
 *     expires_at 提供 TTL，持有者崩溃后锁可被抢占（acquire 的 ON CONFLICT WHERE
 *     expires_at <= now 原子判定），避免死锁；
 *   - 按 expires_at 建索引，支持后台清理/巡检过期锁。
 *
 * 锁的 acquire 用 `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now`
 * 原子 CAS（复用 quota_consume 的双库写法）；release/refresh 用 holder_token 匹配的
 * 乐观并发（复用 distilled_artifacts 的按期望值更新写法）。
 *
 * Alias：SQLite v081 / Postgres v083（紧跟 v080 distilled_artifacts）。
 */
export const v081_persona_leases: Migration = defineMigration({
  kind: 'schema',
  id: '081-persona-leases',
  aliases: { postgres: 'v083', 'sqlite-sql': 'v081' },
  description: 'ADR-0047/0048: per-persona concurrency lease (earning cycle + compile mutex)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'persona_leases',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          {
            name: 'purpose', type: 'text', nullable: false,
            check: "purpose IN ('earning', 'compile')",
          },
          { name: 'holder_token', type: 'text', nullable: false },
          { name: 'acquired_at', type: 'bigint', nullable: false },
          { name: 'expires_at', type: 'bigint', nullable: false },
        ],
        /* 复合主键 (tenant_id, persona_id, purpose)：保证同一数字人同一用途
         * 同时只有一条租约——ADR-0048「unique running cycle per persona」。 */
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'persona_id', 'purpose'] },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_persona_leases_expires',
        table: 'persona_leases',
        columns: ['expires_at'],
        ifNotExists: true,
      },
    },
  ],
});
