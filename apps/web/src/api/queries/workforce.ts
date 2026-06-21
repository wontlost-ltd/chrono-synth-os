/**
 * 数字员工组织只读查询（E2 治理控制台数据源）。
 *
 * 对接后端 E1/C0/C2 只读端点（/api/v1/workforce/*）：组织图、目标、worker 运行信号、人格信号束。
 * 全部只读（不发起委派/执行）。
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface GoalTypeInfo {
  goalType: string;
  qualityRubric: Array<{ dimension: string; description: string }>;
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
