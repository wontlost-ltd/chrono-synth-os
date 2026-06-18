import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字人第一人称身份表（ADR-0055「自我意识」第一块基石）。
 *
 * 数字人需要一个**第一人称身份层**——明确「关于我的事实」（我叫什么、我是谁），与「我学到的知识」
 * （memories）分开。这样问「你叫什么」能以第一人称答「我叫 X」，而不是把用户原话「你叫 X」当第二
 * 人称记忆原样复述（主语错位）。
 *
 * per (tenant_id, persona_id) 一行：
 *   - name：数字人的名字（用户在对话中定义，如「你叫 Max」→ 内化为「我叫 Max」）。可空（未起名）。
 *
 * 含 tenant_id 且无敏感列 → TenantDatabase 自动隔离 + privacy A 类标准导出/擦除。
 *
 * Alias：SQLite v093 / Postgres v095（紧跟 v092 notification_preferences / Postgres v094）。
 */
export const v093_companion_identity: Migration = defineMigration({
  kind: 'schema',
  id: '093-companion-identity',
  aliases: { postgres: 'v095', 'sqlite-sql': 'v093' },
  description: 'ADR-0055 self-awareness: per-persona first-person identity (name)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'companion_identity',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false, default: 'default' },
          /* 数字人的名字（第一人称身份事实）；null=尚未起名。 */
          { name: 'name', type: 'text' },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'persona_id'] },
        ],
      },
    },
  ],
});
