import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字人当前心情状态表（ADR-0056 类人化：情绪/心情）。
 *
 * 数字人不只有逐条记忆的情感价（valence），还要有一个**会随对话/经历漂移的当前心情**——聊到开心
 * 事心情上扬、难过事下沉，回应语气随之变。这是「类人感」的地基。心情更新是**确定性漂移**（事件
 * 信号 + 时间回归），表达调制是**确定性模板选择**，运行时零-LLM（不是「真的感受」，是一个会变的
 * 内部数值决定语气）。可复现：相同输入 + 相同心情状态 + 相同时刻 → 相同输出。
 *
 * per (tenant_id, persona_id) 一行（二维 PAD 简化）：
 *   - valence：效价 [-1,1]，愉快↔不快。
 *   - arousal：唤醒 [0,1]，平静↔激动。
 *   - updated_at：上次更新（算时间回归衰减用）。
 *
 * 含 tenant_id 且无敏感列 → TenantDatabase 自动隔离 + privacy A 类标准导出/擦除。
 * Alias：SQLite v095 / Postgres v097（紧跟 v094 memory_translations / Postgres v096）。
 */
export const v095_companion_mood: Migration = defineMigration({
  kind: 'schema',
  id: '095-companion-mood',
  aliases: { postgres: 'v097', 'sqlite-sql': 'v095' },
  description: 'ADR-0056 humanization: per-persona current mood (valence/arousal)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'companion_mood',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false, default: 'default' },
          /* 效价 [-1,1]（愉快↔不快）。 */
          { name: 'valence', type: 'real', nullable: false, default: 0 },
          /* 唤醒 [0,1]（平静↔激动）。 */
          { name: 'arousal', type: 'real', nullable: false, default: 0.3 },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'persona_id'] },
        ],
      },
    },
  ],
});
