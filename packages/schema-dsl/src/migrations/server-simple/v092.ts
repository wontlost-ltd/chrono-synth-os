import { defineMigration, type Migration } from '../../index.js';

/**
 * 通知偏好表（ADR-0054 红线 9：主动消息系统推送的同意层）。
 *
 * 移动/桌面 OS 系统通知比会话内 in-app nudge（SSE，默认开）侵入性强——必须**默认关闭**、用户显式开启，
 * 且尊重安静时段。本表 per (tenant_id, user_id) 一行：
 *   - nudge_push_enabled：主动消息系统推送总开关。**默认 0（关）**——红线 9：默认关，显式同意才开。
 *   - quiet_start_minute / quiet_end_minute：安静时段（当地时间当日分钟数 0..1439，可跨午夜；null=无）。
 *
 * 无 row → 调用方回退 DEFAULT_NOTIFICATION_PREFERENCE（推送默认关）。含 tenant_id 且无敏感列 →
 * TenantDatabase 自动隔离 + privacy A 类标准导出/擦除。
 *
 * Alias：SQLite v092 / Postgres v094（紧跟 v091 proactive_messages / Postgres v093）。
 */
export const v092_notification_preferences: Migration = defineMigration({
  kind: 'schema',
  id: '092-notification-preferences',
  aliases: { postgres: 'v094', 'sqlite-sql': 'v092' },
  description: 'ADR-0054 red-line 9: per-user notification preferences (push opt-in + quiet hours)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'notification_preferences',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'user_id', type: 'text', nullable: false },
          /* 主动消息系统推送总开关；默认 0（关）——红线 9 默认关。 */
          { name: 'nudge_push_enabled', type: 'boolean', nullable: false, default: false },
          /* 安静时段（当地时间当日分钟数 0..1439，可 start>end 表示跨午夜）；null=无安静时段。 */
          { name: 'quiet_start_minute', type: 'integer' },
          { name: 'quiet_end_minute', type: 'integer' },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'user_id'] },
        ],
      },
    },
  ],
});
