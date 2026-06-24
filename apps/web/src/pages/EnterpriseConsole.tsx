import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Tabs } from '../components/ui/Tabs';
import { DataTable, type Column } from '../components/ui/DataTable';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../hooks/useAuth';
import {
  useAdminDeploymentProfile,
  useAdminGovernance,
  useAdminPersonas,
  useAdminTasks,
  useAdminWallets,
  useAuditLogs,
  useCreateOrganization,
  useGenerateScimToken,
  useOrganizationMembers,
  useOrganizations,
  useRotateVaultKey,
  useRevokeVaultKey,
  useUpdateAdminDeploymentProfile,
  useUpsertOrganizationMember,
  useVaultAudit,
  useVaultKeys,
  type AdminGovernanceResponse,
  type AdminPersonasResponse,
  type AdminTasksResponse,
  type AdminWalletsResponse,
  type AuditLogsResponse,
  type CreateOrganizationInput,
  type DeploymentProfile,
  type OrganizationMember,
  type OrganizationRole,
  type OrganizationSummary,
  type UpdateDeploymentProfileInput,
  type VaultAuditEntry,
  type VaultKeyVersion,
} from '../api/queries/enterprise';

const ORG_ROLE_OPTIONS: OrganizationRole[] = [
  'org_admin',
  'billing_admin',
  'persona_operator',
  'marketplace_manager',
  'auditor',
  'viewer',
];

const DEFAULT_DEPLOYMENT_FORM: UpdateDeploymentProfileInput = {
  deploymentMode: 'shared_cluster',
  databaseIsolationMode: 'shared',
  kafkaNamespace: null,
  encryptionMode: 'platform_managed',
  kmsKeyRef: null,
  oidc: {
    enabled: false,
    issuerUrl: '',
    clientId: '',
    audience: '',
    scope: 'openid profile email',
    emailClaim: 'email',
    nameClaim: 'name',
  },
};

const DEFAULT_ORGANIZATION_FORM: CreateOrganizationInput = {
  name: '',
  slug: '',
  defaultWorkspaceName: 'Default Workspace',
  defaultWorkspaceSlug: '',
};

function toNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function MetricTile({
  label,
  value,
  hint,
  accent = 'cyan',
  trend,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: 'cyan' | 'indigo' | 'violet' | 'amber';
  trend?: number; // signed percent delta (-100..100)
}) {
  const accentColor = {
    cyan:   { from: '#22D3EE', to: '#67E8F9', dot: '#22D3EE' },
    indigo: { from: '#6366F1', to: '#818CF8', dot: '#6366F1' },
    violet: { from: '#A855F7', to: '#C084FC', dot: '#A855F7' },
    amber:  { from: '#F59E0B', to: '#FBBF24', dot: '#F59E0B' },
  }[accent];

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface-elevated p-4">
      {/* left accent rail */}
      <div
        aria-hidden="true"
        className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r"
        style={{ background: `linear-gradient(180deg, ${accentColor.from}, ${accentColor.to})` }}
      />
      <div className="pl-2">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-text-secondary">{label}</p>
        <div className="mt-2 flex items-baseline gap-2">
          <p className="text-2xl font-bold text-text-primary tabular-nums">{value}</p>
          {typeof trend === 'number' && (
            <span
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums"
              style={{
                background: trend >= 0 ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                color: trend >= 0 ? '#22C55E' : '#F87171',
              }}
            >
              {trend >= 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}%
            </span>
          )}
        </div>
        {hint && <p className="mt-1.5 text-xs text-text-tertiary">{hint}</p>}
      </div>
    </div>
  );
}

