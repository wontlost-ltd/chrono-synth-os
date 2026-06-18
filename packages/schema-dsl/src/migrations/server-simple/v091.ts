import { defineMigration, type Migration } from '../../index.js';

/**
 * 主动消息 outbound 表（ADR-0054 Phase 2：主动性管道）。
 *
 * 数字人据内部信号「主动开口」产生的消息落此队列，客户端拉取未读 nudge。Phase 2 只建管道
 * （表 + 拉取 + 已读态），触发逻辑（ProactiveEngine/Gate）留待 Phase 3。
 *
 * 字段决策：
 *   - id（主键）/ tenant_id / persona_id：归属。tenant_id 含且无敏感列 → TenantDatabase 自动隔离 +
 *     privacy A 类标准导出/擦除。
 *   - signal_type / source_id / signal_version：触发信号溯源 + **幂等键组成**（ADR-0054 红线 8）。
 *     EventBus 重试/重放/双订阅/重启可能重复投递同一信号——(tenant_id, persona_id, signal_type,
 *     source_id, signal_version) 唯一索引保证同一信号最多落一条主动消息（insert 冲突即忽略）。
 *   - body：确定性 composer 产出的主动文本（Phase 4 由 OfflineConversationResponder 生成；Phase 2
 *     由调用方直接给）。kind：消息类别（如 growth/memory/milestone），供客户端分组渲染。
 *   - status：'unread' | 'read' | 'dismissed'（已读态，客户端标记）。created_at / read_at（epoch ms）。
 *
 * 无 row → 无主动消息（C 端 nudge 列表为空，向后兼容；该表全新）。
 *
 * Alias：SQLite v091 / Postgres v093（紧跟 v090 persona_governance_policy / Postgres v092）。
 */
export const v091_proactive_messages: Migration = defineMigration({
  kind: 'schema',
  id: '091-proactive-messages',
  aliases: { postgres: 'v093', 'sqlite-sql': 'v091' },
  description: 'ADR-0054 Phase 2: proactive outbound message queue (self-initiated nudges)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'proactive_messages',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', nullable: false },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          /* 触发信号溯源 + 幂等键组成（红线 8）。 */
          { name: 'signal_type', type: 'text', nullable: false },
          { name: 'source_id', type: 'text', nullable: false },
          { name: 'signal_version', type: 'bigint', nullable: false, default: '0' },
          /* 确定性 composer 产出的主动文本 + 消息类别。 */
          { name: 'body', type: 'text', nullable: false },
          { name: 'kind', type: 'text', nullable: false, default: 'general' },
          /* 'unread' | 'read' | 'dismissed'。 */
          { name: 'status', type: 'text', nullable: false, default: 'unread' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'read_at', type: 'bigint' },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['id'] },
        ],
      },
    },
    /* 幂等键唯一索引（ADR-0054 红线 8）：同一信号最多一条主动消息。 */
    {
      kind: 'create-index',
      index: {
        name: 'uq_proactive_messages_signal',
        table: 'proactive_messages',
        columns: ['tenant_id', 'persona_id', 'signal_type', 'source_id', 'signal_version'],
        unique: true,
        ifNotExists: true,
      },
    },
    /* 拉取未读：按 (tenant_id, persona_id, status) 过滤。 */
    {
      kind: 'create-index',
      index: {
        name: 'idx_proactive_messages_unread',
        table: 'proactive_messages',
        columns: ['tenant_id', 'persona_id', 'status'],
        unique: false,
        ifNotExists: true,
      },
    },
  ],
});
