import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

/* 数字员工组织协作域（B1 线程 / B2 交接 / B3 升级 / M7 战略）——admin-gated，per-org（部分 per-task）。
 * 响应均单键 {data} 信封 → apiFetch<T> 已自动解包。数字时间戳（number ms）。 */

const orgKey = (orgId: string) => encodeURIComponent(orgId);
const base = (orgId: string) => `/api/v1/workforce/orgs/${orgKey(orgId)}`;

/* ── 实体类型（源 src/workforce/types.ts）── */

export interface OrgEscalation {
  id: string; tenantId: string; orgId: string; taskId: string;
  fromWorkerId: string; toWorkerId: string;
  parentEscalationId: string | null; depth: number;
  status: 'pending' | 'resolved' | 'reescalated' | 'cancelled';
  reason: string; resolution: string | null; correlationId: string | null;
  createdAt: number; decidedAt: number | null;
}

export interface OrgHandoff {
  id: string; tenantId: string; orgId: string; taskId: string;
  fromWorkerId: string; toWorkerId: string; reason: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'cancelled';
  createdAt: number; respondedAt: number | null;
}

export type ThreadType = 'delegation' | 'report' | 'handoff' | 'coordination';

export interface OrgConversationThread {
  id: string; tenantId: string; orgId: string; threadType: ThreadType;
  goalId: string | null; taskId: string | null; createdByWorkerId: string;
  status: 'open' | 'closed'; createdAt: number; updatedAt: number;
}

export type MessageType = 'request' | 'response' | 'report' | 'note' | 'escalation';

export interface OrgMessage {
  id: string; tenantId: string; orgId: string; threadId: string;
  fromWorkerId: string; toWorkerId: string | null;
  messageType: MessageType; content: string; correlationId: string | null; createdAt: number;
}

/* 战略辅助（M7，零-LLM 确定性，恒需人类批准）。 */
export interface StrategicInitiative {
  id: string; title: string; goalType: string;
  priority: number; impact: number; feasibility: number;
  riskLevel: 'low' | 'medium' | 'high'; estimatedCost: number;
}
export interface RankedInitiative {
  initiative: StrategicInitiative; score: number; included: boolean; needsEscalation: boolean;
}
export interface StrategyAlternative {
  lens: 'impact_first' | 'risk_averse' | 'quick_wins';
  rationale: string; totalCost: number; includedCount: number; escalationCount: number;
  rankedInitiatives: RankedInitiative[];
}
export interface StrategyAdvisory {
  objective: string; requiresHumanApproval: true; alternatives: StrategyAlternative[];
}

/* ── B3 升级 escalations（per-task）── */

