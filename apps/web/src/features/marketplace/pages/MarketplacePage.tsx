import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { FormField } from '../../../components/ui/FormField';
import { Modal } from '../../../components/ui/Modal';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import {
  useAcceptMarketplaceTask,
  useCompleteMarketplaceTask,
  useMarketplaceTasks,
  usePublishMarketplaceTask,
} from '../../../api/queries/marketplace';
import {
  usePersonaCoreList,
  type MarketplaceTask,
  type MarketplaceTaskCategory,
  type MarketplaceTaskStatus,
} from '../../../api/queries/personaCore';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

const STATUS_MAP: Record<MarketplaceTaskStatus, 'active' | 'paused' | 'completed' | 'offline'> = {
  open: 'active',
  accepted: 'paused',
  completed: 'completed',
  cancelled: 'offline',
};

const CATEGORY_OPTIONS: MarketplaceTaskCategory[] = ['writing', 'coding', 'research', 'operations', 'general'];
const FILTERS: MarketplaceTaskStatus[] = ['open', 'accepted', 'completed'];

export default function MarketplacePage() {
  const { t } = useTranslation();
  useDocumentTitle(t('marketplace.title'));

  const [status, setStatus] = useState<MarketplaceTaskStatus>('open');
  const tasks = useMarketplaceTasks(status);
  const personas = usePersonaCoreList();
  const publishTask = usePublishMarketplaceTask();

  const [selectedPersonaId, setSelectedPersonaId] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishForm, setPublishForm] = useState({
    title: '',
    description: '',
    category: 'operations' as MarketplaceTaskCategory,
    reward: '80',
    currency: 'CRED',
  });
  const [completeTaskId, setCompleteTaskId] = useState('');
  const [completeForm, setCompleteForm] = useState({ qualityScore: '0.9', ownerTrainingHours: '1' });

  useEffect(() => {
    if (!personas.data?.length) return;
    if (!selectedPersonaId || !personas.data.some(persona => persona.id === selectedPersonaId)) {
      setSelectedPersonaId(personas.data[0]!.id);
    }
  }, [personas.data, selectedPersonaId]);

  const personaOptions = personas.data ?? [];
  const selectedPersona = personaOptions.find(persona => persona.id === selectedPersonaId) ?? null;
  const list = tasks.data ?? [];
  const totalReward = list.reduce((sum, task) => sum + task.reward, 0);

  const columns: Column<MarketplaceTask>[] = [
    {
      id: 'title',
      header: t('marketplace.columns.title'),
      cell: row => <span className="font-medium">{row.title}</span>,
    },
    {
      id: 'category',
      header: t('marketplace.columns.category'),
      cell: row => t(`marketplace.category.${row.category}`),
    },
    {
      id: 'status',
      header: t('marketplace.columns.status'),
      cell: row => <StatusBadge status={STATUS_MAP[row.status]} label={t(`marketplace.status.${row.status}`)} />,
    },
    {
      id: 'reward',
      header: t('marketplace.columns.reward'),
      align: 'right',
      cell: row => `${row.reward.toFixed(2)} ${row.currency}`,
    },
    {
      id: 'assigneePersonaName',
      header: t('marketplace.columns.assignee'),
      cell: row => row.assigneePersonaName ?? t('marketplace.unassigned'),
    },
    {
      id: 'updatedAt',
      header: t('marketplace.columns.updatedAt'),
      cell: row => row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '-',
    },
  ];

  return (
    <>
      <PageHeader
        title={t('marketplace.title')}
        subtitle={t('marketplace.subtitle')}
        actions={
          <button
            type="button"
            onClick={() => setPublishOpen(true)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
          >
            {t('marketplace.publish')}
          </button>
        }
      />

      <section className="mb-6 grid gap-4 md:grid-cols-3">
        <MetricCard label={t('marketplace.metrics.visibleTasks')} value={String(list.length)} />
        <MetricCard label={t('marketplace.metrics.totalReward')} value={totalReward.toFixed(2)} />
        <MetricCard
          label={t('marketplace.metrics.activePersona')}
          value={selectedPersona?.displayName ?? t('marketplace.noPersona')}
          secondary={selectedPersona ? `${selectedPersona.wallet.balance.toFixed(2)} · ${selectedPersona.wallet.tokenBalance.toFixed(2)}T` : undefined}
        />
      </section>

      <section className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-elevated p-4">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map(filter => (
            <button
              key={filter}
              type="button"
              onClick={() => setStatus(filter)}
              className={`rounded-full px-3 py-1.5 text-sm ${
                status === filter
                  ? 'bg-primary text-white'
                  : 'border border-border text-text-secondary hover:bg-surface'
              }`}
            >
              {t(`marketplace.status.${filter}`)}
            </button>
          ))}
        </div>
        <label className="ml-auto flex min-w-[220px] items-center gap-2">
          <span className="text-sm text-text-secondary">{t('marketplace.assignPersona')}</span>
          <select
            value={selectedPersonaId}
            onChange={event => setSelectedPersonaId(event.target.value)}
            className="flex-1 rounded-lg border border-border px-3 py-2 text-sm"
          >
            {personaOptions.map(persona => (
              <option key={persona.id} value={persona.id}>{persona.displayName}</option>
            ))}
          </select>
        </label>
      </section>

      {tasks.error ? (
        <EmptyState variant="error" message={tasks.error.message} />
      ) : (
        <DataTable
          rows={list}
          columns={columns}
          getRowId={row => row.id}
          loading={tasks.isLoading}
          emptyState={
            <EmptyState
              illustration="tools"
              title={t('marketplace.emptyTitle')}
              message={t('marketplace.emptyDescription')}
              primaryAction={{
                label: t('marketplace.emptyAction'),
                onClick: () => setPublishOpen(true),
              }}
            />
          }
          rowActions={row => (
            <TaskActions
              row={row}
              selectedPersonaId={selectedPersonaId}
              onOpenComplete={() => setCompleteTaskId(row.id)}
            />
          )}
        />
      )}

      <Modal open={publishOpen} onClose={() => setPublishOpen(false)} title={t('marketplace.publishTitle')}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!publishForm.title.trim() || !publishForm.description.trim()) return;
            publishTask.mutate({
              title: publishForm.title.trim(),
              description: publishForm.description.trim(),
              category: publishForm.category,
              reward: Number(publishForm.reward),
              currency: publishForm.currency.trim() || 'CRED',
            }, {
              onSuccess: () => {
                setPublishOpen(false);
                setPublishForm({ title: '', description: '', category: 'operations', reward: '80', currency: 'CRED' });
              },
            });
          }}
        >
          <FormField label={t('marketplace.form.title')} required>
            {(props) => (
              <input
                {...props}
                type="text"
                value={publishForm.title}
                onChange={event => setPublishForm(prev => ({ ...prev, title: event.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <FormField label={t('marketplace.form.description')} required>
            {(props) => (
              <textarea
                {...props}
                rows={5}
                value={publishForm.description}
                onChange={event => setPublishForm(prev => ({ ...prev, description: event.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <div className="grid gap-4 md:grid-cols-3">
            <FormField label={t('marketplace.form.category')}>
              {(props) => (
                <select
                  {...props}
                  value={publishForm.category}
                  onChange={event => setPublishForm(prev => ({ ...prev, category: event.target.value as MarketplaceTaskCategory }))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                >
                  {CATEGORY_OPTIONS.map(option => (
                    <option key={option} value={option}>{t(`marketplace.category.${option}`)}</option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField label={t('marketplace.form.reward')}>
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min="0"
                  step="0.01"
                  value={publishForm.reward}
                  onChange={event => setPublishForm(prev => ({ ...prev, reward: event.target.value }))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                />
              )}
            </FormField>
            <FormField label={t('marketplace.form.currency')}>
              {(props) => (
                <input
                  {...props}
                  type="text"
                  value={publishForm.currency}
                  onChange={event => setPublishForm(prev => ({ ...prev, currency: event.target.value }))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                />
              )}
            </FormField>
          </div>
          <button
            type="submit"
            disabled={publishTask.isPending}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
          >
            {publishTask.isPending ? t('common.loading') : t('marketplace.publish')}
          </button>
        </form>
      </Modal>

      <Modal open={Boolean(completeTaskId)} onClose={() => setCompleteTaskId('')} title={t('marketplace.completeTitle')}>
        <CompleteTaskForm
          taskId={completeTaskId}
          form={completeForm}
          onChange={setCompleteForm}
          onClose={() => setCompleteTaskId('')}
        />
      </Modal>
    </>
  );
}

function TaskActions({
  row,
  selectedPersonaId,
  onOpenComplete,
}: {
  row: MarketplaceTask;
  selectedPersonaId: string;
  onOpenComplete: () => void;
}) {
  const { t } = useTranslation();
  const acceptTask = useAcceptMarketplaceTask(row.id);

  if (row.status === 'open') {
    return (
      <button
        type="button"
        onClick={() => acceptTask.mutate({ personaId: selectedPersonaId })}
        disabled={acceptTask.isPending || !selectedPersonaId}
        className="text-sm text-primary hover:underline disabled:opacity-50"
      >
        {t('marketplace.accept')}
      </button>
    );
  }

  if (row.status === 'accepted') {
    return (
      <button
        type="button"
        onClick={onOpenComplete}
        className="text-sm text-primary hover:underline"
      >
        {t('marketplace.complete')}
      </button>
    );
  }

  return <span className="text-sm text-text-secondary">-</span>;
}

function CompleteTaskForm({
  taskId,
  form,
  onChange,
  onClose,
}: {
  taskId: string;
  form: { qualityScore: string; ownerTrainingHours: string };
  onChange: (value: { qualityScore: string; ownerTrainingHours: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const completeTask = useCompleteMarketplaceTask(taskId);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!taskId) return;
        completeTask.mutate({
          qualityScore: Number(form.qualityScore),
          ownerTrainingHours: Number(form.ownerTrainingHours),
        }, {
          onSuccess: () => {
            onClose();
            onChange({ qualityScore: '0.9', ownerTrainingHours: '1' });
          },
        });
      }}
    >
      <FormField label={t('marketplace.form.qualityScore')}>
        {(props) => (
          <input
            {...props}
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={form.qualityScore}
            onChange={event => onChange({ ...form, qualityScore: event.target.value })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
        )}
      </FormField>
      <FormField label={t('marketplace.form.trainingHours')}>
        {(props) => (
          <input
            {...props}
            type="number"
            min="0"
            step="0.1"
            value={form.ownerTrainingHours}
            onChange={event => onChange({ ...form, ownerTrainingHours: event.target.value })}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
        )}
      </FormField>
      <button
        type="submit"
        disabled={completeTask.isPending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
      >
        {completeTask.isPending ? t('common.loading') : t('marketplace.complete')}
      </button>
    </form>
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