function SectionCard({ title, subtitle, children, actions }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface-elevated p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function InlineMessage({ tone, message }: { tone: 'success' | 'error'; message: string | null }) {
  if (!message) return null;
  return (
    <p className={`rounded-lg border px-3 py-2 text-sm ${
      tone === 'success'
        ? 'border-success/30 bg-success/5 text-success'
        : 'border-warning/30 bg-warning/5 text-warning'
    }`}>
      {message}
    </p>
  );
}

function applyProfileToForm(profile: DeploymentProfile): UpdateDeploymentProfileInput {
  return {
    deploymentMode: profile.deploymentMode,
    databaseIsolationMode: profile.databaseIsolationMode,
    kafkaNamespace: profile.kafkaNamespace,
    encryptionMode: profile.encryptionMode,
    kmsKeyRef: profile.kmsKeyRef,
    oidc: {
      enabled: profile.oidc.enabled,
      issuerUrl: profile.oidc.issuerUrl,
      clientId: profile.oidc.clientId,
      audience: profile.oidc.audience,
      scope: profile.oidc.scope,
      emailClaim: profile.oidc.emailClaim,
      nameClaim: profile.oidc.nameClaim,
    },
  };
}

export function EnterpriseConsole() {
  const { t } = useTranslation();
  useDocumentTitle(t('enterpriseConsole.title'));
  const { role, tenantId } = useAuth();
  const isAdmin = role === 'admin';

  const [activeTab, setActiveTab] = useState('deployment');
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const [deploymentForm, setDeploymentForm] = useState<UpdateDeploymentProfileInput>(DEFAULT_DEPLOYMENT_FORM);
  const [deploymentSuccess, setDeploymentSuccess] = useState<string | null>(null);
  const [organizationSuccess, setOrganizationSuccess] = useState<string | null>(null);
  const [generatedScimToken, setGeneratedScimToken] = useState<string | null>(null);
  const [organizationForm, setOrganizationForm] = useState<CreateOrganizationInput>(DEFAULT_ORGANIZATION_FORM);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRoles, setMemberRoles] = useState<OrganizationRole[]>(['viewer']);
  const [personaPage, setPersonaPage] = useState(1);
  const [taskPage, setTaskPage] = useState(1);
  const [walletPage, setWalletPage] = useState(1);
  const [governancePage, setGovernancePage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);

  const organizations = useOrganizations(isAdmin);
  const organizationMembers = useOrganizationMembers(selectedOrganizationId, isAdmin);
  const createOrganization = useCreateOrganization();
  const upsertOrganizationMember = useUpsertOrganizationMember(selectedOrganizationId);

  const deploymentProfile = useAdminDeploymentProfile(isAdmin);
  const updateDeploymentProfile = useUpdateAdminDeploymentProfile();
  const generateScimToken = useGenerateScimToken();

  const adminPersonas = useAdminPersonas(personaPage, undefined, isAdmin);
  const adminTasks = useAdminTasks(taskPage, undefined, isAdmin);
  const adminWallets = useAdminWallets(walletPage, undefined, isAdmin);
  const adminGovernance = useAdminGovernance(governancePage, undefined, isAdmin);
  const auditLogs = useAuditLogs(auditPage, isAdmin);

  const vaultKeys = useVaultKeys(isAdmin);
  const vaultAudit = useVaultAudit(isAdmin);
  const rotateVaultKey = useRotateVaultKey();
  const revokeVaultKey = useRevokeVaultKey();

  useEffect(() => {
    if (deploymentProfile.data) {
      setDeploymentForm(applyProfileToForm(deploymentProfile.data));
    }
  }, [deploymentProfile.data]);

  useEffect(() => {
    const firstOrganizationId = organizations.data?.[0]?.organizationId ?? null;
    if (!firstOrganizationId) {
      setSelectedOrganizationId(null);
      return;
    }
    if (!selectedOrganizationId || !organizations.data?.some((item) => item.organizationId === selectedOrganizationId)) {
      setSelectedOrganizationId(firstOrganizationId);
    }
  }, [organizations.data, selectedOrganizationId]);

  if (!isAdmin) {
    return <EmptyState variant="error" message={t('enterpriseConsole.requiresAdmin')} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('enterpriseConsole.title')}
        subtitle={t('enterpriseConsole.subtitle')}
        actions={(
          <div className="flex flex-wrap gap-2">
            <a
              href="/worker/healthz"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center min-h-touch rounded-lg border border-border px-3 py-2 text-sm text-text-secondary hover:bg-surface"
            >
              {t('enterpriseConsole.actions.workerHealth')}
            </a>
            <a
              href="/prometheus/targets"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center min-h-touch rounded-lg border border-border px-3 py-2 text-sm text-text-secondary hover:bg-surface"
            >
              {t('enterpriseConsole.actions.prometheus')}
            </a>
            <a
              href="/grafana/d/chrono-synth-overview/chrono-synth-enterprise-overview"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center min-h-touch rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-light"
            >
              {t('enterpriseConsole.actions.grafana')}
            </a>
          </div>
        )}
      />

      <div className="grid gap-4 md:grid-cols-4">
        <MetricTile
          accent="cyan"
          label={t('enterpriseConsole.metrics.tenant')}
          value={tenantId}
          hint={t('enterpriseConsole.metrics.tenantHint')}
        />
        <MetricTile
          accent="indigo"
          label={t('enterpriseConsole.metrics.organizations')}
          value={organizations.data?.length ?? 0}
          hint={selectedOrganizationId
            ? t('enterpriseConsole.metricsActive.activeOrg', { org: selectedOrganizationId })
            : t('enterpriseConsole.metricsActive.createFirstOrg')}
        />
        <MetricTile
          accent="violet"
          label={t('enterpriseConsole.metrics.deploymentMode')}
          value={deploymentProfile.data?.deploymentMode ?? t('enterpriseConsole.fields.deploymentLoading')}
          hint={deploymentProfile.data?.kafkaNamespace ?? t('enterpriseConsole.metrics.deploymentModeHint')}
        />
        <MetricTile
          accent="amber"
          label={t('enterpriseConsole.metrics.auditEvents')}
          value={auditLogs.data?.pagination.total ?? 0}
          hint={t('enterpriseConsole.metrics.auditEventsHint')}
        />
      </div>

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { id: 'deployment', label: t('enterpriseConsole.tabs.deployment') },
          { id: 'organizations', label: t('enterpriseConsole.tabs.organizations') },
          { id: 'control', label: t('enterpriseConsole.tabs.control') },
          { id: 'vault', label: t('enterpriseConsole.tabs.vault') },
          { id: 'audit', label: t('enterpriseConsole.tabs.audit') },
        ]}
        renderPanel={(tabId) => {
          switch (tabId) {
            case 'deployment':
              return (
                <DeploymentPanel
                  profile={deploymentProfile.data}
                  loading={deploymentProfile.isLoading}
                  error={deploymentProfile.error?.message ?? null}
                  form={deploymentForm}
                  successMessage={deploymentSuccess}
                  generatedScimToken={generatedScimToken}
                  saving={updateDeploymentProfile.isPending}
                  scimGenerating={generateScimToken.isPending}
                  saveError={updateDeploymentProfile.error?.message ?? null}
                  scimError={generateScimToken.error?.message ?? null}
                  onChange={setDeploymentForm}
                  onSave={() => {
                    setDeploymentSuccess(null);
                    setGeneratedScimToken(null);
                    updateDeploymentProfile.mutate({
                      deploymentMode: deploymentForm.deploymentMode,
                      databaseIsolationMode: deploymentForm.databaseIsolationMode,
                      kafkaNamespace: toNullable(deploymentForm.kafkaNamespace ?? ''),
                      encryptionMode: deploymentForm.encryptionMode,
                      kmsKeyRef: toNullable(deploymentForm.kmsKeyRef ?? ''),
                      oidc: {
                        enabled: deploymentForm.oidc.enabled,
                        issuerUrl: deploymentForm.oidc.issuerUrl.trim(),
                        clientId: deploymentForm.oidc.clientId.trim(),
                        clientSecret: deploymentForm.oidc.clientSecret?.trim() || undefined,
                        audience: deploymentForm.oidc.audience.trim(),
                        scope: deploymentForm.oidc.scope.trim(),
                        emailClaim: deploymentForm.oidc.emailClaim.trim(),
                        nameClaim: deploymentForm.oidc.nameClaim.trim(),
                      },
                    }, {
                      onSuccess: () => {
                        setDeploymentSuccess(t('enterpriseConsole.success.deploymentSaved'));
                      },
                    });
                  }}
                  onGenerateScim={() => {
                    setGeneratedScimToken(null);
                    generateScimToken.mutate(undefined, {
                      onSuccess: (data) => {
                        setGeneratedScimToken(data.token);
                      },
                    });
                  }}
                />
              );
            case 'organizations':
              return (
                <OrganizationsPanel
                  organizations={organizations.data ?? []}
                  organizationsLoading={organizations.isLoading}
                  organizationsError={organizations.error?.message ?? null}
                  selectedOrganizationId={selectedOrganizationId}
                  organizationForm={organizationForm}
                  memberEmail={memberEmail}
                  memberRoles={memberRoles}
                  members={organizationMembers.data ?? []}
                  membersLoading={organizationMembers.isLoading}
                  membersError={organizationMembers.error?.message ?? null}
                  successMessage={organizationSuccess}
                  createPending={createOrganization.isPending}
                  memberPending={upsertOrganizationMember.isPending}
                  createError={createOrganization.error?.message ?? null}
                  memberError={upsertOrganizationMember.error?.message ?? null}
                  onSelectOrganization={setSelectedOrganizationId}
                  onChangeOrganizationForm={setOrganizationForm}
                  onMemberEmailChange={setMemberEmail}
                  onMemberRolesChange={setMemberRoles}
                  onCreateOrganization={() => {
                    setOrganizationSuccess(null);
                    createOrganization.mutate({
                      name: organizationForm.name.trim(),
                      slug: organizationForm.slug?.trim() || undefined,
                      defaultWorkspaceName: organizationForm.defaultWorkspaceName?.trim() || 'Default Workspace',
                      defaultWorkspaceSlug: organizationForm.defaultWorkspaceSlug?.trim() || undefined,
                    }, {
                      onSuccess: (data) => {
                        setOrganizationSuccess(t('enterpriseConsole.success.organizationCreated', { name: data.organization.name }));
                        setSelectedOrganizationId(data.organization.organizationId);
                        setOrganizationForm(DEFAULT_ORGANIZATION_FORM);
                      },
                    });
                  }}
                  onAddMember={() => {
                    if (!selectedOrganizationId) return;
                    setOrganizationSuccess(null);
                    upsertOrganizationMember.mutate({
                      email: memberEmail.trim(),
                      roles: memberRoles,
                    }, {
                      onSuccess: () => {
                        setOrganizationSuccess(t('enterpriseConsole.success.memberBindingsUpdated'));
                        setMemberEmail('');
                        setMemberRoles(['viewer']);
                      },
                    });
                  }}
                />
              );
            case 'control':
              return (
                <ControlPlanePanel
                  personas={adminPersonas.data}
                  tasks={adminTasks.data}
                  wallets={adminWallets.data}
                  governance={adminGovernance.data}
                  loading={adminPersonas.isLoading || adminTasks.isLoading || adminWallets.isLoading || adminGovernance.isLoading}
                  errors={[
                    adminPersonas.error?.message,
                    adminTasks.error?.message,
                    adminWallets.error?.message,
                    adminGovernance.error?.message,
                  ].filter((item): item is string => Boolean(item))}
                  personaPage={personaPage}
                  taskPage={taskPage}
                  walletPage={walletPage}
                  governancePage={governancePage}
                  onPersonaPageChange={setPersonaPage}
                  onTaskPageChange={setTaskPage}
                  onWalletPageChange={setWalletPage}
                  onGovernancePageChange={setGovernancePage}
                />
              );
            case 'vault':
              return (
                <VaultPanel
                  keys={vaultKeys.data ?? []}
                  auditEntries={vaultAudit.data ?? []}
                  loading={vaultKeys.isLoading}
                  error={vaultKeys.error?.message ?? null}
                  rotating={rotateVaultKey.isPending}
                  revoking={revokeVaultKey.isPending}
                  rotateError={rotateVaultKey.error?.message ?? null}
                  revokeError={revokeVaultKey.error?.message ?? null}
                  onRotate={(keyRef) => rotateVaultKey.mutate(keyRef)}
                  onRevoke={(keyRef) => revokeVaultKey.mutate(keyRef)}
                />
              );
            case 'audit':
              return (
                <AuditPanel
                  audit={auditLogs.data}
                  loading={auditLogs.isLoading}
                  error={auditLogs.error?.message ?? null}
                  page={auditPage}
                  onPageChange={setAuditPage}
                />
              );
            default:
              return null;
          }
        }}
      />
    </div>
  );
}

