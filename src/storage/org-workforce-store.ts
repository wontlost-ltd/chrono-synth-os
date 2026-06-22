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
  Seniority, EmploymentStatus, ReportingEdgeType, GoalStatus, TaskStatus, ReportType, RiskLevel,
  OrgConversationThread, OrgMessage, ThreadType, ThreadStatus, MessageType,
  OrgHandoff, HandoffStatus,
  OrgApproval, ApprovalSubjectType, ApprovalStatus, RiskLevel as ApprovalRiskLevel,
  OrgEscalation, EscalationStatus,
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

/** risk_level 白名单兜底：非 low/medium/high → low（防脏值，A0 契约暴露前收口）。 */
function coerceRiskLevel(v: unknown): RiskLevel {
  return v === 'medium' || v === 'high' ? v : 'low';
}

/** required_capabilities 反序列化：JSON 数组字符串 → string[]；脏数据/null → 空数组（不崩）。 */
function parseCapabilities(v: unknown): readonly string[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
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
       FROM org_positions WHERE tenant_id = ? AND org_id = ?
       ORDER BY created_at ASC, id ASC`,
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
       FROM digital_workers WHERE tenant_id = ? AND org_id = ?
       ORDER BY created_at ASC, id ASC`,
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

  /**
   * 取某 worker 的**直接上级** worker id（沿 solid 汇报边向上）；null = 根（无上级）。
   * 升级链用：阻塞者向其直接上级升级。确定性（同 report 只有一个 solid manager；多边取 id 最小兜底）。
   */
  getManagerOf(orgId: string, reportWorkerId: string): string | null {
    const row = this.db.prepare<{ manager_worker_id: string | null }>(
      `SELECT manager_worker_id FROM reporting_edges
       WHERE tenant_id = ? AND org_id = ? AND report_worker_id = ? AND edge_type = 'solid' AND manager_worker_id IS NOT NULL
       ORDER BY manager_worker_id ASC LIMIT 1`,
    ).get(this.tenantId, orgId, reportWorkerId);
    return row ? nullableStr(row.manager_worker_id) : null;
  }

  /* ── goals ── */

  insertGoal(g: Omit<OrgGoal, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_goals (id, tenant_id, org_id, owner_worker_id, title, description, goal_type, status, playbook_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, this.tenantId, g.orgId, g.ownerWorkerId, g.title, g.description, g.goalType, g.status, g.playbookVersion, g.createdAt, g.updatedAt);
  }

  updateGoalStatus(orgId: string, goalId: string, status: GoalStatus, now: number): void {
    this.db.prepare<void>(
      `UPDATE org_goals SET status = ?, updated_at = ? WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).run(status, now, this.tenantId, orgId, goalId);
  }

  /** 列出某组织的目标（确定性排序：created_at 升序、id 升序兜底）。 */
  listGoals(orgId: string): OrgGoal[] {
    const rows = this.db.prepare<RawGoal>(
      `SELECT id, org_id, owner_worker_id, title, description, goal_type, status, playbook_version, created_at, updated_at
       FROM org_goals WHERE tenant_id = ? AND org_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId);
    return rows.map((r) => this.toGoal(r));
  }

  /**
   * 列出某 goalType 在某激活 playbook 版本下的目标（M3 蒸馏取经验样本用）。确定性排序。
   * 只看**当前版本**产生的目标——蒸馏要评估「当前规则」的表现，不混入旧版本样本。
   */
  listGoalsByTypeAndVersion(orgId: string, goalType: string, playbookVersion: number): OrgGoal[] {
    const rows = this.db.prepare<RawGoal>(
      `SELECT id, org_id, owner_worker_id, title, description, goal_type, status, playbook_version, created_at, updated_at
       FROM org_goals WHERE tenant_id = ? AND org_id = ? AND goal_type = ? AND playbook_version = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, goalType, playbookVersion);
    return rows.map((r) => this.toGoal(r));
  }

  /** 取单个目标；无 → undefined。 */
  getGoal(orgId: string, goalId: string): OrgGoal | undefined {
    const row = this.db.prepare<RawGoal>(
      `SELECT id, org_id, owner_worker_id, title, description, goal_type, status, playbook_version, created_at, updated_at
       FROM org_goals WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).get(this.tenantId, orgId, goalId);
    return row ? this.toGoal(row) : undefined;
  }

  /* ── tasks ── */

  /**
   * 插入任务。L8a 唤醒守卫字段（resume_attempt_count / last_wake_event_id）**不由插入方提供**——
   * 新任务恒由 DB 默认起步（计数 0 / 事件 null），只有唤醒流程推进它们，故从插入入参 Omit 掉。
   */
  insertTask(t: Omit<OrgTask, 'tenantId' | 'resumeAttemptCount' | 'lastWakeEventId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_tasks (id, tenant_id, org_id, goal_id, parent_task_id, assigned_to_worker_id, accountable_worker_id, title, task_type, status, risk_level, allows_tool_execution, acceptance_criteria, required_capabilities, result_summary, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id, this.tenantId, t.orgId, t.goalId, t.parentTaskId, t.assignedToWorkerId, t.accountableWorkerId, t.title, t.taskType, t.status,
      t.riskLevel, t.allowsToolExecution ? 1 : 0, t.acceptanceCriteria, JSON.stringify(t.requiredCapabilities),
      t.resultSummary, t.dueAt, t.createdAt, t.updatedAt,
    );
  }

  updateTaskExecution(orgId: string, taskId: string, status: TaskStatus, resultSummary: string | null, now: number): void {
    this.db.prepare<void>(
      `UPDATE org_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).run(status, resultSummary, now, this.tenantId, orgId, taskId);
  }

  /**
   * 条件改任务执行状态（D3 真实执行用）：仅当任务**当前状态仍是 expectedStatus** 才转移——
   * 防同一任务被并发重复执行（两个执行循环同时把 delegated 任务拉起执行）。返回是否真的改了（changes>0）。
   * 只有抢到「delegated→in_progress」转移的那一个执行者真正调用工具，其余拿到 false 直接退出。
   */
  transitionTaskExecutionIfStatus(orgId: string, taskId: string, expectedStatus: TaskStatus, nextStatus: TaskStatus, resultSummary: string | null, now: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_tasks SET status = ?, result_summary = ?, updated_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = ?`,
    ).run(nextStatus, resultSummary, now, this.tenantId, orgId, taskId, expectedStatus);
    return r.changes > 0;
  }

  /**
   * ADR-0057 L8a：找因某 (persona, capability) 缺口而挂起（blocked）的任务——学完唤醒用。
   * 经 learning_requests.triggered_by_task_id 连接：该 persona 该 capability 的学习请求触发了哪些任务，
   * 其中仍 blocked 的就是待唤醒候选。per-persona（learning_requests.persona_id）+ tenant 隔离（红线 8/15）。
   * 确定性排序（created_at 升序、id 升序兜底）。去重（多请求可能指同一任务）。
   */
  listBlockedTasksForLearnedCapability(personaId: string, capability: string): OrgTask[] {
    const rows = this.db.prepare<RawTask>(
      `SELECT DISTINCT t.id, t.org_id, t.goal_id, t.parent_task_id, t.assigned_to_worker_id, t.accountable_worker_id, t.title, t.task_type, t.status, t.risk_level, t.allows_tool_execution, t.acceptance_criteria, t.required_capabilities, t.result_summary, t.due_at, t.resume_attempt_count, t.last_wake_event_id, t.created_at, t.updated_at
       FROM org_tasks t
       JOIN learning_requests lr ON lr.tenant_id = t.tenant_id AND lr.triggered_by_task_id = t.id
       WHERE t.tenant_id = ? AND lr.persona_id = ? AND lr.capability = ? AND t.status = 'blocked'
       ORDER BY t.created_at ASC, t.id ASC`,
    ).all(this.tenantId, personaId, capability);
    return rows.map((r) => this.toTask(r));
  }

  /**
   * ADR-0057 L8a：唤醒重跑——把挂起任务从 blocked 推回 delegated（重新可执行），并**原子**推进尝试计数 +
   * 记录唤醒事件 id（幂等 + 防死循环）。仅当任务**仍是 blocked**才转移（CAS，防并发覆盖/重复唤醒）。
   * 返回是否真的唤醒了（changes>0）。被并发改走（已非 blocked）→ false（不强行覆盖）。
   */
  wakeBlockedTaskToDelegated(orgId: string, taskId: string, resultSummary: string, wakeEventId: string, now: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_tasks
       SET status = 'delegated', result_summary = ?, resume_attempt_count = resume_attempt_count + 1,
           last_wake_event_id = ?, updated_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'blocked'`,
    ).run(resultSummary, wakeEventId, now, this.tenantId, orgId, taskId);
    return r.changes > 0;
  }

  /**
   * ADR-0057 L8a：复检仍缺口 / 超尝试上限——只推进尝试计数 + 记事件 id，**不改状态**（保持 blocked，fail-closed）。
   * 仅当仍 blocked 才推进（CAS）。返回是否推进。用于「唤醒了但复检仍缺/超限」的可审计记账（防死循环计数）。
   */
  recordWakeAttemptOnBlocked(orgId: string, taskId: string, resultSummary: string, wakeEventId: string, now: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_tasks
       SET result_summary = ?, resume_attempt_count = resume_attempt_count + 1, last_wake_event_id = ?, updated_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'blocked'`,
    ).run(resultSummary, wakeEventId, now, this.tenantId, orgId, taskId);
    return r.changes > 0;
  }

  /** 取单个任务；无 → undefined。 */
  getTask(orgId: string, taskId: string): OrgTask | undefined {
    const row = this.db.prepare<RawTask>(
      `SELECT id, org_id, goal_id, parent_task_id, assigned_to_worker_id, accountable_worker_id, title, task_type, status, risk_level, allows_tool_execution, acceptance_criteria, required_capabilities, result_summary, due_at, resume_attempt_count, last_wake_event_id, created_at, updated_at
       FROM org_tasks WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).get(this.tenantId, orgId, taskId);
    return row ? this.toTask(row) : undefined;
  }

  /**
   * 条件改任务执行者（handoff accept 时用）：仅当任务**当前执行者仍是 expectedCurrent** 才改——
   * 防陈旧 handoff 抢走已交接出去的任务。返回是否真的改了（changes>0）。
   */
  reassignTaskIfHeldBy(orgId: string, taskId: string, expectedCurrentWorkerId: string, newAssigneeWorkerId: string, now: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_tasks SET assigned_to_worker_id = ?, updated_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND assigned_to_worker_id = ?`,
    ).run(newAssigneeWorkerId, now, this.tenantId, orgId, taskId, expectedCurrentWorkerId);
    return r.changes > 0;
  }

  /**
   * ADR-0057 L8b 委派 reassign：仅当任务**仍 delegated 且仍由 expectedCurrentWorkerId 持有**才改派——
   * 比 reassignTaskIfHeldBy 多锁 status='delegated'（防委派决策与落地之间任务被并发拉起 in_progress/改走，
   * 把执行中的任务误改派，Codex L8b 复审）。返回是否真的改了。
   */
  reassignDelegatedTaskIfHeldBy(orgId: string, taskId: string, expectedCurrentWorkerId: string, newAssigneeWorkerId: string, now: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_tasks SET assigned_to_worker_id = ?, updated_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND assigned_to_worker_id = ? AND status = 'delegated'`,
    ).run(newAssigneeWorkerId, now, this.tenantId, orgId, taskId, expectedCurrentWorkerId);
    return r.changes > 0;
  }

  /** 取某 worker 当前被指派的任务（确定性排序）。用于算 worker 运行信号/负载。 */
  listTasksByAssignee(orgId: string, workerId: string): OrgTask[] {
    const rows = this.db.prepare<RawTask>(
      `SELECT id, org_id, goal_id, parent_task_id, assigned_to_worker_id, accountable_worker_id, title, task_type, status, risk_level, allows_tool_execution, acceptance_criteria, required_capabilities, result_summary, due_at, resume_attempt_count, last_wake_event_id, created_at, updated_at
       FROM org_tasks WHERE tenant_id = ? AND org_id = ? AND assigned_to_worker_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, workerId);
    return rows.map((r) => this.toTask(r));
  }

  /** 取某目标的任务（确定性排序：created_at 升序、id 升序兜底）。 */
  listTasksByGoal(orgId: string, goalId: string): OrgTask[] {
    const rows = this.db.prepare<RawTask>(
      `SELECT id, org_id, goal_id, parent_task_id, assigned_to_worker_id, accountable_worker_id, title, task_type, status, risk_level, allows_tool_execution, acceptance_criteria, required_capabilities, result_summary, due_at, resume_attempt_count, last_wake_event_id, created_at, updated_at
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

  /* ── B1 协作：线程 + 消息 ── */

  insertThread(t: Omit<OrgConversationThread, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_conversation_threads (id, tenant_id, org_id, thread_type, goal_id, task_id, created_by_worker_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, this.tenantId, t.orgId, t.threadType, t.goalId, t.taskId, t.createdByWorkerId, t.status, t.createdAt, t.updatedAt);
  }

  getThread(orgId: string, threadId: string): OrgConversationThread | undefined {
    const row = this.db.prepare<RawThread>(
      `SELECT id, org_id, thread_type, goal_id, task_id, created_by_worker_id, status, created_at, updated_at
       FROM org_conversation_threads WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).get(this.tenantId, orgId, threadId);
    return row ? this.toThread(row) : undefined;
  }

  listThreads(orgId: string): OrgConversationThread[] {
    const rows = this.db.prepare<RawThread>(
      `SELECT id, org_id, thread_type, goal_id, task_id, created_by_worker_id, status, created_at, updated_at
       FROM org_conversation_threads WHERE tenant_id = ? AND org_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId);
    return rows.map((r) => this.toThread(r));
  }

  setThreadStatus(orgId: string, threadId: string, status: ThreadStatus, now: number): void {
    this.db.prepare<void>(
      `UPDATE org_conversation_threads SET status = ?, updated_at = ? WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).run(status, now, this.tenantId, orgId, threadId);
  }

  insertMessage(m: Omit<OrgMessage, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_messages (id, tenant_id, org_id, thread_id, from_worker_id, to_worker_id, message_type, content, correlation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, this.tenantId, m.orgId, m.threadId, m.fromWorkerId, m.toWorkerId, m.messageType, m.content, m.correlationId, m.createdAt);
  }

  /** 列出线程内消息（确定性排序：created_at 升序、id 升序兜底）。 */
  listMessages(orgId: string, threadId: string): OrgMessage[] {
    const rows = this.db.prepare<RawMessage>(
      `SELECT id, org_id, thread_id, from_worker_id, to_worker_id, message_type, content, correlation_id, created_at
       FROM org_messages WHERE tenant_id = ? AND org_id = ? AND thread_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, threadId);
    return rows.map((r) => this.toMessage(r));
  }

  /* ── B2 handoff ── */

  insertHandoff(h: Omit<OrgHandoff, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_handoffs (id, tenant_id, org_id, task_id, from_worker_id, to_worker_id, reason, status, created_at, responded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(h.id, this.tenantId, h.orgId, h.taskId, h.fromWorkerId, h.toWorkerId, h.reason, h.status, h.createdAt, h.respondedAt);
  }

  getHandoff(orgId: string, handoffId: string): OrgHandoff | undefined {
    const row = this.db.prepare<RawHandoff>(
      `SELECT id, org_id, task_id, from_worker_id, to_worker_id, reason, status, created_at, responded_at
       FROM org_handoffs WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).get(this.tenantId, orgId, handoffId);
    return row ? this.toHandoff(row) : undefined;
  }

  listHandoffsByTask(orgId: string, taskId: string): OrgHandoff[] {
    const rows = this.db.prepare<RawHandoff>(
      `SELECT id, org_id, task_id, from_worker_id, to_worker_id, reason, status, created_at, responded_at
       FROM org_handoffs WHERE tenant_id = ? AND org_id = ? AND task_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, taskId);
    return rows.map((r) => this.toHandoff(r));
  }

  /**
   * 条件状态迁移：仅当 handoff **当前仍是 proposed** 才改为 status——原子防并发（两个响应不会都成功）。
   * 返回是否真的改了（changes>0）。
   */
  transitionHandoffIfProposed(orgId: string, handoffId: string, status: HandoffStatus, respondedAt: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_handoffs SET status = ?, responded_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'proposed'`,
    ).run(status, respondedAt, this.tenantId, orgId, handoffId);
    return r.changes > 0;
  }

  /* ── B 链 升级链 ── */

  insertEscalation(e: Omit<OrgEscalation, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_escalations (id, tenant_id, org_id, task_id, from_worker_id, to_worker_id, parent_escalation_id, depth, status, reason, resolution, correlation_id, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, this.tenantId, e.orgId, e.taskId, e.fromWorkerId, e.toWorkerId, e.parentEscalationId, e.depth, e.status, e.reason, e.resolution, e.correlationId, e.createdAt, e.decidedAt);
  }

  getEscalation(orgId: string, escalationId: string): OrgEscalation | undefined {
    const row = this.db.prepare<RawEscalation>(
      `SELECT id, org_id, task_id, from_worker_id, to_worker_id, parent_escalation_id, depth, status, reason, resolution, correlation_id, created_at, decided_at
       FROM org_escalations WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).get(this.tenantId, orgId, escalationId);
    return row ? this.toEscalation(row) : undefined;
  }

  /** 取某任务的升级链（确定性排序：depth 升序、created_at 升序、id 兜底）。 */
  listEscalationsByTask(orgId: string, taskId: string): OrgEscalation[] {
    const rows = this.db.prepare<RawEscalation>(
      `SELECT id, org_id, task_id, from_worker_id, to_worker_id, parent_escalation_id, depth, status, reason, resolution, correlation_id, created_at, decided_at
       FROM org_escalations WHERE tenant_id = ? AND org_id = ? AND task_id = ?
       ORDER BY depth ASC, created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, taskId);
    return rows.map((r) => this.toEscalation(r));
  }

  /** 取某 worker 收到的 pending 升级（「待我处置」；确定性排序）。 */
  listPendingEscalationsTo(orgId: string, toWorkerId: string): OrgEscalation[] {
    const rows = this.db.prepare<RawEscalation>(
      `SELECT id, org_id, task_id, from_worker_id, to_worker_id, parent_escalation_id, depth, status, reason, resolution, correlation_id, created_at, decided_at
       FROM org_escalations WHERE tenant_id = ? AND org_id = ? AND to_worker_id = ? AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, toWorkerId);
    return rows.map((r) => this.toEscalation(r));
  }

  /**
   * 条件决定升级：仅当**当前仍 pending** 才转移为 resolved/reescalated/cancelled——原子防并发双处置。
   * 返回是否真的改了（changes>0）。resolution 仅 resolve 时填。
   */
  transitionEscalationIfPending(orgId: string, escalationId: string, status: 'resolved' | 'reescalated' | 'cancelled', resolution: string | null, decidedAt: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_escalations SET status = ?, resolution = ?, decided_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'pending'`,
    ).run(status, resolution, decidedAt, this.tenantId, orgId, escalationId);
    return r.changes > 0;
  }

  /* ── D2 执行审批 ── */

  insertApproval(a: Omit<OrgApproval, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO org_approvals (id, tenant_id, org_id, subject_type, subject_id, requester_worker_id, effective_risk, requires_human, approval_mode, status, approver_worker_id, approver_user_id, reason, correlation_id, created_at, expires_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, this.tenantId, a.orgId, a.subjectType, a.subjectId, a.requesterWorkerId, a.effectiveRisk, a.requiresHuman ? 1 : 0, a.approvalMode, a.status, a.approverWorkerId, a.approverUserId, a.reason, a.correlationId, a.createdAt, a.expiresAt, a.decidedAt);
  }

  getApproval(orgId: string, approvalId: string): OrgApproval | undefined {
    const row = this.db.prepare<RawApproval>(
      `SELECT id, org_id, subject_type, subject_id, requester_worker_id, effective_risk, requires_human, approval_mode, status, approver_worker_id, approver_user_id, reason, correlation_id, created_at, expires_at, decided_at
       FROM org_approvals WHERE tenant_id = ? AND org_id = ? AND id = ?`,
    ).get(this.tenantId, orgId, approvalId);
    return row ? this.toApproval(row) : undefined;
  }

  listApprovalsBySubject(orgId: string, subjectType: ApprovalSubjectType, subjectId: string): OrgApproval[] {
    const rows = this.db.prepare<RawApproval>(
      `SELECT id, org_id, subject_type, subject_id, requester_worker_id, effective_risk, requires_human, approval_mode, status, approver_worker_id, approver_user_id, reason, correlation_id, created_at, expires_at, decided_at
       FROM org_approvals WHERE tenant_id = ? AND org_id = ? AND subject_type = ? AND subject_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId, subjectType, subjectId);
    return rows.map((r) => this.toApproval(r));
  }

  /** 列出某 org 当前 pending 的审批（E3 控制台「待我审批」视图用；确定性排序）。调用方应先 expireStaleApprovals。 */
  listPendingApprovals(orgId: string): OrgApproval[] {
    const rows = this.db.prepare<RawApproval>(
      `SELECT id, org_id, subject_type, subject_id, requester_worker_id, effective_risk, requires_human, approval_mode, status, approver_worker_id, approver_user_id, reason, correlation_id, created_at, expires_at, decided_at
       FROM org_approvals WHERE tenant_id = ? AND org_id = ? AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    ).all(this.tenantId, orgId);
    return rows.map((r) => this.toApproval(r));
  }

  /**
   * 条件决定审批：仅当**当前仍是 pending 且未过期**才改为 approved/rejected——原子防并发 + 防过期后批。
   * 返回是否真的改了（changes>0）。
   */
  decideApprovalIfPending(orgId: string, approvalId: string, status: 'approved' | 'rejected', approverWorkerId: string | null, approverUserId: string | null, now: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE org_approvals SET status = ?, approver_worker_id = ?, approver_user_id = ?, decided_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`,
    ).run(status, approverWorkerId, approverUserId, now, this.tenantId, orgId, approvalId, now);
    return r.changes > 0;
  }

  /** 把已过期的 pending 审批标记为 expired（changes 即过期数）。 */
  expireStaleApprovals(orgId: string, now: number): number {
    const r = this.db.prepare<void>(
      `UPDATE org_approvals SET status = 'expired', decided_at = ?
       WHERE tenant_id = ? AND org_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).run(now, this.tenantId, orgId, now);
    return r.changes;
  }

  /* ── row → domain 映射 ── */

  private toApproval(r: RawApproval): OrgApproval {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id,
      subjectType: r.subject_type as ApprovalSubjectType, subjectId: r.subject_id,
      requesterWorkerId: r.requester_worker_id, effectiveRisk: r.effective_risk as ApprovalRiskLevel,
      requiresHuman: num(r.requires_human) === 1,
      approvalMode: r.approval_mode === 'org_or_human' ? 'org_or_human' : 'human_only',
      status: r.status as ApprovalStatus,
      approverWorkerId: nullableStr(r.approver_worker_id), approverUserId: nullableStr(r.approver_user_id),
      reason: r.reason, correlationId: nullableStr(r.correlation_id),
      createdAt: num(r.created_at),
      expiresAt: r.expires_at === null || r.expires_at === undefined ? null : num(r.expires_at),
      decidedAt: r.decided_at === null || r.decided_at === undefined ? null : num(r.decided_at),
    };
  }

  private toHandoff(r: RawHandoff): OrgHandoff {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, taskId: r.task_id,
      fromWorkerId: r.from_worker_id, toWorkerId: r.to_worker_id, reason: r.reason,
      status: r.status as HandoffStatus, createdAt: num(r.created_at),
      respondedAt: r.responded_at === null || r.responded_at === undefined ? null : num(r.responded_at),
    };
  }

  private toEscalation(r: RawEscalation): OrgEscalation {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, taskId: r.task_id,
      fromWorkerId: r.from_worker_id, toWorkerId: r.to_worker_id,
      parentEscalationId: nullableStr(r.parent_escalation_id), depth: num(r.depth),
      status: r.status as EscalationStatus, reason: r.reason, resolution: nullableStr(r.resolution),
      correlationId: nullableStr(r.correlation_id), createdAt: num(r.created_at),
      decidedAt: r.decided_at === null || r.decided_at === undefined ? null : num(r.decided_at),
    };
  }

  private toThread(r: RawThread): OrgConversationThread {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, threadType: r.thread_type as ThreadType,
      goalId: nullableStr(r.goal_id), taskId: nullableStr(r.task_id), createdByWorkerId: r.created_by_worker_id,
      status: r.status as ThreadStatus, createdAt: num(r.created_at), updatedAt: num(r.updated_at),
    };
  }

  private toMessage(r: RawMessage): OrgMessage {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, threadId: r.thread_id,
      fromWorkerId: r.from_worker_id, toWorkerId: nullableStr(r.to_worker_id),
      messageType: r.message_type as MessageType, content: r.content, correlationId: nullableStr(r.correlation_id),
      createdAt: num(r.created_at),
    };
  }

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

  private toGoal(r: RawGoal): OrgGoal {
    return {
      id: r.id, tenantId: this.tenantId, orgId: r.org_id, ownerWorkerId: r.owner_worker_id,
      title: r.title, description: r.description, goalType: r.goal_type,
      status: r.status as GoalStatus,
      /* playbook_version：integer，SQLite number / PG 可能 string → num()（默认列非空，脏值兜底 1）。 */
      playbookVersion: num(r.playbook_version) || 1,
      createdAt: num(r.created_at), updatedAt: num(r.updated_at),
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
      status: r.status as TaskStatus,
      /* 脏值兜底：非白名单 → low（防 API 暴露前读到脏 risk_level）。 */
      riskLevel: coerceRiskLevel(r.risk_level),
      /* SQLite 存 0/1，PG 存 integer；Number() 后判真。 */
      allowsToolExecution: num(r.allows_tool_execution) === 1,
      acceptanceCriteria: r.acceptance_criteria ?? '',
      requiredCapabilities: parseCapabilities(r.required_capabilities),
      resultSummary: nullableStr(r.result_summary),
      /* due_at 可空 bigint：null 保留 null；否则 Number() 强转（node-pg 返回 string）。 */
      dueAt: r.due_at === null || r.due_at === undefined ? null : num(r.due_at),
      /* L8a：唤醒守卫字段。resume_attempt_count 默认 0（旧任务/无 row）；last_wake_event_id 可空。 */
      resumeAttemptCount: num(r.resume_attempt_count),
      lastWakeEventId: nullableStr(r.last_wake_event_id),
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
interface RawGoal { id: string; org_id: string; owner_worker_id: string; title: string; description: string; goal_type: string; status: string; playbook_version: unknown; created_at: unknown; updated_at: unknown; }
interface RawTask { id: string; org_id: string; goal_id: string; parent_task_id: unknown; assigned_to_worker_id: unknown; accountable_worker_id: string; title: string; task_type: string; status: string; risk_level: string | null; allows_tool_execution: unknown; acceptance_criteria: string | null; required_capabilities: unknown; result_summary: unknown; due_at: unknown; resume_attempt_count: unknown; last_wake_event_id: unknown; created_at: unknown; updated_at: unknown; }
interface RawReport { id: string; org_id: string; task_id: string; from_worker_id: string; to_worker_id: string; report_type: string; summary: string; created_at: unknown; }
interface RawThread { id: string; org_id: string; thread_type: string; goal_id: unknown; task_id: unknown; created_by_worker_id: string; status: string; created_at: unknown; updated_at: unknown; }
interface RawMessage { id: string; org_id: string; thread_id: string; from_worker_id: string; to_worker_id: unknown; message_type: string; content: string; correlation_id: unknown; created_at: unknown; }
interface RawHandoff { id: string; org_id: string; task_id: string; from_worker_id: string; to_worker_id: string; reason: string; status: string; created_at: unknown; responded_at: unknown; }
interface RawEscalation { id: string; org_id: string; task_id: string; from_worker_id: string; to_worker_id: string; parent_escalation_id: unknown; depth: unknown; status: string; reason: string; resolution: unknown; correlation_id: unknown; created_at: unknown; decided_at: unknown; }
interface RawApproval { id: string; org_id: string; subject_type: string; subject_id: string; requester_worker_id: string; effective_risk: string; requires_human: unknown; approval_mode: string; status: string; approver_worker_id: unknown; approver_user_id: unknown; reason: string; correlation_id: unknown; created_at: unknown; expires_at: unknown; decided_at: unknown; }
