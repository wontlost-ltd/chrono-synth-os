import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export type OrganizationRole =
  | 'org_admin'
  | 'billing_admin'
  | 'persona_operator'
  | 'marketplace_manager'
  | 'auditor'
  | 'viewer';

export interface OrganizationSummary {
  organizationId: string;
  tenantId: string;
  name: string;
  slug: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  defaultWorkspace: {
    workspaceId: string;
    organizationId: string;
    name: string;
    slug: string;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export interface OrganizationMember {
  membershipId: string;
  userId: string;
  email: string;
  status: string;
  roles: OrganizationRole[];
  bindings: Array<{
    role: OrganizationRole;
    workspaceId: string | null;
    workspaceName: string | null;
  }>;
  joinedAt: string;
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  defaultWorkspaceName?: string;
  defaultWorkspaceSlug?: string;
}

export interface UpsertOrganizationMemberInput {
  userId?: string;
  email?: string;
  workspaceId?: string;
  roles: OrganizationRole[];
}

export interface DeploymentProfile {
  tenantId: string;
  deploymentMode: 'shared_cluster' | 'dedicated_db';
  databaseIsolationMode: 'shared' | 'dedicated';
  kafkaNamespace: string | null;
  encryptionMode: 'platform_managed' | 'tenant_dedicated';
  kmsKeyRef: string | null;
  scimTokenConfigured: boolean;
  oidc: {
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecretConfigured: boolean;
    audience: string;
    scope: string;
    emailClaim: string;
    nameClaim: string;
  };
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UpdateDeploymentProfileInput {
  deploymentMode: 'shared_cluster' | 'dedicated_db';
  databaseIsolationMode: 'shared' | 'dedicated';
  kafkaNamespace: string | null;
  encryptionMode: 'platform_managed' | 'tenant_dedicated';
  kmsKeyRef: string | null;
  oidc: {
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecret?: string;
    audience: string;
    scope: string;
    emailClaim: string;
    nameClaim: string;
  };
}

export interface ScimTokenResult {
  token: string;
  tenantId: string;
  issuedAt: string;
}

interface Pagination {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminPersonasResponse {
  data: Array<{
    personaId: string;
    ownerUserId: string;
    ownerEmail: string | null;
    displayName: string;
    status: string;
    visibility: string;
    growthIndex: number;
    reputation: number;
    walletId: string | null;
    walletBalance: number | null;
    walletTokenBalance: number | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  pagination: Pagination;
  summary: {
    total: number;
    active: number;
    restricted: number;
    deceased: number;
  };
}

export interface AdminTasksResponse {
  data: Array<{
    taskId: string;
    publisherUserId: string;
    publisherEmail: string | null;
    assigneePersonaId: string | null;
    title: string;
    category: string;
    reward: number;
    status: string;
    qualityScore: number | null;
    createdAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
  }>;
  pagination: Pagination;
  summary: {
    total: number;
    open: number;
    accepted: number;
    completed: number;
    disputed: number;
  };
}

export interface AdminWalletsResponse {
  data: Array<{
    walletId: string;
    personaId: string;
    displayName: string | null;
    balance: number;
    tokenBalance: number;
    currency: string;
    status: string;
    lastSettledAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  pagination: Pagination;
  summary: {
    total: number;
    active: number;
    totalBalance: number;
    totalTokenBalance: number;
  };
}

export interface AdminGovernanceResponse {
  data: Array<{
    caseId: string;
    personaId: string;
    displayName: string | null;
    taskId: string | null;
    triggerType: string;
    severity: string;
    status: string;
    openedAt: string | null;
    resolvedAt: string | null;
    appealedAt: string | null;
  }>;
  pagination: Pagination;
  summary: {
    total: number;
    open: number;
    actionApplied: number;
    appealed: number;
    resolved: number;
  };
}

export interface AuditLogsResponse {
  data: Array<{
    id: string;
    tenantId: string;
    eventKind: 'request' | 'business';
    timestamp: number;
    createdAt: number;
    method: string;
    path: string;
    requestId: string;
    statusCode: number;
    latencyMs: number;
    apiKeyHash: string | null;
    userId: string | null;
    userEmail: string | null;
    actorType: 'user' | 'api_key' | 'system' | null;
    actorId: string | null;
    actionType: string;
    targetType: string | null;
    targetId: string | null;
    payload: Record<string, unknown> | null;
  }>;
  pagination: Pagination;
}

const ENTERPRISE_KEYS = {
  organizations: ['enterprise', 'organizations'] as const,
  deployment: ['enterprise', 'deployment'] as const,
  audit: ['enterprise', 'audit'] as const,
};

function adminListParams(page: number, status?: string) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: '5',
  });
  if (status) params.set('status', status);
  return params.toString();
}

export function useOrganizations(enabled = true) {
  return useQuery({
    queryKey: ENTERPRISE_KEYS.organizations,
    queryFn: ({ signal }) => apiFetch<OrganizationSummary[]>('/api/v1/organizations', { signal }),
    enabled,
  });
}

export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateOrganizationInput) => apiFetch<{
      organization: OrganizationSummary;
      membership: OrganizationMember | null;
    }>('/api/v1/organizations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ENTERPRISE_KEYS.organizations });
    },
  });
}

