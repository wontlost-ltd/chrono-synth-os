import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Modal } from '../../../components/ui/Modal';
import { FormField } from '../../../components/ui/FormField';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import {
  useAddPersonaKnowledge,
  useCreatePersonaCore,
  useDeceasePersona,
  useForkPersonaCore,
  usePersonaCore,
  usePersonaCoreList,
  type PersonaCoreSummary,
  type PersonaVisibility,
} from '../../../api/queries/personaCore';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

const STATUS_MAP: Record<string, 'active' | 'paused' | 'error' | 'offline'> = {
  active: 'active',
  restricted: 'error',
  deceased: 'offline',
  transferred: 'paused',
};

const VISIBILITY_OPTIONS: PersonaVisibility[] = ['private', 'shared', 'marketplace'];
const FORK_TYPES = ['experimental', 'task', 'social', 'research', 'operations'] as const;

function splitLines(value: string) {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export default function PersonaCorePage() {
  const { t } = useTranslation();
  useDocumentTitle(t('personaCore.title'));

  const personas = usePersonaCoreList();
  const createPersona = useCreatePersonaCore();
  const [selectedPersonaId, setSelectedPersonaId] = useState('');
  const detail = usePersonaCore(selectedPersonaId);

  const [createOpen, setCreateOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    displayName: '',
    visibility: 'private' as PersonaVisibility,
    mission: '',
    traits: '',
    initialKnowledgeTitle: '',
    initialKnowledgeContent: '',
  });
  const [forkForm, setForkForm] = useState({ label: '', forkType: 'experimental' as typeof FORK_TYPES[number] });
  const [knowledgeForm, setKnowledgeForm] = useState({ title: '', content: '', source: 'manual', tags: '' });

  useEffect(() => {
    if (!personas.data?.length) return;
    const exists = personas.data.some(persona => persona.id === selectedPersonaId);
    if (!selectedPersonaId || !exists) {
      setSelectedPersonaId(personas.data[0]!.id);
    }
  }, [personas.data, selectedPersonaId]);

  const list = personas.data ?? [];
  const selected = detail.data;
  const totalWalletBalance = list.reduce((sum, persona) => sum + persona.wallet.balance, 0);
  const avgGrowth = list.length ? list.reduce((sum, persona) => sum + persona.growthIndex, 0) / list.length : 0;
  const totalActiveForks = list.reduce((sum, persona) => sum + persona.stats.activeForks, 0);

  const columns: Column<PersonaCoreSummary>[] = [
    {
      id: 'displayName',
      header: t('personaCore.columns.name'),
      cell: row => <span className="font-medium">{row.displayName}</span>,
    },
    {
      id: 'status',
      header: t('personaCore.columns.status'),
      cell: row => (
        <StatusBadge
          status={STATUS_MAP[row.status] ?? 'offline'}
          label={t(`personaCore.status.${row.status}`)}
        />
      ),
    },
    {
      id: 'visibility',
      header: t('personaCore.columns.visibility'),
      cell: row => t(`personaCore.visibility.${row.visibility}`),
    },
    {
      id: 'growthIndex',
      header: t('personaCore.columns.growth'),
      align: 'right',
      cell: row => row.growthIndex.toFixed(2),
    },
    {
      id: 'reputation',
      header: t('personaCore.columns.reputation'),
      align: 'right',
      cell: row => row.reputation.toFixed(2),
    },
    {
      id: 'wallet',
      header: t('personaCore.columns.wallet'),
      align: 'right',
      cell: row => `${row.wallet.balance.toFixed(2)} · ${row.wallet.tokenBalance.toFixed(2)}T`,
    },
    {
      id: 'stats',
      header: t('personaCore.columns.activity'),
      cell: row => t('personaCore.activitySummary', row.stats),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('personaCore.title')}
        subtitle={t('personaCore.subtitle')}
        actions={
          <>
            {selectedPersonaId && (
              <>
                <button
                  type="button"
                  onClick={() => setKnowledgeOpen(true)}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface"
                >
                  {t('personaCore.addKnowledge')}
                </button>
                <button
                  type="button"
                  onClick={() => setForkOpen(true)}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface"
                >
                  {t('personaCore.fork')}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
            >
              {t('personaCore.create')}
            </button>
          </>
        }
      />

      <section className="mb-6 grid gap-4 md:grid-cols-3">
        <MetricCard label={t('personaCore.metrics.personas')} value={String(list.length)} />
        <MetricCard label={t('personaCore.metrics.walletBalance')} value={totalWalletBalance.toFixed(2)} />
        <MetricCard label={t('personaCore.metrics.avgGrowth')} value={avgGrowth.toFixed(2)} secondary={`${totalActiveForks} forks`} />
      </section>

      {personas.error ? (
        <EmptyState variant="error" message={personas.error.message} />
      ) : (
        <DataTable
          rows={list}
          columns={columns}
          getRowId={row => row.id}
          loading={personas.isLoading}
          emptyState={<EmptyState message={t('personaCore.emptyState')} />}
          rowActions={row => (
            <button
              type="button"
              onClick={() => setSelectedPersonaId(row.id)}
              className="text-sm text-primary hover:underline"
            >
              {row.id === selectedPersonaId ? t('personaCore.selected') : t('personaCore.view')}
            </button>
          )}
        />
      )}

      <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-border bg-surface-elevated p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">{t('personaCore.detailTitle')}</h2>
              <p className="text-sm text-text-secondary">{selected?.displayName ?? t('personaCore.noSelection')}</p>
            </div>
            {selectedPersonaId && (
              <div className="flex items-center gap-2">
                <Link
                  to={`/persona/${selectedPersonaId}/governance`}
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-hover"
                >
                  {t('personaCore.governancePolicy')}
                </Link>
                <DeceaseButton personaId={selectedPersonaId} />
              </div>
            )}
          </div>

          {detail.error ? (
            <EmptyState variant="error" message={detail.error.message} />
          ) : detail.isLoading ? (
            <div className="text-sm text-text-secondary">{t('common.loading')}</div>
          ) : !selected ? (
            <EmptyState message={t('personaCore.noSelection')} />
          ) : (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <MetricCard label={t('personaCore.metrics.walletBalance')} value={selected.wallet.balance.toFixed(2)} />
                <MetricCard label={t('personaCore.metrics.tokenBalance')} value={selected.wallet.tokenBalance.toFixed(2)} />
                <MetricCard label={t('personaCore.metrics.reputation')} value={selected.reputation.toFixed(2)} />
                <MetricCard label={t('personaCore.metrics.trainingInvestment')} value={selected.trainingInvestment.toFixed(2)} />
              </div>

              <div className="rounded-lg border border-border p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="font-medium text-text-primary">{t('personaCore.profileTitle')}</h3>
                  <StatusBadge status={STATUS_MAP[selected.status] ?? 'offline'} label={t(`personaCore.status.${selected.status}`)} />
                </div>
                <p className="text-sm text-text-secondary">
                  {(selected.profile.mission as string | undefined) ?? t('personaCore.noMission')}
                </p>
                <p className="mt-2 text-xs text-text-secondary">
                  {t('personaCore.walletAddress')}: <span className="font-mono">{selected.wallet.walletAddress}</span>
                </p>
              </div>

              <DetailList
                title={t('personaCore.sections.forks')}
                empty={t('personaCore.emptyForks')}
                items={selected.forks.map(fork => ({
                  key: fork.id,
                  title: fork.label,
                  meta: `${t(`personaCore.forkType.${fork.forkType}`)} · ${fork.syncMode}`,
                }))}
              />
            </div>
          )}
        </div>

        <div className="space-y-6">
          <DetailList
            title={t('personaCore.sections.knowledge')}
            empty={t('personaCore.emptyKnowledge')}
            items={(selected?.knowledgeItems ?? []).map(item => ({
              key: item.id,
              title: item.title,
              meta: `${item.source} · ${(item.confidence * 100).toFixed(0)}%`,
              body: item.content,
            }))}
          />
          <DetailList
            title={t('personaCore.sections.memories')}
            empty={t('personaCore.emptyMemories')}
            items={(selected?.recentMemories ?? []).map(item => ({
              key: item.id,
              title: item.summary,
              meta: `${item.kind} · ${(item.importance * 100).toFixed(0)}%`,
            }))}
          />
          <DetailList
            title={t('personaCore.sections.governance')}
            empty={t('personaCore.emptyGovernance')}
            items={(selected?.governanceEvents ?? []).map(item => ({
              key: item.id,
              title: item.summary,
              meta: `${t(`personaCore.governance.${item.eventType}`)} · S${item.severity}`,
            }))}
          />
        </div>
      </section>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('personaCore.createTitle')}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!createForm.displayName.trim()) return;
            createPersona.mutate({
              displayName: createForm.displayName.trim(),
              visibility: createForm.visibility,
              profile: {
                mission: createForm.mission.trim(),
                traits: splitLines(createForm.traits),
              },
              initialKnowledge: createForm.initialKnowledgeTitle.trim() && createForm.initialKnowledgeContent.trim()
                ? [{
                    title: createForm.initialKnowledgeTitle.trim(),
                    content: createForm.initialKnowledgeContent.trim(),
                    source: 'manual',
                  }]
                : [],
            }, {
              onSuccess: (result) => {
                setCreateOpen(false);
                setSelectedPersonaId(result.id);
                setCreateForm({
                  displayName: '',
                  visibility: 'private',
                  mission: '',
                  traits: '',
                  initialKnowledgeTitle: '',
                  initialKnowledgeContent: '',
                });
              },
            });
          }}
        >
          <FormField label={t('personaCore.form.name')} required>
            {(props) => (
              <input
                {...props}
                type="text"
                value={createForm.displayName}
                onChange={event => setCreateForm(prev => ({ ...prev, displayName: event.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <FormField label={t('personaCore.form.visibility')}>
            {(props) => (
              <select
                {...props}
                value={createForm.visibility}
                onChange={event => setCreateForm(prev => ({ ...prev, visibility: event.target.value as PersonaVisibility }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              >
                {VISIBILITY_OPTIONS.map(option => (
                  <option key={option} value={option}>{t(`personaCore.visibility.${option}`)}</option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('personaCore.form.mission')}>
            {(props) => (
              <textarea
                {...props}
                rows={3}
                value={createForm.mission}
                onChange={event => setCreateForm(prev => ({ ...prev, mission: event.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <FormField label={t('personaCore.form.traits')}>
            {(props) => (
              <textarea
                {...props}
                rows={3}
                value={createForm.traits}
                onChange={event => setCreateForm(prev => ({ ...prev, traits: event.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <FormField label={t('personaCore.form.seedKnowledgeTitle')}>
            {(props) => (
              <input
                {...props}
                type="text"
                value={createForm.initialKnowledgeTitle}
                onChange={event => setCreateForm(prev => ({ ...prev, initialKnowledgeTitle: event.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <FormField label={t('personaCore.form.seedKnowledgeContent')}>
            {(props) => (
              <textarea
                {...props}
                rows={4}
                value={createForm.initialKnowledgeContent}
                onChange={event => setCreateForm(prev => ({ ...prev, initialKnowledgeContent: event.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <button
            type="submit"
            disabled={createPersona.isPending}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
          >
            {createPersona.isPending ? t('common.loading') : t('personaCore.create')}
          </button>
        </form>
      </Modal>

      <Modal open={forkOpen} onClose={() => setForkOpen(false)} title={t('personaCore.forkTitle')}>
        <ForkForm
          selectedPersonaId={selectedPersonaId}
          forkForm={forkForm}
          onChange={setForkForm}
          onClose={() => setForkOpen(false)}
        />
      </Modal>

      <Modal open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} title={t('personaCore.knowledgeTitle')}>
        <KnowledgeForm
          selectedPersonaId={selectedPersonaId}
          knowledgeForm={knowledgeForm}
          onChange={setKnowledgeForm}
          onClose={() => setKnowledgeOpen(false)}
        />
      </Modal>
    </>
  );
}

function ForkForm({
  selectedPersonaId,
  forkForm,
  onChange,
  onClose,
}: {
  selectedPersonaId: string;
  forkForm: { label: string; forkType: typeof FORK_TYPES[number] };
  onChange: (value: { label: string; forkType: typeof FORK_TYPES[number] }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const forkPersona = useForkPersonaCore(selectedPersonaId);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selectedPersonaId || !forkForm.label.trim()) return;
        forkPersona.mutate({
          label: forkForm.label.trim(),
          forkType: forkForm.forkType,
        }, {
          onSuccess: () => {
            onClose();
            onChange({ label: '', forkType: 'experimental' });
          },
        });
      }}
    >
      <FormField label={t('personaCore.form.forkName')} required>
        {(props) => (
          <input
            {...props}
            type="text"
            value={forkForm.label}
            onChange={event => onChange({ ...forkForm, label: event.target.value })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
        )}
      </FormField>
      <FormField label={t('personaCore.form.forkType')}>
        {(props) => (
          <select
            {...props}
            value={forkForm.forkType}
            onChange={event => onChange({ ...forkForm, forkType: event.target.value as typeof FORK_TYPES[number] })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          >
            {FORK_TYPES.map(type => (
              <option key={type} value={type}>{t(`personaCore.forkType.${type}`)}</option>
            ))}
          </select>
        )}
      </FormField>
      <button
        type="submit"
        disabled={forkPersona.isPending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
      >
        {forkPersona.isPending ? t('common.loading') : t('personaCore.fork')}
      </button>
    </form>
  );
}

function KnowledgeForm({
  selectedPersonaId,
  knowledgeForm,
  onChange,
  onClose,
}: {
  selectedPersonaId: string;
  knowledgeForm: { title: string; content: string; source: string; tags: string };
  onChange: (value: { title: string; content: string; source: string; tags: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const addKnowledge = useAddPersonaKnowledge(selectedPersonaId);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selectedPersonaId || !knowledgeForm.title.trim() || !knowledgeForm.content.trim()) return;
        addKnowledge.mutate({
          title: knowledgeForm.title.trim(),
          content: knowledgeForm.content.trim(),
          source: knowledgeForm.source.trim() || 'manual',
          tags: knowledgeForm.tags.split(',').map(tag => tag.trim()).filter(Boolean),
        }, {
          onSuccess: () => {
            onClose();
            onChange({ title: '', content: '', source: 'manual', tags: '' });
          },
        });
      }}
    >
      <FormField label={t('personaCore.form.knowledgeTitle')} required>
        {(props) => (
          <input
            {...props}
            type="text"
            value={knowledgeForm.title}
            onChange={event => onChange({ ...knowledgeForm, title: event.target.value })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
        )}
      </FormField>
      <FormField label={t('personaCore.form.knowledgeSource')}>
        {(props) => (
          <input
            {...props}
            type="text"
            value={knowledgeForm.source}
            onChange={event => onChange({ ...knowledgeForm, source: event.target.value })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
        )}
      </FormField>
      <FormField label={t('personaCore.form.knowledgeTags')}>
        {(props) => (
          <input
            {...props}
            type="text"
            value={knowledgeForm.tags}
            onChange={event => onChange({ ...knowledgeForm, tags: event.target.value })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
        )}
      </FormField>
      <FormField label={t('personaCore.form.knowledgeContent')} required>
        {(props) => (
          <textarea
            {...props}
            rows={6}
            value={knowledgeForm.content}
            onChange={event => onChange({ ...knowledgeForm, content: event.target.value })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
        )}
      </FormField>
      <button
        type="submit"
        disabled={addKnowledge.isPending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
      >
        {addKnowledge.isPending ? t('common.loading') : t('personaCore.addKnowledge')}
      </button>
    </form>
  );
}

function DeceaseButton({ personaId }: { personaId: string }) {
  const { t } = useTranslation();
  const deceasePersona = useDeceasePersona(personaId);

  return (
    <button
      type="button"
      onClick={() => {
        const reason = window.prompt(t('personaCore.deceasePrompt'), 'manual shutdown');
        if (!reason) return;
        deceasePersona.mutate({ reason });
      }}
      disabled={deceasePersona.isPending}
      className="rounded-lg border border-error/30 px-3 py-2 text-sm font-medium text-error hover:bg-error/5 disabled:opacity-50"
    >
      {t('personaCore.decease')}
    </button>
  );
}

function MetricCard({ label, value, secondary }: { label: string; value: string; secondary?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4">
      <div className="text-sm text-text-secondary">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-text-primary">{value}</div>
      {secondary && <div className="mt-1 text-xs text-text-secondary">{secondary}</div>}
    </div>
  );
}

function DetailList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ key: string; title: string; meta?: string; body?: string }>;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface-elevated p-4">
      <h3 className="mb-3 font-medium text-text-primary">{title}</h3>
      {!items.length ? (
        <p className="text-sm text-text-secondary">{empty}</p>
      ) : (
        <div className="space-y-3">
          {items.map(item => (
            <div key={item.key} className="rounded-lg border border-border p-3">
              <div className="font-medium text-text-primary">{item.title}</div>
              {item.meta && <div className="mt-1 text-xs text-text-secondary">{item.meta}</div>}
              {item.body && <p className="mt-2 text-sm text-text-secondary">{item.body}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
