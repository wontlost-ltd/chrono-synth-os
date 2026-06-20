/**
 * 数字员工组织领域类型（digital workforce M1）。
 *
 * 把一组数字人格组织成可治理的工作单元：岗位(position) → 数字员工(worker) → 汇报关系(reporting edge)
 * → 目标(goal) → 任务树(task) → 汇报(report)。全部确定性、零-LLM。
 */

/** 岗位资历层级。 */
export type Seniority = 'exec' | 'lead' | 'senior' | 'ic';

/** 一个岗位（CEO / 数字主管 / 写作 IC 等）。 */
export interface OrgPosition {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly title: string;
  readonly jobFamily: string;
  readonly seniority: Seniority;
  /** 稳定角色编码（如 ceo / managing_editor / writer_ic）。 */
  readonly roleCode: string;
  readonly createdAt: number;
}

/** 雇佣状态。 */
export type EmploymentStatus = 'active' | 'suspended' | 'offboarded';

/** 一个数字员工（绑定一个人格内核 + 一个岗位）。 */
export interface DigitalWorker {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  /** 绑定的人格内核 id（persona_core.id）。 */
  readonly personaId: string;
  readonly positionId: string;
  readonly displayName: string;
  readonly employmentStatus: EmploymentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 汇报关系类型。 */
export type ReportingEdgeType = 'solid' | 'dotted' | 'escalation';

/** 一条汇报关系（manager → report）。manager 为 null = 根（无上级）。 */
export interface ReportingEdge {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly managerWorkerId: string | null;
  readonly reportWorkerId: string;
  readonly edgeType: ReportingEdgeType;
  readonly createdAt: number;
}

/** 目标状态。 */
export type GoalStatus = 'proposed' | 'active' | 'completed' | 'cancelled';

/** 一个目标（由某 worker 拥有）。goalType 决定用哪个确定性分解 playbook。 */
export interface OrgGoal {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly ownerWorkerId: string;
  readonly title: string;
  readonly description: string;
  readonly goalType: string;
  readonly status: GoalStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 任务状态机。 */
export type TaskStatus =
  | 'draft'        /* 刚分解出，未委派 */
  | 'delegated'    /* 已委派给执行者 */
  | 'in_progress'  /* 执行中 */
  | 'submitted'    /* 已提交产出 */
  | 'approved'     /* 上级已审核通过 */
  | 'rejected'     /* 上级退回 */
  | 'blocked';     /* 阻塞 */

/** 一个任务（任务树节点）。parent 为 null = 顶层(manager 级)。 */
export interface OrgTask {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly goalId: string;
  readonly parentTaskId: string | null;
  /** 执行者 worker id；null = 尚未委派。 */
  readonly assignedToWorkerId: string | null;
  /** 问责 worker id（上级/委派者）。 */
  readonly accountableWorkerId: string;
  readonly title: string;
  readonly taskType: string;
  readonly status: TaskStatus;
  /** 执行产出摘要（null = 未完成）。 */
  readonly resultSummary: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 汇报类型。 */
export type ReportType = 'progress' | 'final' | 'blocker' | 'escalation';

/** 一条汇报（下属 → 上级）。 */
export interface TaskReport {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly taskId: string;
  readonly fromWorkerId: string;
  readonly toWorkerId: string;
  readonly reportType: ReportType;
  readonly summary: string;
  readonly createdAt: number;
}

/* ── 确定性分解 playbook 接口（智能来源：本切片硬编码 reference，未来由蒸馏编译）── */

/** 分解出的一个任务规格（playbook 输出，尚未落库）。 */
export interface TaskSpec {
  /** 该任务该由哪个岗位 role_code 的下属执行（manager 据此在下属里匹配）。 */
  readonly assigneeRoleCode: string;
  readonly title: string;
  readonly taskType: string;
}

/**
 * 确定性目标分解 playbook：把一个目标确定性地拆成一组任务规格。
 * 纯函数：相同 (goal) → 相同 TaskSpec[]（可复现，零-LLM）。
 */
export interface DecompositionPlaybook {
  /** 适用的 goalType。 */
  readonly goalType: string;
  /** 分解函数：给定目标标题/描述，确定性产出任务规格序列。 */
  decompose(goal: { readonly title: string; readonly description: string }): readonly TaskSpec[];
}