export function useEscalations(orgId: string, taskId: string) {
  return useQuery({
    queryKey: ['collab', 'escalations', orgId, taskId],
    queryFn: ({ signal }) => apiFetch<OrgEscalation[]>(`${base(orgId)}/tasks/${encodeURIComponent(taskId)}/escalations`, { signal }),
    enabled: !!orgId && !!taskId,
  });
}
export function useRaiseEscalation(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string; fromWorkerId: string; reason: string; correlationId?: string }) =>
      apiFetch<OrgEscalation>(`${base(orgId)}/escalations/raise`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['collab', 'escalations', orgId, v.taskId] }),
  });
}
export function useResolveEscalation(orgId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ escalationId, resolvingWorkerId, resolution }: { escalationId: string; resolvingWorkerId: string; resolution: string }) =>
      apiFetch<{ resolved: true }>(`${base(orgId)}/escalations/${encodeURIComponent(escalationId)}/resolve`, { method: 'POST', body: JSON.stringify({ resolvingWorkerId, resolution }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collab', 'escalations', orgId, taskId] }),
  });
}
export function useReescalate(orgId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ escalationId, byWorkerId, reason }: { escalationId: string; byWorkerId: string; reason: string }) =>
      apiFetch<OrgEscalation>(`${base(orgId)}/escalations/${encodeURIComponent(escalationId)}/reescalate`, { method: 'POST', body: JSON.stringify({ byWorkerId, reason }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collab', 'escalations', orgId, taskId] }),
  });
}
export function useCancelEscalation(orgId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ escalationId, byWorkerId }: { escalationId: string; byWorkerId: string }) =>
      apiFetch<{ cancelled: true }>(`${base(orgId)}/escalations/${encodeURIComponent(escalationId)}/cancel`, { method: 'POST', body: JSON.stringify({ byWorkerId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collab', 'escalations', orgId, taskId] }),
  });
}

/* ── B2 交接 handoffs（per-task）── */

export function useHandoffs(orgId: string, taskId: string) {
  return useQuery({
    queryKey: ['collab', 'handoffs', orgId, taskId],
    queryFn: ({ signal }) => apiFetch<OrgHandoff[]>(`${base(orgId)}/tasks/${encodeURIComponent(taskId)}/handoffs`, { signal }),
    enabled: !!orgId && !!taskId,
  });
}
export function useProposeHandoff(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string; fromWorkerId: string; toWorkerId: string; reason?: string }) =>
      apiFetch<OrgHandoff>(`${base(orgId)}/handoffs/propose`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['collab', 'handoffs', orgId, v.taskId] }),
  });
}
function handoffRespond(orgId: string, taskId: string, action: 'accept' | 'reject' | 'cancel') {
  return (qc: ReturnType<typeof useQueryClient>) => ({
    mutationFn: ({ handoffId, byWorkerId }: { handoffId: string; byWorkerId: string }) =>
      apiFetch<Record<string, true>>(`${base(orgId)}/handoffs/${encodeURIComponent(handoffId)}/${action}`, { method: 'POST', body: JSON.stringify({ byWorkerId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collab', 'handoffs', orgId, taskId] }),
  });
}
export function useAcceptHandoff(orgId: string, taskId: string) { const qc = useQueryClient(); return useMutation(handoffRespond(orgId, taskId, 'accept')(qc)); }
export function useRejectHandoff(orgId: string, taskId: string) { const qc = useQueryClient(); return useMutation(handoffRespond(orgId, taskId, 'reject')(qc)); }
export function useCancelHandoff(orgId: string, taskId: string) { const qc = useQueryClient(); return useMutation(handoffRespond(orgId, taskId, 'cancel')(qc)); }

/* ── B1 讨论线程 threads（org 级）── */

export function useThreads(orgId: string) {
  return useQuery({
    queryKey: ['collab', 'threads', orgId],
    queryFn: ({ signal }) => apiFetch<OrgConversationThread[]>(`${base(orgId)}/threads`, { signal }),
    enabled: !!orgId,
  });
}
export function useThreadMessages(orgId: string, threadId: string) {
  return useQuery({
    queryKey: ['collab', 'messages', orgId, threadId],
    queryFn: ({ signal }) => apiFetch<OrgMessage[]>(`${base(orgId)}/threads/${encodeURIComponent(threadId)}/messages`, { signal }),
    enabled: !!orgId && !!threadId,
  });
}
export function useCreateThread(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { threadType: ThreadType; createdByWorkerId: string; goalId?: string; taskId?: string }) =>
      apiFetch<OrgConversationThread>(`${base(orgId)}/threads`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collab', 'threads', orgId] }),
  });
}
export function usePostMessage(orgId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fromWorkerId: string; toWorkerId?: string; messageType: MessageType; content: string; correlationId?: string }) =>
      apiFetch<OrgMessage>(`${base(orgId)}/threads/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collab', 'messages', orgId, threadId] }),
  });
}
export function useCloseThread(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      apiFetch<{ closed: true }>(`${base(orgId)}/threads/${encodeURIComponent(threadId)}/close`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collab', 'threads', orgId] }),
  });
}

/* ── M7 战略辅助（org 级，纯计算，恒需人类批准）── */

export interface StrategyAdviseRequest {
  objective: string; budgetCap: number; riskTolerance: 'low' | 'medium' | 'high';
  initiatives: StrategicInitiative[];
}
export function useStrategyAdvise(orgId: string) {
  return useMutation({
    mutationFn: (body: StrategyAdviseRequest) =>
      apiFetch<StrategyAdvisory>(`${base(orgId)}/strategy/advise`, { method: 'POST', body: JSON.stringify(body) }),
  });
}
