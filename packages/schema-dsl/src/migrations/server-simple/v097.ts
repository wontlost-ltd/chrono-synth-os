import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 M1 奠基（digital workforce）——把一组数字人格组织成一个可治理的工作单元。
 *
 * 愿景「全数字员工企业」的地基切片：组织能**确定性地**把目标拆解→委派给下属数字员工→执行→逐级汇报→
 * 聚合，全零-LLM（分解/委派/聚合都是确定性 rule pack，相同输入相同 DAG，可复现）。落 enterprise 侧，
 * 不碰 companion，不撕裂 ADR-0046。
 *
 * 6 张表（最小因果链，approvals/协作 thread 留后续切片）：
 *   - org_positions：岗位（CEO/Manager/IC 等），title/job_family/seniority/role_code。
 *   - digital_workers：数字员工，绑定 persona_id（人格内核）+ position_id（岗位）。
 *   - reporting_edges：汇报关系（manager_worker_id → report_worker_id），组织图核心；manager 为 null=根。
 *   - org_goals：目标（由某 worker 拥有，如数字主管）。
 *   - org_tasks：任务树（goal→manager 子任务→IC 任务），assigned_to/accountable，status，result_summary。
 *   - task_reports：汇报（下属→上级，progress/final/blocker），逐级聚合的证据链。
 *
 * 全部含 tenant_id → TenantDatabase 自动隔离；GDPR A 类（业务/派生，无敏感凭证）。
 * Alias：SQLite v097 / Postgres v099（紧跟 v096 companion_relationship / Postgres v098）。
 */
export const v097_digital_workforce: Migration = defineMigration({
  kind: 'schema',
  id: '097-digital-workforce',
  aliases: { postgres: 'v099', 'sqlite-sql': 'v097' },
  description: 'Digital workforce M1: org chart + deterministic goal decomposition + delegation/report (zero-LLM)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'org_positions',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          { name: 'title', type: 'text', nullable: false },
          /* 职能族：executive/manager/ic/support/legal/sales/finance/hr… */
          { name: 'job_family', type: 'text', nullable: false },
          /* 资历层级：exec/lead/senior/ic */
          { name: 'seniority', type: 'text', nullable: false },
          /* 角色编码（稳定标识，如 ceo / managing_editor / writer_ic） */
          { name: 'role_code', type: 'text', nullable: false },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-table',
      table: {
        name: 'digital_workers',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* 绑定的人格内核 id（persona_core.id）。 */
          { name: 'persona_id', type: 'text', nullable: false },
          { name: 'position_id', type: 'text', nullable: false },
          { name: 'display_name', type: 'text', nullable: false },
          /* active/suspended/offboarded */
          { name: 'employment_status', type: 'text', nullable: false, default: 'active' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-table',
      table: {
        name: 'reporting_edges',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* 上级 worker id；null = 根（无上级，如 CEO）。 */
          { name: 'manager_worker_id', type: 'text' },
          { name: 'report_worker_id', type: 'text', nullable: false },
          /* solid/dotted/escalation */
          { name: 'edge_type', type: 'text', nullable: false, default: 'solid' },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-table',
      table: {
        name: 'org_goals',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          { name: 'owner_worker_id', type: 'text', nullable: false },
          { name: 'title', type: 'text', nullable: false },
          { name: 'description', type: 'text', nullable: false, default: '' },
          /* 受限 goal type（决定用哪个确定性分解 playbook）。 */
          { name: 'goal_type', type: 'text', nullable: false },
          /* proposed/active/completed/cancelled */
          { name: 'status', type: 'text', nullable: false, default: 'proposed' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-table',
      table: {
        name: 'org_tasks',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          { name: 'goal_id', type: 'text', nullable: false },
          /* 父任务 id；null = 顶层（manager 级）任务。 */
          { name: 'parent_task_id', type: 'text' },
          /* 执行者 worker id；null = 尚未委派。 */
          { name: 'assigned_to_worker_id', type: 'text' },
          /* 问责 worker id（上级/委派者）。 */
          { name: 'accountable_worker_id', type: 'text', nullable: false },
          { name: 'title', type: 'text', nullable: false },
          /* research/writing/review/report/coordination… */
          { name: 'task_type', type: 'text', nullable: false },
          /* draft/delegated/in_progress/submitted/approved/rejected/blocked */
          { name: 'status', type: 'text', nullable: false, default: 'draft' },
          /* 执行产出摘要（确定性 stub 产出；null=未完成）。 */
          { name: 'result_summary', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-table',
      table: {
        name: 'task_reports',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          { name: 'task_id', type: 'text', nullable: false },
          { name: 'from_worker_id', type: 'text', nullable: false },
          { name: 'to_worker_id', type: 'text', nullable: false },
          /* progress/final/blocker/escalation */
          { name: 'report_type', type: 'text', nullable: false },
          { name: 'summary', type: 'text', nullable: false },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* 组织不变量的 DB 层兜底（Codex 复审：service 校验之外加唯一约束，挡导入/手写/未来迁移写脏）：
     *   - 同组织内 role_code 唯一（一个岗位编码只对应一个岗位）。
     *   - 同组织内每个 worker 只能有一条汇报边（report_worker_id 唯一）——挡「一个员工多个上级」结构脏。 */
    { kind: 'create-index', index: { name: 'uq_positions_role', table: 'org_positions', columns: ['tenant_id', 'org_id', 'role_code'], unique: true, ifNotExists: true } },
    { kind: 'create-index', index: { name: 'uq_edges_report_worker', table: 'reporting_edges', columns: ['tenant_id', 'org_id', 'report_worker_id'], unique: true, ifNotExists: true } },
    /* 查询索引：组织图遍历 + 任务按 goal/委派对象检索（确定性遍历的热路径）。 */
    { kind: 'create-index', index: { name: 'idx_workers_org', table: 'digital_workers', columns: ['tenant_id', 'org_id'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_edges_manager', table: 'reporting_edges', columns: ['tenant_id', 'org_id', 'manager_worker_id'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_tasks_goal', table: 'org_tasks', columns: ['tenant_id', 'goal_id'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_reports_task', table: 'task_reports', columns: ['tenant_id', 'task_id'], ifNotExists: true } },
  ],
});
