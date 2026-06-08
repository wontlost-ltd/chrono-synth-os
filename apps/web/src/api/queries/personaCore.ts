import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export type PersonaCoreStatus = 'active' | 'restricted' | 'deceased' | 'transferred';
export type PersonaVisibility = 'private' | 'shared' | 'marketplace';
export type PersonaForkType = 'experimental' | 'task' | 'social' | 'research' | 'operations';
export type MarketplaceTaskStatus = 'open' | 'accepted' | 'completed' | 'cancelled';
export type MarketplaceTaskCategory = 'writing' | 'coding' | 'research' | 'operations' | 'general';

export interface PersonaWallet {
  id: string;
  tenantId: string;
  personaId: string;
  walletAddress: string;
  balance: number;
  tokenBalance: number;
  lastSettledAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PersonaFork {
  id: string;
  tenantId: string;
  personaId: string;
  label: string;
  forkType: PersonaForkType;
  status: 'active' | 'recycled' | 'archived';
  syncMode: 'core' | 'isolated';
  experienceFactor: number;
  createdAt: string | null;
  updatedAt: string | null;
  recycledAt: string | null;
}

export interface PersonaMemory {
  id: string;
  tenantId: string;
  personaId: string;
  forkId: string | null;
  kind: 'interaction' | 'task' | 'training' | 'knowledge' | 'governance';
  summary: string;
  content: Record<string, unknown>;
  importance: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PersonaKnowledgeItem {
  id: string;
  tenantId: string;
  personaId: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  confidence: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PersonaGrowthEvent {
  id: string;
  tenantId: string;
  personaId: string;
  taskId: string | null;
  eventType: 'task_completed' | 'training' | 'knowledge_sync' | 'governance';
  growthDelta: number;
  reputationDelta: number;
  trainingDelta: number;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface PersonaGovernanceEvent {
  id: string;
  tenantId: string;
  personaId: string;
  eventType: 'warning' | 'reward' | 'restriction' | 'review' | 'transfer' | 'death';
  severity: number;
  summary: string;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  createdAt: string | null;
}

export interface MarketplaceTask {
  id: string;
  tenantId: string;
  publisherUserId: string;
  assigneePersonaId: string | null;
  assigneeForkId: string | null;
  assigneePersonaName: string | null;
  title: string;
  description: string;
  category: MarketplaceTaskCategory;
  reward: number;
  currency: string;
  status: MarketplaceTaskStatus;
  qualityScore: number | null;
  growthDelta: number | null;
  publishedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PersonaCoreSummary {
  id: string;
  tenantId: string;
  ownerUserId: string;
  displayName: string;
  profile: Record<string, unknown>;
  status: PersonaCoreStatus;
  visibility: PersonaVisibility;
  growthIndex: number;
  reputation: number;
  trainingInvestment: number;
  createdAt: string | null;
  updatedAt: string | null;
  deceasedAt: string | null;
  transferredAt: string | null;
  wallet: PersonaWallet;
  stats: {
    activeForks: number;
    memoryCount: number;
    knowledgeCount: number;
    activeTaskCount: number;
  };
}

export interface PersonaCoreDetail extends PersonaCoreSummary {
  forks: PersonaFork[];
  recentMemories: PersonaMemory[];
  knowledgeItems: PersonaKnowledgeItem[];
  growthEvents: PersonaGrowthEvent[];
  governanceEvents: PersonaGovernanceEvent[];
  marketplaceTasks: MarketplaceTask[];
}

function invalidatePersonaCoreQueries(qc: ReturnType<typeof useQueryClient>, personaId?: string) {
  qc.invalidateQueries({ queryKey: ['persona-core'] });
  if (personaId) qc.invalidateQueries({ queryKey: ['persona-core', personaId] });
  qc.invalidateQueries({ queryKey: ['marketplace-tasks'] });
}

export function usePersonaCoreList() {
  return useQuery({
    queryKey: ['persona-core'],
    queryFn: ({ signal }) => apiFetch<PersonaCoreSummary[]>('/api/v1/persona-core', { signal }),
  });
}

export function usePersonaCore(id: string) {
  return useQuery({
    queryKey: ['persona-core', id],
    queryFn: ({ signal }) => apiFetch<PersonaCoreDetail>(`/api/v1/persona-core/${encodeURIComponent(id)}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useCreatePersonaCore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      displayName: string;
      visibility: PersonaVisibility;
      profile?: Record<string, unknown>;
      initialKnowledge?: Array<{ title: string; content: string; source?: string; tags?: string[]; confidence?: number }>;
    }) => apiFetch<PersonaCoreDetail>('/api/v1/persona-core', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: (data) => invalidatePersonaCoreQueries(qc, data.id),
  });
}

export function useForkPersonaCore(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      label: string;
      forkType?: PersonaForkType;
      syncMode?: 'core' | 'isolated';
      experienceFactor?: number;
    }) => apiFetch<PersonaCoreDetail>(`/api/v1/persona-core/${encodeURIComponent(id)}/forks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => invalidatePersonaCoreQueries(qc, id),
  });
}

export function useAddPersonaKnowledge(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title: string;
      content: string;
      source?: string;
      tags?: string[];
      confidence?: number;
    }) => apiFetch<PersonaCoreDetail>(`/api/v1/persona-core/${encodeURIComponent(id)}/knowledge`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => invalidatePersonaCoreQueries(qc, id),
  });
}

export function useDeceasePersona(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reason: string }) => apiFetch<PersonaCoreDetail>(`/api/v1/persona-core/${encodeURIComponent(id)}/decease`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => invalidatePersonaCoreQueries(qc, id),
  });
}
