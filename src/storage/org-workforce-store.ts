/**
 * 数字员工组织 store（digital workforce M1）——positions/workers/edges/goals/tasks/reports 的 CRUD。
 *
 * 直接走 IDatabase.prepare（轻量）。所有表含 tenant_id → TenantDatabase 自动隔离；查询仍显式带
 * tenant_id + org_id（白盒可验证 + 不依赖隔离层兜底）。时间戳 bigint 用 coerceNumber 跨驱动强转
 * （SQLite number / Postgres node-pg string）。
 */

import type { IDatabase } from './database.js';
import type {
  OrgPosition, DigitalWorker, ReportingEdge, OrgGoal, OrgTask, TaskReport,
  Seniority, EmploymentStatus, ReportingEdgeType, GoalStatus, TaskStatus, ReportType,
} from '../workforce/types.js';

/** bigint 时间戳跨驱动强转：SQLite number / Postgres string → number；null/非有限 → 0（这些列非空）。 */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 可空时间戳/外键的强转：null/undefined 保留 null。 */
function nullableStr(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export class OrgWorkforceStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  /** 同步事务包裹：让一组写入原子化（要么全成功要么全回滚，避免半成品组织/因果链）。 */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  /* ── positions ── */

  insertPosition(p: Omit<OrgPosition, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_positions (id, tenant_id, org_id, title, job_family, seniority, role_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, this.tenantId, p.orgId, p.title, p.jobFamily, p.seniority, p.roleCode, p.createdAt);
  }

  listPositions(orgId: string): OrgPosition[] {
    const rows = this.db.prepare<RawPosition>(
      `SELECT id, org_id, title, job_family, seniority, role_code, created_at
       FROM org_positions WHERE tenant_id = ? AND org_id = ?`,
    ).all(this.tenantId, orgId);
    return rows.map((r) => this.toPosition(r));
  }

  /* ── workers ── */

  insertWorker(w: Omit<DigitalWorker, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO digital_workers (id, tenant_id, org_id, persona_id, position_id, display_name, employment_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.id, this.tenantId, w.orgId, w.personaId, w.positionId, w.displayName, w.employmentStatus, w.createdAt, w.updatedAt);
  }

  listWorkers(orgId: string): DigitalWorker[] {
    const rows = this.db.prepare<RawWorker>(
      `SELECT id, org_id, persona_id, position_id, display_name, employment_status, created_at, updated_at
       FROM digital_workers WHERE tenant_id = ? AND org_id = ?`,
    ).all(this.tenantId, orgId);
    return rows.map((r) => this.toWorker(r));
  }

  getWorker(orgId: string, workerId: string): DigitalWorker | undefined {
    const row = this.db.prepare<RawWorker>(
      `SELECT id, org_id, persona_id, position_id, display_name, employment_status, created_at, updated_at
       FROM digital_workers WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).get(this.tenantId, orgId, workerId);
    return row ? this.toWorker(row) : undefined;
  }

  /* ── reporting edges ── */

  insertEdge(e: Omit<ReportingEdge, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO reporting_edges (id, tenant_id, org_id, manager_worker_id, report_worker_id, edge_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, this.tenantId, e.orgId, e.managerWorkerId, e.reportWorkerId, e.edgeType, e.createdAt);
  }

  listEdges(orgId: string): ReportingEdge[] {
    const rows = this.db.prepare<RawEdge>(
      `SELECT id, org_id, manager_worker_id, report_worker_id, edge_type, created_at
       FROM reporting_edges WHERE tenant_id = ? AND org_id = ?`,
    ).all(this.tenantId, orgId);
    return rows.map((r) => this.toEdge(r));
  }

  /** 取某 manager 的直接下属 worker id 列表（确定性排序：id 升序）。 */
  listDirectReports(orgId: string, managerWorkerId: string): string[] {
    const rows = this.db.prepare<{ report_worker_id: string }>(
      `SELECT report_worker_id FROM reporting_edges
       WHERE tenant_id = ? AND org_id = ? AND manager_worker_id = ?
       ORDER BY report_worker_id ASC`,
    ).all(this.tenantId, orgId, managerWorkerId);
    return rows.map((r) => r.report_worker_id);
  }

  /* ── goals ── */

  insertGoal(g: Omit<OrgGoal, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_goals (id, tenant_id, org_id, owner_worker_id, title, description, goal_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, this.tenantId, g.orgId, g.ownerWorkerId, g.title, g.description, g.goalType, g.status, g.createdAt, g.updatedAt);
  }

  updateGoalStatus(orgId: string, goalId: string, status: GoalStatus, now: number): void {
    this.db.prepare<void>(
      `UPDATE org_goals SET status = ?, updated_at = ? WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).run(status, now, this.tenantId, orgId, goalId);
  }

  /* ── tasks ── */

  insertTask(t: Omit<OrgTask, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_tasks (id, tenant_id, org_id, goal_id, parent_task_id, assigned_to_worker_id, accountable_worker_id, title, task_type, status, result_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, this.tenantId, t.orgId, t.goalId, t.parentTaskId, t.assignedToWorkerId, t.accountableWorkerId, t.title, t.taskType, t.status, t.resultSummary, t.createdAt, t.updatedAt);
  }

  updateTaskExecution(orgId: string, taskId: string, status: TaskStatus, resultSummary: string | null, now: number): void {
    this.db.prepare<void>(
      `UPDATE org_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).run(status, resultSummary, now, this.tenantId, orgId, taskId);
  }

  /** 取某目标的任务（确定性排序：created_at 升序、id 升序兜底）。 */
  listTasksByGoal(orgId: string, goalId: string): OrgTask[] {
    const rows = this.db.prepare<RawTask>(
      `SELECT id, org_id, goal_id, parent_task_id, assigned_to_worker_id, accountable_worker_id, title, task_type, status, result_summary, created_at, updated_at
       FROM org_tasks WHERE tenant_id = ? AND org_id = ? AND goal_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, goalId);
    return rows.map((r) => this.toTask(r));
  }

  /* ── reports ── */

  insertReport(r: Omit<TaskReport, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO task_reports (id, tenant_id, org_id, task_id, from_worker_id, to_worker_id, report_type, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, this.tenantId, r.orgId, r.taskId, r.fromWorkerId, r.toWorkerId, r.reportType, r.summary, r.createdAt);
  }

  /** 取某目标下所有任务的汇报（按 created_at 升序、id 升序）。 */
  listReportsByGoal(orgId: string, goalId: string): TaskReport[] {
    const rows = this.db.prepare<RawReport>(
      `SELECT r.id, r.org_id, r.task_id, r.from_worker_id, r.to_worker_id, r.report_type, r.summary, r.created_at
       FROM task_reports r JOIN org_tasks t ON r.task_id = t.id AND r.tenant_id = t.tenant_id AND r.org_id = t.org_id
       WHERE r.tenant_id = ? AND r.org_id = ? AND t.goal_id = ?
       ORDER BY r.created_at ASC, r.id ASC`,
    ).all(this.tenantId, orgId, goalId);
    return rows.map((row) => this.toReport(row));
  }

  /* ── row → domain 映射 ── */

  private toPosition(r: RawPosition): OrgPosition {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, title: r.title,
      jobFamily: r.job_family, seniority: r.seniority as Seniority, roleCode: r.role_code, createdAt: num(r.created_at),
    };
  }

  private toWorker(r: RawWorker): DigitalWorker {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, personaId: r.persona_id,
      positionId: r.position_id, displayName: r.display_name,
      employmentStatus: r.employment_status as EmploymentStatus, createdAt: num(r.created_at), updatedAt: num(r.updated_at),
    };
  }

  private toEdge(r: RawEdge): ReportingEdge {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id,
      managerWorkerId: nullableStr(r.manager_worker_id), reportWorkerId: r.report_worker_id,
      edgeType: r.edge_type as ReportingEdgeType, createdAt: num(r.created_at),
    };
  }

  private toTask(r: RawTask): OrgTask {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, goalId: r.goal_id,
      parentTaskId: nullableStr(r.parent_task_id), assignedToWorkerId: nullableStr(r.assigned_to_worker_id),
      accountableWorkerId: r.accountable_worker_id, title: r.title, taskType: r.task_type,
      status: r.status as TaskStatus, resultSummary: nullableStr(r.result_summary),
      createdAt: num(r.created_at), updatedAt: num(r.updated_at),
    };
  }

  private toReport(r: RawReport): TaskReport {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, taskId: r.task_id,
      fromWorkerId: r.from_worker_id, toWorkerId: r.to_worker_id,
      reportType: r.report_type as ReportType, summary: r.summary, createdAt: num(r.created_at),
    };
  }
}

/* ── DB 行类型（snake_case，未强转） ── */
interface RawPosition { id: string; org_id: string; title: string; job_family: string; seniority: string; role_code: string; created_at: unknown; }
interface RawWorker { id: string; org_id: string; persona_id: string; position_id: string; display_name: string; employment_status: string; created_at: unknown; updated_at: unknown; }
interface RawEdge { id: string; org_id: string; manager_worker_id: unknown; report_worker_id: string; edge_type: string; created_at: unknown; }
interface RawTask { id: string; org_id: string; goal_id: string; parent_task_id: unknown; assigned_to_worker_id: unknown; accountable_worker_id: string; title: string; task_type: string; status: string; result_summary: unknown; created_at: unknown; updated_at: unknown; }
interface RawReport { id: string; org_id: string; task_id: string; from_worker_id: string; to_worker_id: string; report_type: string; summary: string; created_at: unknown; }