export function useOrganizationMembers(organizationId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['enterprise', 'organizations', organizationId, 'members'],
    queryFn: ({ signal }) => apiFetch<OrganizationMember[]>(
      `/api/v1/organizations/${encodeURIComponent(organizationId!)}/members`,
      { signal },
    ),
    enabled: enabled && !!organizationId,
  });
}

export function useUpsertOrganizationMember(organizationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertOrganizationMemberInput) => apiFetch<{
      organizationId: string;
      members: OrganizationMember[];
    }>(`/api/v1/organizations/${encodeURIComponent(organizationId!)}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      if (organizationId) {
        void qc.invalidateQueries({ queryKey: ['enterprise', 'organizations', organizationId, 'members'] });
      }
      void qc.invalidateQueries({ queryKey: ENTERPRISE_KEYS.organizations });
    },
  });
}

export function useAdminDeploymentProfile(enabled = true) {
  return useQuery({
    queryKey: ENTERPRISE_KEYS.deployment,
    queryFn: ({ signal }) => apiFetch<DeploymentProfile>('/api/v1/admin/deployment/profile', { signal }),
    enabled,
  });
}

export function useUpdateAdminDeploymentProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateDeploymentProfileInput) => apiFetch<DeploymentProfile>('/api/v1/admin/deployment/profile', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ENTERPRISE_KEYS.deployment });
    },
  });
}

export function useGenerateScimToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ScimTokenResult>('/api/v1/admin/deployment/scim-token', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ENTERPRISE_KEYS.deployment });
    },
  });
}

export function useAdminPersonas(page = 1, status?: string, enabled = true) {
  return useQuery({
    queryKey: ['enterprise', 'admin', 'personas', page, status ?? 'all'],
    queryFn: ({ signal }) => apiFetch<AdminPersonasResponse>(`/api/v1/admin/personas?${adminListParams(page, status)}`, { signal }),
    enabled,
  });
}

export function useAdminTasks(page = 1, status?: string, enabled = true) {
  return useQuery({
    queryKey: ['enterprise', 'admin', 'tasks', page, status ?? 'all'],
    queryFn: ({ signal }) => apiFetch<AdminTasksResponse>(`/api/v1/admin/tasks?${adminListParams(page, status)}`, { signal }),
    enabled,
  });
}

export function useAdminWallets(page = 1, status?: string, enabled = true) {
  return useQuery({
    queryKey: ['enterprise', 'admin', 'wallets', page, status ?? 'all'],
    queryFn: ({ signal }) => apiFetch<AdminWalletsResponse>(`/api/v1/admin/wallets?${adminListParams(page, status)}`, { signal }),
    enabled,
  });
}

export function useAdminGovernance(page = 1, status?: string, enabled = true) {
  return useQuery({
    queryKey: ['enterprise', 'admin', 'governance', page, status ?? 'all'],
    queryFn: ({ signal }) => apiFetch<AdminGovernanceResponse>(`/api/v1/admin/governance?${adminListParams(page, status)}`, { signal }),
    enabled,
  });
}

export function useAuditLogs(page = 1, enabled = true) {
  return useQuery({
    queryKey: [...ENTERPRISE_KEYS.audit, page],
    queryFn: ({ signal }) => apiFetch<AuditLogsResponse>(`/api/v1/audit/logs?eventKind=business&page=${page}&pageSize=20`, { signal }),
    enabled,
  });
}

// ─── Vault Key Management ─────────────────────────────────────────────────────

export interface VaultKeyVersion {
  keyRef: string;
  provider: string;
  version: number;
  status: 'active' | 'revoked';
  createdAt: string | null;
  revokedAt: string | null;
}

export interface VaultAuditEntry {
  id: string;
  operation: 'wrap' | 'unwrap' | 'sign' | 'verify';
  keyRef: string;
  keyVersion: number | null;
  outcome: 'ok' | 'error';
  errorMessage: string | null;
  performedAt: string | null;
}

const VAULT_KEYS = {
  keys: ['enterprise', 'vault', 'keys'] as const,
  audit: ['enterprise', 'vault', 'audit'] as const,
};

export function useVaultKeys(enabled = true) {
  return useQuery({
    queryKey: VAULT_KEYS.keys,
    queryFn: ({ signal }) => apiFetch<VaultKeyVersion[]>('/api/v1/admin/vault/keys', { signal }),
    enabled,
  });
}

export function useVaultAudit(enabled = true) {
  return useQuery({
    queryKey: VAULT_KEYS.audit,
    queryFn: ({ signal }) => apiFetch<VaultAuditEntry[]>('/api/v1/admin/vault/audit', { signal }),
    enabled,
  });
}

export function useRotateVaultKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyRef: string) => apiFetch<{ keyRef: string; version: number; status: string; createdAt: string | null }>(
      `/api/v1/admin/vault/keys/${encodeURIComponent(keyRef)}/rotate`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: VAULT_KEYS.keys });
      void qc.invalidateQueries({ queryKey: VAULT_KEYS.audit });
    },
  });
}

export function useRevokeVaultKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyRef: string) => apiFetch<{ keyRef: string; revokedCount: number }>(
      `/api/v1/admin/vault/keys/${encodeURIComponent(keyRef)}/revoke`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: VAULT_KEYS.keys });
      void qc.invalidateQueries({ queryKey: VAULT_KEYS.audit });
    },
  });
}
