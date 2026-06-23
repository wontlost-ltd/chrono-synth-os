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

/* ── 自助建组织 / 招数字员工（admin）── */

export type Archetype = 'explorer' | 'guardian' | 'analyst' | 'doer';
export type Seniority = 'exec' | 'lead' | 'senior' | 'ic';

export interface CreateOrgResult { orgId: string; rootWorkerId: string; birth: { personaId: string; kind: string } }
export interface HireWorkerResult { orgId: string; workerId: string; birth: { personaId: string; kind: string } }

/** 建组织 + 根数字员工（无上级）。建完使该 org 的 chart/viz 失效。 */
export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { orgId: string; roleCode: string; title: string; displayName: string; jobFamily?: string; seniority?: Seniority; archetype?: Archetype }) =>
      apiFetch<CreateOrgResult>('/api/v1/workforce/orgs', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['workforce', 'chart', r.orgId] });
      void qc.invalidateQueries({ queryKey: ['workforce', 'viz', r.orgId] });
    },
  });
}

/** 招一名数字员工到已有组织（挂在 managerWorkerId 下）。招完使该 org 的 chart/viz 失效。 */
export function useHireWorker(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { managerWorkerId: string; roleCode: string; title: string; displayName: string; jobFamily?: string; seniority?: Seniority; archetype?: Archetype }) =>
      apiFetch<HireWorkerResult>(`/api/v1/workforce/orgs/${orgKey(orgId)}/workers`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workforce', 'chart', orgId] });
      void qc.invalidateQueries({ queryKey: ['workforce', 'viz', orgId] });
    },
  });
}

/* ── 组织重组/并购（admin，确定性结构操作）── */

export interface AbsorbResult { movedWorkers: number; renamedRoles: Array<{ from: string; to: string }>; sourceRootWorkerId: string }
export interface RestructureSuggestion { kind: 'offboard_idle' | 'redistribute_overloaded'; workerId: string; displayName: string; reason: string; suggestedAction: 'offboard' | 'reparent' | 'hire' }

/** 吸收：源组织并入本组织（orgId=目标），源根接到 mountUnderWorkerId 下。 */
export function useAbsorbOrg(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { sourceOrgId: string; mountUnderWorkerId: string }) =>
      apiFetch<AbsorbResult>(`/api/v1/workforce/orgs/${orgKey(orgId)}/absorb`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workforce', 'chart', orgId] }); void qc.invalidateQueries({ queryKey: ['workforce', 'viz', orgId] }); },
  });
}

/** reparent：改某 worker 的直接上级。 */
export function useReparentWorker(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { workerId: string; newManagerWorkerId: string }) =>
      apiFetch<unknown>(`/api/v1/workforce/orgs/${orgKey(orgId)}/reparent`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workforce', 'chart', orgId] }); void qc.invalidateQueries({ queryKey: ['workforce', 'viz', orgId] }); },
  });
}

/** offboard：裁撤一名 worker（有下属/在手任务须给安置/重分配对象）。 */
export function useOffboardWorker(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { workerId: string; reparentReportsTo?: string; reassignTasksTo?: string }) =>
      apiFetch<unknown>(`/api/v1/workforce/orgs/${orgKey(orgId)}/offboard`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workforce', 'chart', orgId] }); void qc.invalidateQueries({ queryKey: ['workforce', 'viz', orgId] }); },
  });
}

/** 重组建议（确定性信号 → 建议，不自动执行）。 */
export function useRestructureSuggestions(orgId: string) {
  return useQuery({
    queryKey: ['workforce', 'restructure-suggestions', orgId],
    queryFn: ({ signal }) => apiFetch<{ orgId: string; suggestions: RestructureSuggestion[] }>(`/api/v1/workforce/orgs/${orgKey(orgId)}/restructure/suggestions`, { signal }),
    enabled: !!orgId,
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

/* ── 双边工单市场（ADR-0058）：org 竞标接单 + 发布者确认委派 ── */

export interface OrgTaskApplication { id: string; taskId: string; orgId: string; rankingScore: number; status: string; createdAt: number; updatedAt: number }
export interface OrgTaskAssignment { id: string; taskId: string; orgId: string; applicationId: string | null; orgGoalId: string | null; status: string; assignedAt: number; submittedAt: number | null; completedAt: number | null }

/** org 视角：该组织的申请（我领取了哪些工单）。 */
export function useOrgBidApplications(orgId: string) {
  return useQuery({
    queryKey: ['workforce', 'bids', 'applications', orgId],
    enabled: orgId.length > 0,
    queryFn: ({ signal }) => apiFetch<OrgTaskApplication[]>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/applications`, { signal }),
  });
}

/** org 视角：委派给该组织的工单（指派）。 */
export function useOrgBidAssignments(orgId: string) {
  return useQuery({
    queryKey: ['workforce', 'bids', 'assignments', orgId],
    enabled: orgId.length > 0,
    queryFn: ({ signal }) => apiFetch<OrgTaskAssignment[]>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/assignments`, { signal }),
  });
}

/** 发布者视角：某工单的 org 申请者列表（据此选委派给谁）。 */
export function useOrgBidApplicants(orgId: string, taskId: string) {
  return useQuery({
    queryKey: ['workforce', 'bids', 'applicants', orgId, taskId],
    enabled: orgId.length > 0 && taskId.length > 0,
    queryFn: ({ signal }) => apiFetch<OrgTaskApplication[]>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/tasks/${encodeURIComponent(taskId)}/applicants`, { signal }),
  });
}

function invalidateBids(qc: ReturnType<typeof useQueryClient>, orgId: string) {
  void qc.invalidateQueries({ queryKey: ['workforce', 'bids'] });
  void qc.invalidateQueries({ queryKey: ['workforce', 'viz', orgId] });
}

/** org 领取一个 open 工单（登记接单意向，不触发执行）。 */
export function useOrgBidApply(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string }) =>
      apiFetch<OrgTaskApplication>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/apply`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidateBids(qc, orgId),
  });
}

/** 发布者确认把工单委派给某组织。 */
export function useOrgBidConfirmAssign(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string; orgId: string }) =>
      apiFetch<OrgTaskAssignment>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/confirm-assign`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidateBids(qc, orgId),
  });
}

/** org 启动执行（选 manager + goalType 触发 runGoal 分解）。 */
export function useOrgBidStart(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string; managerWorkerId: string; goalType: string }) =>
      apiFetch<{ assignment: OrgTaskAssignment; goal: { goalId: string; taskCount: number } }>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/start`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidateBids(qc, orgId),
  });
}

/** org 完工提交（发布者待验收）。 */
export function useOrgBidSubmit(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string }) =>
      apiFetch<OrgTaskAssignment>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/submit`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidateBids(qc, orgId),
  });
}

/** 发布者验收 org 工单并结算入金库。 */
export function useOrgBidAccept(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string; platformPct?: number }) =>
      apiFetch<{ assignment: OrgTaskAssignment; settlement: { orgAmountMinor: number } | null; walletBalance: number }>(`/api/v1/workforce/orgs/${orgKey(orgId)}/bids/accept`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidateBids(qc, orgId),
  });
}
