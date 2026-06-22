/**
 * 数字员工组织查询 + 动作（E2 只读 + E3 控制台动作数据源）。
 *
 * 对接后端只读端点（E1/C0/C2：组织图/目标/信号）+ 动作端点（E3a：发起目标/审批/执行）。
 * 动作端点需 admin 角色（后端 requireRole('admin')）。
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface GoalTypeInfo {
  goalType: string;
  qualityRubric: Array<{ dimension: string; description: string }>;
  /** M2：当前激活的 playbook 规则包版本 + 来源（reference/distilled）。 */
  playbookVersion: number;
  provenance: 'reference' | 'distilled';
}

export interface OrgPosition {
  id: string;
  orgId: string;
  title: string;
  jobFamily: string;
  seniority: string;
  roleCode: string;
}

export interface DigitalWorker {
  id: string;
  orgId: string;
  personaId: string;
  positionId: string;
  displayName: string;
  employmentStatus: string;
}

export interface ReportingEdge {
  id: string;
  orgId: string;
  managerWorkerId: string | null;
  reportWorkerId: string;
  edgeType: string;
}

export interface OrgChart {
  orgId: string;
  positions: OrgPosition[];
  workers: DigitalWorker[];
  reportingEdges: ReportingEdge[];
}

export interface OrgGoal {
  id: string;
  orgId: string;
  ownerWorkerId: string;
  title: string;
  description: string;
  goalType: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrgTask {
  id: string;
  goalId: string;
  assignedToWorkerId: string | null;
  accountableWorkerId: string;
  title: string;
  taskType: string;
  status: string;
  riskLevel: 'low' | 'medium' | 'high';
  allowsToolExecution: boolean;
  acceptanceCriteria: string;
  requiredCapabilities: string[];
  resultSummary: string | null;
}

export interface TaskReport {
  id: string;
  taskId: string;
  fromWorkerId: string;
  toWorkerId: string;
  reportType: string;
  summary: string;
}

export interface GoalDetail {
  goal: OrgGoal;
  tasks: OrgTask[];
  reports: TaskReport[];
}

export interface WorkerOperatingSignal {
  workerId: string;
  activeTaskCount: number;
  deliveredTaskCount: number;
  blockedTaskCount: number;
  highRiskTaskCount: number;
  /** 在手且已逾期的任务数（C 链 SLA 时间感知）。 */
  overdueTaskCount: number;
  /** 在手且临近截止的任务数。 */
  dueSoonTaskCount: number;
  load: 'idle' | 'normal' | 'heavy';
  needsAttention: boolean;
}

export interface WorkerPersonaSignal {
  workerId: string;
  decisionConfidence: 'high' | 'medium' | 'low';
  confidenceRationale: string;
  collaborationReach: number;
  shouldReport: boolean;
  operating: WorkerOperatingSignal;
}

/* 注意：apiFetch 在 `{data: T}` 为唯一字段时自动拆封（client.ts），workforce 端点皆 { data: ... }
 * 单字段，故 apiFetch<T> 直接返回 T，不要再 .data（否则双重拆封）。 */

export function useGoalTypes() {
  return useQuery({
    queryKey: ['workforce', 'goal-types'],
    queryFn: ({ signal }) => apiFetch<GoalTypeInfo[]>('/api/v1/workforce/goal-types', { signal }),
  });
}

/* ── 可视化聚合（一次取齐组织树/目标流/信号/学习闭环，对接 GET /visualization）── */

export type WorkerLoad = 'idle' | 'normal' | 'heavy';

export interface OrgTreeNode {
  workerId: string;
  personaId: string;
  displayName: string;
  employmentStatus: string;
  roleCode: string;
  title: string;
  jobFamily: string;
  seniority: string;
  load: WorkerLoad;
  needsAttention: boolean;
  activeTaskCount: number;
}

export interface OrgTreeEdge {
  from: string;
  to: string;
  edgeType: 'solid' | 'dotted' | 'escalation';
}

export interface GoalFlowItem {
  goalId: string;
  title: string;
  status: string;
  ownerWorkerId: string;
  taskCount: number;
  tasksByStatus: Record<string, number>;
  blockedCount: number;
}

export interface WorkerSignalItem {
  workerId: string;
  displayName: string;
  operating: {
    activeTaskCount: number;
    deliveredTaskCount: number;
    blockedTaskCount: number;
    highRiskTaskCount: number;
    overdueTaskCount: number;
    dueSoonTaskCount: number;
    load: WorkerLoad;
    needsAttention: boolean;
  } | null;
  persona: {
    decisionConfidence: 'high' | 'medium' | 'low';
    collaborationReach: number;
    shouldReport: boolean;
  } | null;
}

export type BlockedDisposition = 'gap' | 'degraded' | 'timeout';

export interface LearningLoopItem {
  workerId: string;
  personaId: string;
  displayName: string;
  learnedCapabilities: Array<{ capability: string; examScore: number; learnedAt: number }>;
  activeLearning: Array<{ capability: string; status: string; priority: string }>;
  blockedTasks: Array<{ taskId: string; title: string; disposition: BlockedDisposition; requiredCapabilities: string[]; resumeAttemptCount: number }>;
}

export interface WorkforceViz {
  orgId: string;
  orgTree: { nodes: OrgTreeNode[]; edges: OrgTreeEdge[] };
  goalFlow: GoalFlowItem[];
  signals: WorkerSignalItem[];
  learningLoop: LearningLoopItem[];
}

export function useWorkforceViz(orgId: string) {
  return useQuery({
    queryKey: ['workforce', 'viz', orgId],
    queryFn: ({ signal }) => apiFetch<WorkforceViz>(`/api/v1/workforce/orgs/${encodeURIComponent(orgId)}/visualization`, { signal }),
    enabled: !!orgId,
  });
}

export function useOrgChart(orgId: string) {
  return useQuery({
    queryKey: ['workforce', 'chart', orgId],
    queryFn: ({ signal }) => apiFetch<OrgChart>(`/api/v1/workforce/orgs/${encodeURIComponent(orgId)}/chart`, { signal }),
    enabled: !!orgId,
  });
}

export function useOrgGoals(orgId: string) {
  return useQuery({
    queryKey: ['workforce', 'goals', orgId],
    queryFn: ({ signal }) => apiFetch<OrgGoal[]>(`/api/v1/workforce/orgs/${encodeURIComponent(orgId)}/goals`, { signal }),
    enabled: !!orgId,
  });
}

export function useGoalDetail(orgId: string, goalId: string) {
  return useQuery({
    queryKey: ['workforce', 'goal', orgId, goalId],
    queryFn: ({ signal }) => apiFetch<GoalDetail>(`/api/v1/workforce/orgs/${encodeURIComponent(orgId)}/goals/${encodeURIComponent(goalId)}`, { signal }),
    enabled: !!orgId && !!goalId,
  });
}

export function useWorkerPersonaSignal(orgId: string, workerId: string) {
  return useQuery({
    queryKey: ['workforce', 'persona-signal', orgId, workerId],
    queryFn: ({ signal }) => apiFetch<WorkerPersonaSignal>(`/api/v1/workforce/orgs/${encodeURIComponent(orgId)}/workers/${encodeURIComponent(workerId)}/persona-signal`, { signal }),
    enabled: !!orgId && !!workerId,
  });
}

/* ── E3 动作（发起目标 / 审批 / 执行；需 admin）── */

export interface OrgApproval {
  id: string;
  tenantId: string;
  orgId: string;
  subjectType: string;
  subjectId: string;
  requesterWorkerId: string;
  effectiveRisk: 'low' | 'medium' | 'high';
  requiresHuman: boolean;
  approvalMode: 'human_only' | 'org_or_human';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approverWorkerId: string | null;
  approverUserId: string | null;
  reason: string;
  correlationId: string | null;
  createdAt: number;
  expiresAt: number | null;
  decidedAt: number | null;
}

export interface RunGoalResult {
  goalId: string;
  taskCount: number;
  reportCount: number;
  executiveSummary: string;
  accountableStages: number;
  attributableSteps: number;
  /** 需真实执行的环节数（allowsToolExecution=true，留 delegated 等治理执行门）。 */
  pendingRealExecution: number;
  /** 目标整体状态：有待真实执行环节 → active；全部 stub 完成 → completed。 */
  goalStatus: 'active' | 'completed';
}

const orgKey = (orgId: string) => encodeURIComponent(orgId);

/** 待审批列表（控制台「待我审批」）。 */
export function usePendingApprovals(orgId: string) {
  return useQuery({
    queryKey: ['workforce', 'approvals-pending', orgId],
    queryFn: ({ signal }) => apiFetch<OrgApproval[]>(`/api/v1/workforce/orgs/${orgKey(orgId)}/approvals/pending`, { signal }),
    enabled: !!orgId,
  });
}

/** 发起目标（manager 数字员工运行一个目标；确定性 stub 执行）。 */
export function useRunGoal(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { managerWorkerId: string; title: string; description: string; goalType: string }) =>
      apiFetch<RunGoalResult>(`/api/v1/workforce/orgs/${orgKey(orgId)}/goals`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workforce', 'goals', orgId] }); },
  });
}

/** 人类决定一个审批（approve/reject）。 */
export function useDecideApproval(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ approvalId, decision, reason }: { approvalId: string; decision: 'approve' | 'reject'; reason?: string }) =>
      apiFetch<OrgApproval>(`/api/v1/workforce/orgs/${orgKey(orgId)}/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: 'POST', body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workforce', 'approvals-pending', orgId] }); },
  });
}