function DeploymentPanel({
  profile,
  loading,
  error,
  form,
  successMessage,
  generatedScimToken,
  saving,
  scimGenerating,
  saveError,
  scimError,
  onChange,
  onSave,
  onGenerateScim,
}: {
  profile: DeploymentProfile | undefined;
  loading: boolean;
  error: string | null;
  form: UpdateDeploymentProfileInput;
  successMessage: string | null;
  generatedScimToken: string | null;
  saving: boolean;
  scimGenerating: boolean;
  saveError: string | null;
  scimError: string | null;
  onChange: (form: UpdateDeploymentProfileInput) => void;
  onSave: () => void;
  onGenerateScim: () => void;
}) {
  const { t } = useTranslation();
  if (loading) return <Skeleton variant="table" />;
  if (error) return <EmptyState variant="error" message={t('enterpriseConsole.errors.deploymentLoadFailed', { error })} />;

  const oidcLabel = profile?.oidc.enabled
    ? t('enterpriseConsole.fields.oidcOn')
    : t('enterpriseConsole.fields.oidcOff');
  const scimLabel = profile?.scimTokenConfigured
    ? t('enterpriseConsole.fields.scimReady')
    : t('enterpriseConsole.fields.scimMissing');

  return (
    <div className="space-y-6">
      <SectionCard title={t('enterpriseConsole.sections.currentPosture.title')} subtitle={t('enterpriseConsole.sections.currentPosture.subtitle')}>
        <div className="grid gap-4 md:grid-cols-4">
          <MetricTile
            label={t('enterpriseConsole.fields.deployment')}
            value={profile?.deploymentMode ?? '—'}
            hint={t('enterpriseConsole.fields.dbIsolation', { mode: profile?.databaseIsolationMode ?? '—' })}
          />
          <MetricTile
            label={t('enterpriseConsole.fields.kafkaNamespace')}
            value={profile?.kafkaNamespace ?? 'shared'}
            hint={t('enterpriseConsole.fields.kafkaNamespaceHint')}
          />
          <MetricTile
            label={t('enterpriseConsole.fields.encryption')}
            value={profile?.encryptionMode ?? '—'}
            hint={profile?.kmsKeyRef ?? t('enterpriseConsole.fields.encryptionKeyringDefault')}
          />
          <MetricTile
            label={t('enterpriseConsole.fields.ssoScim')}
            value={`${oidcLabel} / ${scimLabel}`}
            hint={t('enterpriseConsole.fields.updatedAt', { when: formatDateTime(profile?.updatedAt) })}
          />
        </div>
      </SectionCard>

      <SectionCard
        title={t('enterpriseConsole.sections.deploymentProfile.title')}
        subtitle={t('enterpriseConsole.sections.deploymentProfile.subtitle')}
        actions={(
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center min-h-touch rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
          >
            {saving ? t('enterpriseConsole.buttons.saving') : t('enterpriseConsole.buttons.saveProfile')}
          </button>
        )}
      >
        <div className="space-y-3">
          <InlineMessage tone="success" message={successMessage} />
          <InlineMessage tone="error" message={saveError} />
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.deploymentMode')}
            <select
              value={form.deploymentMode}
              onChange={(event) => onChange({ ...form, deploymentMode: event.target.value as UpdateDeploymentProfileInput['deploymentMode'] })}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            >
              <option value="shared_cluster">shared_cluster</option>
              <option value="dedicated_db">dedicated_db</option>
            </select>
          </label>
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.databaseIsolation')}
            <select
              value={form.databaseIsolationMode}
              onChange={(event) => onChange({ ...form, databaseIsolationMode: event.target.value as UpdateDeploymentProfileInput['databaseIsolationMode'] })}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            >
              <option value="shared">shared</option>
              <option value="dedicated">dedicated</option>
            </select>
          </label>
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.kafkaNamespace')}
            <input
              value={form.kafkaNamespace ?? ''}
              onChange={(event) => onChange({ ...form, kafkaNamespace: event.target.value })}
              placeholder="tenant-enterprise"
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            />
          </label>
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.encryptionMode')}
            <select
              value={form.encryptionMode}
              onChange={(event) => onChange({ ...form, encryptionMode: event.target.value as UpdateDeploymentProfileInput['encryptionMode'] })}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            >
              <option value="platform_managed">platform_managed</option>
              <option value="tenant_dedicated">tenant_dedicated</option>
            </select>
          </label>
          <label className="text-sm text-text-secondary md:col-span-2">
            {t('enterpriseConsole.fields.kmsKeyReference')}
            <input
              value={form.kmsKeyRef ?? ''}
              onChange={(event) => onChange({ ...form, kmsKeyRef: event.target.value })}
              placeholder="tenant_enterprise"
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            />
          </label>
        </div>

        <div className="mt-6 rounded-xl border border-border bg-surface p-4">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-text-primary">
            <input
              type="checkbox"
              checked={form.oidc.enabled}
              onChange={(event) => onChange({
                ...form,
                oidc: {
                  ...form.oidc,
                  enabled: event.target.checked,
                },
              })}
            />
            {t('enterpriseConsole.fields.enableTenantOidc')}
          </label>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm text-text-secondary">
              {t('enterpriseConsole.fields.issuerUrl')}
              <input
                value={form.oidc.issuerUrl}
                onChange={(event) => onChange({ ...form, oidc: { ...form.oidc, issuerUrl: event.target.value } })}
                placeholder="https://idp.example.test"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
              />
            </label>
            <label className="text-sm text-text-secondary">
              {t('enterpriseConsole.fields.clientId')}
              <input
                value={form.oidc.clientId}
                onChange={(event) => onChange({ ...form, oidc: { ...form.oidc, clientId: event.target.value } })}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
              />
            </label>
            <label className="text-sm text-text-secondary">
              {t('enterpriseConsole.fields.clientSecret')}
              <input
                type="password"
                value={form.oidc.clientSecret ?? ''}
                onChange={(event) => onChange({ ...form, oidc: { ...form.oidc, clientSecret: event.target.value } })}
                placeholder={t('enterpriseConsole.fields.secretPlaceholder')}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
              />
            </label>
            <label className="text-sm text-text-secondary">
              {t('enterpriseConsole.fields.audience')}
              <input
                value={form.oidc.audience}
                onChange={(event) => onChange({ ...form, oidc: { ...form.oidc, audience: event.target.value } })}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
              />
            </label>
            <label className="text-sm text-text-secondary">
              {t('enterpriseConsole.fields.scope')}
              <input
                value={form.oidc.scope}
                onChange={(event) => onChange({ ...form, oidc: { ...form.oidc, scope: event.target.value } })}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
              />
            </label>
            <label className="text-sm text-text-secondary">
              {t('enterpriseConsole.fields.emailClaim')}
              <input
                value={form.oidc.emailClaim}
                onChange={(event) => onChange({ ...form, oidc: { ...form.oidc, emailClaim: event.target.value } })}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
              />
            </label>
            <label className="text-sm text-text-secondary">
              {t('enterpriseConsole.fields.nameClaim')}
              <input
                value={form.oidc.nameClaim}
                onChange={(event) => onChange({ ...form, oidc: { ...form.oidc, nameClaim: event.target.value } })}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
              />
            </label>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t('enterpriseConsole.sections.scimProvisioning.title')}
        subtitle={t('enterpriseConsole.sections.scimProvisioning.subtitle')}
        actions={(
          <button
            type="button"
            onClick={onGenerateScim}
            disabled={scimGenerating}
            className="inline-flex items-center min-h-touch rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface disabled:opacity-50"
          >
            {scimGenerating
              ? t('enterpriseConsole.buttons.generating')
              : t('enterpriseConsole.buttons.generateToken')}
          </button>
        )}
      >
        <InlineMessage tone="error" message={scimError} />
        {generatedScimToken ? (
          <div className="rounded-lg bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-text-secondary">
              {t('enterpriseConsole.fields.oneTimeTokenLabel')}
            </p>
            <code className="mt-2 block overflow-x-auto whitespace-pre-wrap break-all text-sm text-text-primary">
              {generatedScimToken}
            </code>
          </div>
        ) : (
          <p className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.oneTimeTokenHelp')}
          </p>
        )}
      </SectionCard>
    </div>
  );
}

