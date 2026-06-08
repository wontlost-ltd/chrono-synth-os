import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

interface PlanLimits {
  maxSimulations: number;
  maxPaths: number;
  llmTokensPerMonth: number;
}

export interface Plan {
  id: string;
  name: string;
  stripePriceId: string;
  limits: PlanLimits;
}

export interface AddOn {
  id: string;
  code: string;
  name: string;
  description: string;
  resource: string;
  quotaAmount: number;
  isActive: boolean;
}

interface UsageData {
  planId: string;
  status: string;
  limits: PlanLimits;
  effectiveLimits?: PlanLimits;
  addOns?: Array<{ addOnId: string; code: string; name: string; resource: string; quotaAmount: number; purchasedAt: number }>;
  usage: Record<string, number>;
  periodEnd?: number;
}

export function usePlans() {
  return useQuery({
    queryKey: ['billing', 'plans'],
    queryFn: ({ signal }) => apiFetch<Plan[]>('/api/v1/billing/plans', { signal }),
  });
}

export function useUsage() {
  return useQuery({
    queryKey: ['billing', 'usage'],
    queryFn: ({ signal }) => apiFetch<UsageData>('/api/v1/billing/usage', { signal }),
    refetchInterval: 60_000,
  });
}

export function useCreateCheckout() {
  return useMutation({
    mutationFn: (body: { priceId: string; successUrl: string; cancelUrl: string }) =>
      apiFetch<{ sessionId: string; url: string }>('/api/v1/billing/checkout', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useCustomerPortal() {
  return useMutation({
    mutationFn: (body: { returnUrl: string }) =>
      apiFetch<{ url: string }>('/api/v1/billing/portal', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useAddOns() {
  return useQuery({
    queryKey: ['billing', 'addOns'],
    queryFn: ({ signal }) => apiFetch<AddOn[]>('/api/v1/billing/add-ons', { signal }),
  });
}

export function usePurchaseAddOn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (addOnId: string) =>
      apiFetch<{ purchased: boolean; addOnId: string }>(`/api/v1/billing/add-ons/${encodeURIComponent(addOnId)}/purchase`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'usage'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'addOns'] });
    },
  });
}
