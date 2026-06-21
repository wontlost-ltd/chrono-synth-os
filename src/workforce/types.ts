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
  /* ── A0 契约字段（来自 TaskSpec，落库供 B/D/E 复用）── */
  readonly riskLevel: RiskLevel;
  readonly allowsToolExecution: boolean;
  readonly acceptanceCriteria: string;
  readonly requiredCapabilities: readonly string[];
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

/** 任务风险等级（A0 契约：D 真实执行据此决定走不走人类审批门）。 */
export type RiskLevel = 'low' | 'medium' | 'high';

/* ── 确定性分解 playbook 接口（智能来源：本切片硬编码 reference，未来由蒸馏编译）── */

/**
 * 分解出的一个任务规格（playbook 输出，尚未落库）——**稳定契约**（A0）。
 * 后续切片据此协作/执行/展示，不再各自发明临时字段：
 *   - riskLevel：D 真实执行据此决定审批门。
 *   - allowsToolExecution：标记该任务**未来**是否允许走真实工具(ToolInvocationPipeline)。字段可为 true
 *     （如发布环节），但 **A0 不据此启用真实工具**——执行仍由 service stub 完成；D 切片接入后才生效。
 *   - acceptanceCriteria：E 展示 / D 判定完成。
 *   - requiredCapabilities：B/D 据此匹配（能力标签）。
 */
export interface TaskSpec {
  /** 该任务该由哪个岗位 role_code 的下属执行（manager 据此在下属里匹配）。 */
  readonly assigneeRoleCode: string;
  readonly title: string;
  readonly taskType: string;
  readonly riskLevel: RiskLevel;
  readonly allowsToolExecution: boolean;
  readonly acceptanceCriteria: string;
  readonly requiredCapabilities: readonly string[];
}

/* ── B1 协作（结构化消息，不是自由聊天）── */

/** 协作线程类型。 */
export type ThreadType = 'delegation' | 'report' | 'handoff' | 'coordination';
/** 线程状态。 */
export type ThreadStatus = 'open' | 'closed';

/** 一条协作线程（绑 org，可选绑 goal/task）。 */
export interface OrgConversationThread {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly threadType: ThreadType;
  readonly goalId: string | null;
  readonly taskId: string | null;
  readonly createdByWorkerId: string;
  readonly status: ThreadStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 结构化消息类型（不是自由文本意图——便于治理/审计）。 */
export type MessageType = 'request' | 'response' | 'report' | 'note' | 'escalation';

/** 一条线程内消息（from/to worker，结构化类型，可选 correlation）。 */
export interface OrgMessage {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly fromWorkerId: string;
  /** 去向 worker；null = 线程广播。 */
  readonly toWorkerId: string | null;
  readonly messageType: MessageType;
  readonly content: string;
  /** 关联任务/审批/委派 id（保审计链不断）。 */
  readonly correlationId: string | null;
  readonly createdAt: number;
}

/* ── D2 执行审批门（ADR-0055）── */

/** 审批对象类型。 */
export type ApprovalSubjectType = 'task_execution' | 'tool_invocation';
/** 审批状态机。 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** 一次执行审批请求。 */
export interface OrgApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly requesterWorkerId: string;
  /** 有效风险（确定性计算，铁律1 只升不降）。 */
  readonly effectiveRisk: RiskLevel;
  /** 是否要求人类审批（high/敏感/对外/资金/不可逆 → true）。 */
  readonly requiresHuman: boolean;
  /** 审批模式（路由结果持久化，防绕过）：human_only 只能人类批；org_or_human 允许直接上级 worker 批。 */
  readonly approvalMode: 'human_only' | 'org_or_human';
  readonly status: ApprovalStatus;
  /** 批准者（上级数字员工，仅 medium 且非 requiresHuman）。 */
  readonly approverWorkerId: string | null;
  /** 批准者（人类 user）。 */
  readonly approverUserId: string | null;
  readonly reason: string;
  readonly correlationId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly decidedAt: number | null;
}

/* ── C1 协作记忆（per-counterpart，解串味）── */

/** 对手方类型：同事 worker / 团队 / 外部干系人。 */
export type CounterpartType = 'worker' | 'team' | 'external';

/** 一个数字员工对某 counterpart 的协作记忆（per-counterpart，互不串味）。 */
export interface WorkerCollaborationMemory {
  readonly tenantId: string;
  readonly orgId: string;
  readonly workerId: string;
  readonly counterpartType: CounterpartType;
  readonly counterpartId: string;
  readonly interactionCount: number;
  readonly firstCollaboratedAt: number | null;
  readonly lastCollaboratedAt: number | null;
  readonly note: string | null;
}

/* ── B2 任务 handoff（交接协商）── */

/** handoff 状态机。 */
export type HandoffStatus = 'proposed' | 'accepted' | 'rejected' | 'cancelled';

/** 一次任务 handoff（from worker 提议把 task 交给 to worker）。 */
export interface OrgHandoff {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly taskId: string;
  readonly fromWorkerId: string;
  readonly toWorkerId: string;
  readonly reason: string;
  readonly status: HandoffStatus;
  readonly createdAt: number;
  readonly respondedAt: number | null;
}

/** 质量验收维度（playbook 级 rubric；E 展示 / 未来质检用）。 */
export interface QualityRubricDimension {
  /** 维度名（如「准确性」「完整性」）。 */
  readonly dimension: string;
  /** 该维度的验收说明。 */
  readonly description: string;
}

/**
 * 确定性目标分解 playbook：把一个目标确定性地拆成一组任务规格。
 * 纯函数：相同 (goal) → 相同 TaskSpec[]（可复现，零-LLM）。
 */
export interface DecompositionPlaybook {
  /** 适用的 goalType。 */
  readonly goalType: string;
  /** 该 goal type 的质量验收维度（rubric）——稳定契约，后续质检/展示复用。 */
  readonly qualityRubric: readonly QualityRubricDimension[];
  /** 分解函数：给定目标标题/描述，确定性产出任务规格序列。 */
  decompose(goal: { readonly title: string; readonly description: string }): readonly TaskSpec[];
}
