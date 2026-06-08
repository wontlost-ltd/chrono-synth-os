import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Breadcrumbs } from '../../../components/ui/Breadcrumbs';
import { FormField } from '../../../components/ui/FormField';
import { Skeleton } from '../../../components/ui/Skeleton';
import { EmptyState } from '../../../components/ui/EmptyState';
import { useAutorunConfig, useUpdateAutorunConfig, useTriggerAutorun, type AutorunConfig } from '../../../api/queries/autorun';
import { useAvatar } from '../../../api/queries/avatars';
import { useKnowledgeSources } from '../../../api/queries/knowledgeSources';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

export default function AutorunConfigPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const avatar = useAvatar(id ?? '');
  const { data: config, isLoading } = useAutorunConfig(id ?? '');
  const updateConfig = useUpdateAutorunConfig(id ?? '');
  const triggerRun = useTriggerAutorun(id ?? '');
  const { data: sources } = useKnowledgeSources();

  useDocumentTitle(t('autorun.title'));

  const [form, setForm] = useState<AutorunConfig>({
    enabled: false, intervalMinutes: 360, driftThreshold: 0.3, reviewRequired: false, knowledgeSourceIds: [],
  });

  useEffect(() => {
    if (config) setForm({
      enabled: config.enabled ?? false,
      intervalMinutes: config.intervalMinutes ?? 360,
      driftThreshold: config.driftThreshold ?? 0.3,
      reviewRequired: config.reviewRequired ?? false,
      knowledgeSourceIds: config.knowledgeSourceIds ?? [],
    });
  }, [config]);

  const update = (key: keyof AutorunConfig, value: unknown) => setForm(prev => ({ ...prev, [key]: value }));

  const handleSave = () => updateConfig.mutate(form);

  if (isLoading) return <Skeleton variant="card" />;

  return (
    <>
      <Breadcrumbs items={[
        { label: t('avatars.title'), to: '/avatars' },
        { label: avatar.data?.label ?? '...', to: `/avatars/${id}` },
        { label: t('autorun.title') },
      ]} />

      <PageHeader
        title={t('autorun.title')}
        actions={
          <div className="flex gap-2">
            <button onClick={() => triggerRun.mutate()} disabled={triggerRun.isPending}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-50">
              {triggerRun.isPending ? t('common.loading') : t('autorun.triggerNow')}
            </button>
            <Link to={`/avatars/${id}/autorun/runs`} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface">
              {t('autorun.viewRuns')}
            </Link>
          </div>
        }
      />

      <div className="max-w-lg space-y-4">
        <FormField label={t('autorun.enabledLabel')}>
          {(props) => (
            <div className="flex items-center gap-2">
              <input {...props} type="checkbox" checked={form.enabled} onChange={e => update('enabled', e.target.checked)}
                className="h-4 w-4 rounded border-border" />
              <span className="text-sm">{form.enabled ? t('autorun.on') : t('autorun.off')}</span>
            </div>
          )}
        </FormField>

        <FormField label={t('autorun.intervalLabel')} description={t('autorun.intervalDesc')}>
          {(props) => (
            <input {...props} type="number" min={15} max={10080} value={form.intervalMinutes}
              onChange={e => update('intervalMinutes', Number(e.target.value))}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
          )}
        </FormField>

        <FormField label={t('autorun.driftLabel')} description={t('autorun.driftDesc')}>
          {(props) => (
            <input {...props} type="number" min={0} max={1} step={0.05} value={form.driftThreshold}
              onChange={e => update('driftThreshold', Number(e.target.value))}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
          )}
        </FormField>

        <FormField label={t('autorun.reviewLabel')}>
          {(props) => (
            <div className="flex items-center gap-2">
              <input {...props} type="checkbox" checked={form.reviewRequired} onChange={e => update('reviewRequired', e.target.checked)}
                className="h-4 w-4 rounded border-border" />
              <span className="text-sm">{t('autorun.reviewDesc')}</span>
            </div>
          )}
        </FormField>

        {sources && sources.length > 0 && (
          <FormField label={t('autorun.sourcesLabel')} description={t('autorun.sourcesDesc')}>
            {(_props) => (
              <div className="space-y-1">
                {sources.map(src => (
                  <label key={src.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={(form.knowledgeSourceIds ?? []).includes(src.id)}
                      onChange={e => {
                        const ids = form.knowledgeSourceIds ?? [];
                        update('knowledgeSourceIds',
                          e.target.checked
                            ? [...ids, src.id]
                            : ids.filter(x => x !== src.id)
                        );
                      }}
                      className="h-4 w-4 rounded border-border"
                    />
                    <span className="text-sm">{src.name} <span className="text-xs text-text-secondary">({src.type})</span></span>
                  </label>
                ))}
              </div>
            )}
          </FormField>
        )}

        <button onClick={handleSave} disabled={updateConfig.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50">
          {updateConfig.isPending ? t('common.loading') : t('autorun.save')}
        </button>

        {updateConfig.isSuccess && <p className="text-sm text-success">{t('autorun.saved')}</p>}
        {updateConfig.isError && <EmptyState variant="error" message={t('autorun.saveError')} />}
      </div>
    </>
  );
}
