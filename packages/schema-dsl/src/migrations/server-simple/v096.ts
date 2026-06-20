import { defineMigration, type Migration } from '../../index.js';

/**
 * 我-你关系记忆表（ADR-0056 类人化：关系层）。
 *
 * 数字人不只记得「聊过的事」，还要记得「你是谁、我们什么关系」——伴侣感很大程度来自「它把我当一个
 * 持续的、特定的人」。companion 单租户单用户，故 per (tenant, persona) 一行记录那个用户：
 *   - user_name：用户的名字（「我叫小明」「叫我老王」「call me X」）。null=还不知道。
 *   - interaction_count：聊过多少次（每轮 chat++）。
 *   - first_met_at / last_seen_at：第一次/最近互动时间（配合时间感知「你回来了」「我们认识多久了」）。
 *
 * 确定性：识别用户自报名字是确定性正则，计数/时间是确定性递增——零-LLM。含 tenant_id → 自动隔离；A 类。
 * Alias：SQLite v096 / Postgres v098（紧跟 v095 companion_mood / Postgres v097）。
 */
export const v096_companion_relationship: Migration = defineMigration({
  kind: 'schema',
  id: '096-companion-relationship',
  aliases: { postgres: 'v098', 'sqlite-sql': 'v096' },
  description: 'ADR-0056 humanization: I-you relationship memory (user name + interaction count + timestamps)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'companion_relationship',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false, default: 'default' },
          /* 用户的名字；null=还不知道。 */
          { name: 'user_name', type: 'text' },
          /* 互动次数（每轮 chat++）。 */
          { name: 'interaction_count', type: 'integer', nullable: false, default: 0 },
          /* 第一次互动时间（epoch ms）；null=尚无。 */
          { name: 'first_met_at', type: 'bigint' },
          /* 最近互动时间（epoch ms）；null=尚无。 */
          { name: 'last_seen_at', type: 'bigint' },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'persona_id'] },
        ],
      },
    },
  ],
});
