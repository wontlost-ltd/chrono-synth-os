import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

/* 决策模拟域——建决策 case → 蒙特卡洛模拟 → 看排序结果 → 反馈校准。租户级（无 personaId）。
 * ⚠️ list 是多键 {data,pagination} 富信封（apiFetch 原样返回，读 .data/.pagination）；其余单键 {data} 自动解包。 */

export interface DecisionCase {
  id: string;
  title: string;
  description: string;
  alternatives?: string[];
  constraints?: string[];
  context?: Record<string, unknown>;
  createdAt?: string;
}

export interface RankedOption {
  alternative: string;
  rank: number;
  alignmentScore: number;
  riskScore: number;
  confidence: number;
  overallScore: number;
  regretProbability: number;
  explanation?: unknown;
}

export interface DecisionResult {
  caseId: string;
  recommendedAlternative: string;
  rankedOptions: RankedOption[];
  simulatedAt: number;
}

export interface DecisionListEnvelope {
  data: DecisionCase[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface CreateDecisionInput {
  title: string;
  description: string;
  alternatives?: string[];
  constraints?: string[];
  context?: Record<string, unknown>;
}

export interface DecisionFeedbackInput {
  runId: string;
  selectedAlternative: string;
  satisfaction: number;
  notes?: string;
}

/** 决策列表（分页，多键信封 → 原样返回读 .data/.pagination）。 */
export function useDecisions(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ['decisions', page, pageSize],
    queryFn: ({ signal }) => apiFetch<DecisionListEnvelope>(`/api/v1/decisions?page=${page}&pageSize=${pageSize}`, { signal }),
  });
}

export function useCreateDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDecisionInput) =>
      apiFetch<DecisionCase>('/api/v1/decisions', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['decisions'] }),
  });
}

/** 跑蒙特卡洛模拟（限流 10/min，扣 simulation 配额）。返回 runId + result。 */
export function useSimulateDecision(decisionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ runId: string; result: DecisionResult }>(`/api/v1/decisions/${encodeURIComponent(decisionId)}/simulate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['decisions', 'run', decisionId] }),
  });
}

/** 取某次模拟结果。 */
export function useDecisionRun(decisionId: string, runId: string) {
  return useQuery({
    queryKey: ['decisions', 'run', decisionId, runId],
    queryFn: ({ signal }) => apiFetch<{ runId: string; result: DecisionResult }>(`/api/v1/decisions/${encodeURIComponent(decisionId)}/runs/${encodeURIComponent(runId)}`, { signal }),
    enabled: !!decisionId && !!runId,
  });
}

/** 提交决策反馈（校准）。 */
export function useDecisionFeedback(decisionId: string) {
  return useMutation({
    mutationFn: (body: DecisionFeedbackInput) =>
      apiFetch<{ feedbackId: string; runId: string; stored: boolean }>(`/api/v1/decisions/${encodeURIComponent(decisionId)}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  });
}