function OrganizationsPanel({
  organizations,
  organizationsLoading,
  organizationsError,
  selectedOrganizationId,
  organizationForm,
  memberEmail,
  memberRoles,
  members,
  membersLoading,
  membersError,
  successMessage,
  createPending,
  memberPending,
  createError,
  memberError,
  onSelectOrganization,
  onChangeOrganizationForm,
  onMemberEmailChange,
  onMemberRolesChange,
  onCreateOrganization,
  onAddMember,
}: {
  organizations: OrganizationSummary[];
  organizationsLoading: boolean;
  organizationsError: string | null;
  selectedOrganizationId: string | null;
  organizationForm: CreateOrganizationInput;
  memberEmail: string;
  memberRoles: OrganizationRole[];
  members: OrganizationMember[];
  membersLoading: boolean;
  membersError: string | null;
  successMessage: string | null;
  createPending: boolean;
  memberPending: boolean;
  createError: string | null;
  memberError: string | null;
  onSelectOrganization: (organizationId: string) => void;
  onChangeOrganizationForm: (form: CreateOrganizationInput) => void;
  onMemberEmailChange: (value: string) => void;
  onMemberRolesChange: (value: OrganizationRole[]) => void;
  onCreateOrganization: () => void;
  onAddMember: () => void;
}) {
  const { t } = useTranslation();
  const organizationColumns: Column<OrganizationSummary>[] = [
    { id: 'name', header: t('enterpriseConsole.columns.organization'), cell: (row) => row.name },
    { id: 'slug', header: t('enterpriseConsole.columns.slug'), cell: (row) => row.slug },
    { id: 'workspace', header: t('enterpriseConsole.columns.defaultWorkspace'), cell: (row) => row.defaultWorkspace?.name ?? '—' },
    { id: 'createdAt', header: t('enterpriseConsole.columns.created'), cell: (row) => formatDateTime(row.createdAt) },
  ];
  const memberColumns: Column<OrganizationMember>[] = [
    { id: 'email', header: t('enterpriseConsole.columns.email'), cell: (row) => row.email },
    { id: 'roles', header: t('enterpriseConsole.columns.roles'), cell: (row) => row.roles.join(', ') },
    { id: 'status', header: t('enterpriseConsole.columns.status'), cell: (row) => row.status },
    { id: 'joinedAt', header: t('enterpriseConsole.columns.joined'), cell: (row) => formatDateTime(row.joinedAt) },
  ];

  return (
    <div className="space-y-6">
      <InlineMessage tone="success" message={successMessage} />

      <SectionCard title={t('enterpriseConsole.sections.organizationsList.title')} subtitle={t('enterpriseConsole.sections.organizationsList.subtitle')}>
        {organizationsLoading ? (
          <Skeleton variant="table" />
        ) : organizationsError ? (
          <EmptyState variant="error" message={t('enterpriseConsole.errors.organizationsLoadFailed', { error: organizationsError })} />
        ) : (
          <DataTable
            rows={organizations}
            columns={organizationColumns}
            getRowId={(row) => row.organizationId}
            emptyState={<EmptyState message={t('enterpriseConsole.empty.organizations')} />}
            rowActions={(row) => (
              <button
                type="button"
                onClick={() => onSelectOrganization(row.organizationId)}
                /* Full 44px touch target — the DataTable row itself
                 * is not focusable / clickable, so the button is the
                 * only pointer target and must meet WCAG 2.5.5. */
                className={`inline-flex items-center min-h-touch rounded-lg px-3 py-1 text-xs font-medium ${
                  row.organizationId === selectedOrganizationId
                    ? 'bg-primary text-white'
                    : 'border border-border text-text-secondary hover:bg-surface'
                }`}
              >
                {row.organizationId === selectedOrganizationId
                  ? t('enterpriseConsole.buttons.selected')
                  : t('enterpriseConsole.buttons.viewMembers')}
              </button>
            )}
          />
        )}
      </SectionCard>

      <SectionCard
        title={t('enterpriseConsole.sections.createOrganization.title')}
        subtitle={t('enterpriseConsole.sections.createOrganization.subtitle')}
        actions={(
          <button
            type="button"
            onClick={onCreateOrganization}
            disabled={createPending || !organizationForm.name.trim()}
            className="inline-flex items-center min-h-touch rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
          >
            {createPending
              ? t('enterpriseConsole.buttons.creating')
              : t('enterpriseConsole.buttons.createOrganization')}
          </button>
        )}
      >
        <InlineMessage tone="error" message={createError} />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.organizationName')}
            <input
              value={organizationForm.name}
              onChange={(event) => onChangeOrganizationForm({ ...organizationForm, name: event.target.value })}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            />
          </label>
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.slug')}
            <input
              value={organizationForm.slug ?? ''}
              onChange={(event) => onChangeOrganizationForm({ ...organizationForm, slug: event.target.value })}
              placeholder="acme-platform"
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            />
          </label>
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.defaultWorkspaceName')}
            <input
              value={organizationForm.defaultWorkspaceName ?? ''}
              onChange={(event) => onChangeOrganizationForm({ ...organizationForm, defaultWorkspaceName: event.target.value })}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            />
          </label>
          <label className="text-sm text-text-secondary">
            {t('enterpriseConsole.fields.defaultWorkspaceSlug')}
            <input
              value={organizationForm.defaultWorkspaceSlug ?? ''}
              onChange={(event) => onChangeOrganizationForm({ ...organizationForm, defaultWorkspaceSlug: event.target.value })}
              placeholder="default"
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard
        title={t('enterpriseConsole.sections.memberships.title')}
        subtitle={selectedOrganizationId
          ? t('enterpriseConsole.sections.memberships.subtitleSelected', { org: selectedOrganizationId })
          : t('enterpriseConsole.sections.memberships.subtitleEmpty')}
        actions={selectedOrganizationId ? (
          <button
            type="button"
            onClick={onAddMember}
            disabled={memberPending || !memberEmail.trim()}
            className="inline-flex items-center min-h-touch rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface disabled:opacity-50"
          >
            {memberPending
              ? t('enterpriseConsole.buttons.updating')
              : t('enterpriseConsole.buttons.addOrUpdateMember')}
          </button>
        ) : null}
      >
        <InlineMessage tone="error" message={memberError} />
        {selectedOrganizationId ? (
          <>
            <div className="mb-4 grid gap-4 md:grid-cols-[2fr_3fr]">
              <label className="text-sm text-text-secondary">
                {t('enterpriseConsole.fields.userEmail')}
                <input
                  value={memberEmail}
                  onChange={(event) => onMemberEmailChange(event.target.value)}
                  placeholder="member@example.com"
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
                />
              </label>
              <div className="text-sm text-text-secondary">
                {t('enterpriseConsole.fields.roles')}
                <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {ORG_ROLE_OPTIONS.map((role) => {
                    const checked = memberRoles.includes(role);
                    return (
                      <label key={role} className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            onMemberRolesChange(
                              checked
                                ? memberRoles.filter((item) => item !== role)
                                : [...memberRoles, role],
                            );
                          }}
                        />
                        {role}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            {membersLoading ? (
              <Skeleton variant="table" />
            ) : membersError ? (
              <EmptyState variant="error" message={t('enterpriseConsole.errors.membersLoadFailed', { error: membersError })} />
            ) : (
              <DataTable
                rows={members}
                columns={memberColumns}
                getRowId={(row) => row.membershipId}
                emptyState={<EmptyState message={t('enterpriseConsole.empty.membersAssigned')} />}
              />
            )}
          </>
        ) : (
          <EmptyState message={t('enterpriseConsole.empty.selectOrgFirst')} />
        )}
      </SectionCard>
    </div>
  );
}

function ControlPlanePanel({
  personas,
  tasks,
  wallets,
  governance,
  loading,
  errors,
  personaPage,
  taskPage,
  walletPage,
  governancePage,
  onPersonaPageChange,
  onTaskPageChange,
  onWalletPageChange,
  onGovernancePageChange,
}: {
  personas: AdminPersonasResponse | undefined;
  tasks: AdminTasksResponse | undefined;
  wallets: AdminWalletsResponse | undefined;
  governance: AdminGovernanceResponse | undefined;
  loading: boolean;
  errors: string[];
  personaPage: number;
  taskPage: number;
  walletPage: number;
  governancePage: number;
  onPersonaPageChange: (page: number) => void;
  onTaskPageChange: (page: number) => void;
  onWalletPageChange: (page: number) => void;
  onGovernancePageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <Skeleton variant="table" />;
  if (errors.length > 0) return <EmptyState variant="error" message={errors.join('\n')} />;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={t('enterpriseConsole.sections.personas.title')} subtitle={t('enterpriseConsole.sections.personas.subtitle')}>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <MetricTile label={t('enterpriseConsole.summary.total')} value={personas?.summary.total ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.active')} value={personas?.summary.active ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.restricted')} value={personas?.summary.restricted ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.deceased')} value={personas?.summary.deceased ?? 0} />
          </div>
          <DataTable
            rows={personas?.data ?? []}
            columns={[
              { id: 'displayName', header: t('enterpriseConsole.columns.persona'), cell: (row) => row.displayName },
              { id: 'status', header: t('enterpriseConsole.columns.status'), cell: (row) => row.status },
              { id: 'ownerEmail', header: t('enterpriseConsole.columns.owner'), cell: (row) => row.ownerEmail ?? row.ownerUserId },
              { id: 'walletBalance', header: t('enterpriseConsole.columns.wallet'), cell: (row) => row.walletBalance ?? '—' },
            ]}
            getRowId={(row) => row.personaId}
            pagination={personas ? {
              page: personaPage,
              pageSize: personas.pagination.pageSize,
              total: personas.pagination.total,
              onChange: onPersonaPageChange,
            } : undefined}
            emptyState={<EmptyState message={t('enterpriseConsole.empty.personas')} />}
          />
        </SectionCard>

        <SectionCard title={t('enterpriseConsole.sections.tasks.title')} subtitle={t('enterpriseConsole.sections.tasks.subtitle')}>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <MetricTile label={t('enterpriseConsole.summary.total')} value={tasks?.summary.total ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.open')} value={tasks?.summary.open ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.accepted')} value={tasks?.summary.accepted ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.completed')} value={tasks?.summary.completed ?? 0} />
          </div>
          <DataTable
            rows={tasks?.data ?? []}
            columns={[
              { id: 'title', header: t('enterpriseConsole.columns.task'), cell: (row) => row.title },
              { id: 'status', header: t('enterpriseConsole.columns.status'), cell: (row) => row.status },
              { id: 'category', header: t('enterpriseConsole.columns.category'), cell: (row) => row.category },
              { id: 'reward', header: t('enterpriseConsole.columns.reward'), cell: (row) => row.reward },
            ]}
            getRowId={(row) => row.taskId}
            pagination={tasks ? {
              page: taskPage,
              pageSize: tasks.pagination.pageSize,
              total: tasks.pagination.total,
              onChange: onTaskPageChange,
            } : undefined}
            emptyState={<EmptyState message={t('enterpriseConsole.empty.tasks')} />}
          />
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={t('enterpriseConsole.sections.wallets.title')} subtitle={t('enterpriseConsole.sections.wallets.subtitle')}>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <MetricTile label={t('enterpriseConsole.summary.wallets')} value={wallets?.summary.total ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.active')} value={wallets?.summary.active ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.totalBalance')} value={wallets?.summary.totalBalance ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.tokenReserve')} value={wallets?.summary.totalTokenBalance ?? 0} />
          </div>
          <DataTable
            rows={wallets?.data ?? []}
            columns={[
              { id: 'displayName', header: t('enterpriseConsole.columns.persona'), cell: (row) => row.displayName ?? row.personaId },
              { id: 'balance', header: t('enterpriseConsole.columns.balance'), cell: (row) => `${row.balance} ${row.currency}` },
              { id: 'tokenBalance', header: t('enterpriseConsole.columns.reserve'), cell: (row) => row.tokenBalance },
              { id: 'lastSettledAt', header: t('enterpriseConsole.columns.lastSettled'), cell: (row) => formatDateTime(row.lastSettledAt) },
            ]}
            getRowId={(row) => row.walletId}
            pagination={wallets ? {
              page: walletPage,
              pageSize: wallets.pagination.pageSize,
              total: wallets.pagination.total,
              onChange: onWalletPageChange,
            } : undefined}
            emptyState={<EmptyState message={t('enterpriseConsole.empty.wallets')} />}
          />
        </SectionCard>

        <SectionCard title={t('enterpriseConsole.sections.governance.title')} subtitle={t('enterpriseConsole.sections.governance.subtitle')}>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <MetricTile label={t('enterpriseConsole.summary.cases')} value={governance?.summary.total ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.open')} value={governance?.summary.open ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.actionApplied')} value={governance?.summary.actionApplied ?? 0} />
            <MetricTile label={t('enterpriseConsole.summary.appealed')} value={governance?.summary.appealed ?? 0} />
          </div>
          <DataTable
            rows={governance?.data ?? []}
            columns={[
              { id: 'displayName', header: t('enterpriseConsole.columns.persona'), cell: (row) => row.displayName ?? row.personaId },
              { id: 'triggerType', header: t('enterpriseConsole.columns.trigger'), cell: (row) => row.triggerType },
              { id: 'severity', header: t('enterpriseConsole.columns.severity'), cell: (row) => row.severity },
              { id: 'status', header: t('enterpriseConsole.columns.status'), cell: (row) => row.status },
            ]}
            getRowId={(row) => row.caseId}
            pagination={governance ? {
              page: governancePage,
              pageSize: governance.pagination.pageSize,
              total: governance.pagination.total,
              onChange: onGovernancePageChange,
            } : undefined}
            emptyState={<EmptyState message={t('enterpriseConsole.empty.governance')} />}
          />
        </SectionCard>
      </div>
    </div>
  );
}

function VaultPanel({
  keys,
  auditEntries,
  loading,
  error,
  rotating,
  revoking,
  rotateError,
  revokeError,
  onRotate,
  onRevoke,
}: {
  keys: VaultKeyVersion[];
  auditEntries: VaultAuditEntry[];
  loading: boolean;
  error: string | null;
  rotating: boolean;
  revoking: boolean;
  rotateError: string | null;
  revokeError: string | null;
  onRotate: (keyRef: string) => void;
  onRevoke: (keyRef: string) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <Skeleton variant="table" />;
  if (error) return <EmptyState variant="error" message={t('enterpriseConsole.errors.vaultKeysLoadFailed', { error })} />;

  const keyRefs = [...new Set(keys.map((k) => k.keyRef))];

  return (
    <div className="space-y-6">
      {(rotateError ?? revokeError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {rotateError ?? revokeError}
        </div>
      )}

      <SectionCard
        title={t('enterpriseConsole.sections.tenantKeyVersions.title')}
        subtitle={t('enterpriseConsole.sections.tenantKeyVersions.subtitle')}
      >
        {keys.length === 0 ? (
          <EmptyState message={t('enterpriseConsole.empty.vaultKeys')} />
        ) : (
          <DataTable<VaultKeyVersion>
            rows={keys}
            columns={[
              { id: 'keyRef', header: t('enterpriseConsole.columns.keyRef'), cell: (row) => row.keyRef },
              { id: 'provider', header: t('enterpriseConsole.columns.provider'), cell: (row) => row.provider },
              { id: 'version', header: t('enterpriseConsole.columns.version'), cell: (row) => `v${row.version}` },
              {
                id: 'status',
                header: t('enterpriseConsole.columns.status'),
                cell: (row) => (
                  <span className={row.status === 'active' ? 'text-green-600 font-medium' : 'text-red-500'}>
                    {row.status}
                  </span>
                ),
              },
              { id: 'createdAt', header: t('enterpriseConsole.columns.created'), cell: (row) => formatDateTime(row.createdAt) },
              { id: 'revokedAt', header: t('enterpriseConsole.columns.revoked'), cell: (row) => formatDateTime(row.revokedAt) },
            ]}
            getRowId={(row) => `${row.keyRef}-${row.version}`}
            rowActions={(row) =>
              row.status === 'active' ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={rotating}
                    onClick={() => onRotate(row.keyRef)}
                    className="inline-flex items-center min-h-touch rounded px-3 py-1 text-xs font-medium bg-surface border border-border hover:bg-surface-elevated disabled:opacity-50"
                  >
                    {rotating ? t('enterpriseConsole.buttons.rotating') : t('enterpriseConsole.buttons.rotate')}
                  </button>
                  <button
                    type="button"
                    disabled={revoking}
                    onClick={() => onRevoke(row.keyRef)}
                    className="inline-flex items-center min-h-touch rounded px-3 py-1 text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                  >
                    {revoking ? t('enterpriseConsole.buttons.revoking') : t('enterpriseConsole.buttons.revoke')}
                  </button>
                </div>
              ) : null
            }
            emptyState={<EmptyState message={t('enterpriseConsole.empty.vaultKeys')} />}
          />
        )}

        {keyRefs.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {keyRefs.map((ref) => (
              <button
                key={ref}
                type="button"
                disabled={rotating}
                onClick={() => onRotate(ref)}
                className="inline-flex items-center min-h-touch rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-elevated disabled:opacity-50"
              >
                {rotating
                  ? t('enterpriseConsole.buttons.rotating')
                  : t('enterpriseConsole.buttons.rotateNamed', { ref })}
              </button>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t('enterpriseConsole.sections.vaultAudit.title')}
        subtitle={t('enterpriseConsole.sections.vaultAudit.subtitle')}
      >
        <DataTable<VaultAuditEntry>
          rows={auditEntries}
          columns={[
            { id: 'operation', header: t('enterpriseConsole.columns.operation'), cell: (row) => row.operation },
            { id: 'keyRef', header: t('enterpriseConsole.columns.keyRef'), cell: (row) => row.keyRef },
            { id: 'keyVersion', header: t('enterpriseConsole.columns.version'), cell: (row) => row.keyVersion !== null ? `v${row.keyVersion}` : '—' },
            {
              id: 'outcome',
              header: t('enterpriseConsole.columns.outcome'),
              cell: (row) => (
                <span className={row.outcome === 'ok' ? 'text-green-600' : 'text-red-500 font-medium'}>
                  {row.outcome}
                </span>
              ),
            },
            { id: 'performedAt', header: t('enterpriseConsole.columns.time'), cell: (row) => formatDateTime(row.performedAt) },
          ]}
          getRowId={(row) => row.id}
          emptyState={<EmptyState message={t('enterpriseConsole.empty.vaultAudit')} />}
          rowActions={(row) =>
            row.errorMessage ? (
              <span className="text-xs text-red-500">{row.errorMessage}</span>
            ) : null
          }
        />
      </SectionCard>
    </div>
  );
}

function AuditPanel({
  audit,
  loading,
  error,
  page,
  onPageChange,
}: {
  audit: AuditLogsResponse | undefined;
  loading: boolean;
  error: string | null;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <Skeleton variant="table" />;
  if (error) return <EmptyState variant="error" message={t('enterpriseConsole.errors.auditLoadFailed', { error })} />;

  return (
    <div className="space-y-6">
      <SectionCard title={t('enterpriseConsole.sections.businessAudit.title')} subtitle={t('enterpriseConsole.sections.businessAudit.subtitle')}>
        <DataTable
          rows={audit?.data ?? []}
          columns={[
            { id: 'actionType', header: t('enterpriseConsole.columns.action'), cell: (row) => row.actionType },
            { id: 'targetType', header: t('enterpriseConsole.columns.targetType'), cell: (row) => row.targetType ?? '—' },
            { id: 'actorId', header: t('enterpriseConsole.columns.actor'), cell: (row) => row.actorId ?? row.userEmail ?? row.userId ?? 'system' },
            { id: 'createdAt', header: t('enterpriseConsole.columns.time'), cell: (row) => formatDateTime(new Date(row.createdAt).toISOString()) },
          ]}
          getRowId={(row) => row.id}
          pagination={audit ? {
            page,
            pageSize: audit.pagination.pageSize,
            total: audit.pagination.total,
            onChange: onPageChange,
          } : undefined}
          emptyState={<EmptyState message={t('enterpriseConsole.empty.audit')} />}
          rowActions={(row) => (
            <details className="max-w-[24rem] text-left">
              <summary className="cursor-pointer text-xs text-primary">Payload</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface p-3 text-xs text-text-secondary">
                {formatJson(row.payload ?? {})}
              </pre>
            </details>
          )}
        />
      </SectionCard>
    </div>
  );
}
