/**
 * Onboarding v2 — agent governance 引导（W2.1）
 *
 * 与老 useOnboardingStatus / useCompleteOnboarding 并存，新签用户走 v2。
 * 后端契约：src/server/routes/onboarding-v2.ts
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export type OnboardingV2Step = 1 | 2 | 3 | 4 | 5;

export interface OnboardingV2Session {
  id: string;
  tenantId: string;
  userId: string;
  currentStep: OnboardingV2Step;
  organizationId: string | null;
  agentId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  expiresAt: number;
  resumed: boolean;
}

interface StatusResponse {
  onboarded: boolean;
  session: OnboardingV2Session | null;
}

const STATUS_KEY = ['onboarding', 'v2', 'status'] as const;

export function useOnboardingV2Status() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) =>
      apiFetch<StatusResponse>('/api/v1/onboarding/v2/status', { signal }),
    /* 引导状态本应靠 mutation 主动失效；这里给个保底 5min 刷新 */
    staleTime: 5 * 60 * 1000,
  });
}

export function useStartOnboardingV2() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<OnboardingV2Session>('/api/v1/onboarding/v2/start', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}

export function useSubmitOrganizationStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; organizationName: string }) =>
      apiFetch<{ session: OnboardingV2Session; organizationId: string }>(
        '/api/v1/onboarding/v2/organization',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}

export interface OnboardingAgentInput {
  sessionId: string;
  agentName: string;
  llmProvider?: 'openai' | 'anthropic' | null;
  llmApiKey?: string | null;
}

export function useSubmitAgentStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OnboardingAgentInput) =>
      apiFetch<{ session: OnboardingV2Session; agentId: string }>(
        '/api/v1/onboarding/v2/agent',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}

export interface OnboardingPolicyEntry {
  toolId: string;
  scope: 'read' | 'write' | 'execute';
  decision: 'allow' | 'deny' | 'confirm';
}

export function useSubmitPolicyStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; agentId: string; policies: OnboardingPolicyEntry[] }) =>
      apiFetch<{ session: OnboardingV2Session; policyCount: number }>(
        '/api/v1/onboarding/v2/policy',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}

export function useFireSyntheticInvocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; agentId: string }) =>
      apiFetch<{ session: OnboardingV2Session; invocationIds: string[] }>(
        '/api/v1/onboarding/v2/synthetic-invocation',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}

export function useCompleteOnboardingV2() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string }) =>
      apiFetch<{ session: OnboardingV2Session; completedAt: number | null }>(
        '/api/v1/onboarding/v2/complete',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}

export function useSkipOnboardingV2() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; currentStep: number }) =>
      apiFetch<{ session: OnboardingV2Session; skippedAtStep: number }>(
        '/api/v1/onboarding/v2/skip',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}
