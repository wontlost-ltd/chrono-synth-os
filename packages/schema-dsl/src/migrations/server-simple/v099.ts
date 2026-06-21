import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 B1：agent-to-agent 协作——结构化消息（不是自由聊天）。
 *
 * 数字员工之间的协作必须是**结构化、可治理、可审计**的，不是自由闲聊（否则绕开任务 DAG/状态机/审计链，
 * 最后无法治理）。每条消息绑定 org/线程，可选绑 task；有明确类型（request/response/report/note）+
 * 来源/去向 worker。线程绑 org，可选绑 goal/task。
 *
 *   - org_conversation_threads：协作线程，thread_type（delegation/report/handoff/coordination），
 *     可选 goal_id/task_id 关联。
 *   - org_messages：线程内消息，from/to worker，message_type，content，可选 correlation_id 关联任务/审批。
 *
 * 全部含 tenant_id → TenantDatabase 自动隔离；GDPR A 类。零-LLM（消息是结构化记录，渲染由确定性
 * responder 做）。Alias：SQLite v099 / Postgres v101（紧跟 v098 / Postgres v100）。
 */
export const v099_workforce_collaboration: Migration = defineMigration({
  kind: 'schema',
  id: '099-workforce-collaboration',
  aliases: { postgres: 'v101', 'sqlite-sql': 'v099' },
  description: 'Digital workforce B1: structured agent-to-agent collaboration (threads + messages)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'org_conversation_threads',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* delegation/report/handoff/coordination */
          { name: 'thread_type', type: 'text', nullable: false },
          /* 可选关联：目标/任务（null=泛协作）。 */
          { name: 'goal_id', type: 'text' },
          { name: 'task_id', type: 'text' },
          { name: 'created_by_worker_id', type: 'text', nullable: false },
          /* open/closed */
          { name: 'status', type: 'text', nullable: false, default: 'open' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-table',
      table: {
        name: 'org_messages',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          { name: 'thread_id', type: 'text', nullable: false },
          { name: 'from_worker_id', type: 'text', nullable: false },
          /* 去向 worker；null = 线程广播（给线程内所有成员）。 */
          { name: 'to_worker_id', type: 'text' },
          /* 结构化类型：request/response/report/note/escalation。 */
          { name: 'message_type', type: 'text', nullable: false },
          { name: 'content', type: 'text', nullable: false },
          /* 可选关联键（任务/审批/委派 id），保审计链不断。 */
          { name: 'correlation_id', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    { kind: 'create-index', index: { name: 'idx_threads_org', table: 'org_conversation_threads', columns: ['tenant_id', 'org_id'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_messages_thread', table: 'org_messages', columns: ['tenant_id', 'thread_id'], ifNotExists: true } },
  ],
});
