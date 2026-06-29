import { defineMigration, type Migration } from '../../index.js';

/**
 * 双边工单市场 M1（ADR-0058）——让组织能与单个数字人格同台竞标接单，发布者确认委派。
 *
 * 设计（平行表，向后兼容铁律）：persona 的 task_applications/task_assignments **零改动**（它们 persona_id
 * NOT NULL + FK persona_core + ranking 深耦合 persona，改 nullable 要重建表，破坏性大）。org 接单走**平行新表**
 * task_org_applications / task_org_assignments，列设计就为 org（org_id NOT NULL，无 persona FK）。
 * marketplace_tasks 是**共享工单本体**，加列标记「最终委派给了谁」+ 验资钩子。
 *
 * 市场范围=**租户内**（发布者与接单组织同租户，复用 TenantDatabase 隔离）。
 * 全部含 tenant_id → 自动隔离；GDPR A 类（业务派生，无敏感凭证）。
 * Alias：SQLite v112 / Postgres v114（紧跟 v111 org_wallet / pg v113）。
 */
export const v112_bidirectional_task_market: Migration = defineMigration({
  kind: 'schema',
  id: '112-bidirectional-task-market',
  aliases: { postgres: 'v114', 'sqlite-sql': 'v112' },
  description: 'Bidirectional task market (ADR-0058): org can bid on marketplace tasks alongside personas; publisher confirms assignment',
  operations: [
    /* marketplace_tasks 加列：标记工单最终委派对象类型（persona 默认/org）+ org 接单方 + 发布者验资钩子。 */
    { kind: 'add-column', table: 'marketplace_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'assignee_kind', type: 'text', nullable: false, default: 'persona' } },
    { kind: 'add-column', table: 'marketplace_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'assignee_org_id', type: 'text', nullable: true } },
    /* 验资钩子（D5）：发布者是否已验资。默认 0=未验资。本轮不实现 KYC，只留字段 + UI 标记。 */
    { kind: 'add-column', table: 'marketplace_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'publisher_verified', type: 'integer', nullable: false, default: 0 } },

    /* org 申请表（平行于 task_applications）：组织对一个 open 工单登记接单意向。 */
    {
      kind: 'create-table',
      table: {
        name: 'task_org_applications',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'task_id', type: 'text', nullable: false },
          { name: 'org_id', type: 'text', nullable: false },
          /* 排序辅助分（D6 确定性默认，不引入 org 评分体系）；发布者自行判断委派给谁。 */
          { name: 'ranking_score', type: 'real', nullable: false, default: 0 },
          { name: 'status', type: 'text', nullable: false, default: 'submitted' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* 唯一：一个组织对一个工单只申请一次。 */
    { kind: 'create-index', index: { name: 'uq_task_org_applications', table: 'task_org_applications', columns: ['tenant_id', 'task_id', 'org_id'], unique: true, ifNotExists: true } },
    /* 按工单列申请者（发布者看「谁申请了」）。 */
    { kind: 'create-index', index: { name: 'idx_task_org_applications_task', table: 'task_org_applications', columns: ['tenant_id', 'task_id'], ifNotExists: true } },
    /* 按组织列其申请（org 视角「我申请了哪些」）。 */
    { kind: 'create-index', index: { name: 'idx_task_org_applications_org', table: 'task_org_applications', columns: ['tenant_id', 'org_id', 'status'], ifNotExists: true } },

    /* org 指派表（平行于 task_assignments）：发布者确认把工单委派给某组织后建。 */
    {
      kind: 'create-table',
      table: {
        name: 'task_org_assignments',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'task_id', type: 'text', nullable: false },
          { name: 'org_id', type: 'text', nullable: false },
          /* 来源申请（经 apply→assign 流程则非空）。 */
          { name: 'application_id', type: 'text', nullable: true },
          /* 该工单接来后建的组织目标 id（org 用 runGoal 分解，溯源）。 */
          { name: 'org_goal_id', type: 'text', nullable: true },
          { name: 'status', type: 'text', nullable: false, default: 'assigned' },
          { name: 'assigned_at', type: 'bigint', nullable: false },
          { name: 'submitted_at', type: 'bigint', nullable: true },
          { name: 'completed_at', type: 'bigint', nullable: true },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* 按工单查最新 org 指派（一工单同一时刻最多一个活跃 org 指派——service 守）。 */
    { kind: 'create-index', index: { name: 'idx_task_org_assignments_task', table: 'task_org_assignments', columns: ['tenant_id', 'task_id', 'created_at'], ifNotExists: true } },
    /* 按组织列其指派（org 视角「委派给我的工单」）。 */
    { kind: 'create-index', index: { name: 'idx_task_org_assignments_org', table: 'task_org_assignments', columns: ['tenant_id', 'org_id', 'status'], ifNotExists: true } },
  ],
});
