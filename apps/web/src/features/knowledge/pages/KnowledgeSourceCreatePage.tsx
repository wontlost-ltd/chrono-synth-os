import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Breadcrumbs } from '../../../components/ui/Breadcrumbs';
import { Stepper } from '../../../components/ui/Stepper';
import { FormField } from '../../../components/ui/FormField';
import { useCreateKnowledgeSource, type KnowledgeSourceType } from '../../../api/queries/knowledgeSources';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

const TYPES: KnowledgeSourceType[] = ['rss', 'api', 'file', 'manual', 'llm'];

export default function KnowledgeSourceCreatePage() {
  const { t } = useTranslation();

  const STEPS = [
    { id: 'type', label: t('knowledgeSources.steps.type') },
    { id: 'config', label: t('knowledgeSources.steps.config') },
    { id: 'confirm', label: t('knowledgeSources.steps.confirm') },
  ];
  useDocumentTitle(t('knowledgeSources.createTitle'));
  const navigate = useNavigate();
  const createSource = useCreateKnowledgeSource();

  const [step, setStep] = useState('type');
  const [type, setType] = useState<KnowledgeSourceType>('rss');
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const updateConfig = (key: string, value: unknown) => setConfig(prev => ({ ...prev, [key]: value }));

  const goNext = () => {
    if (step === 'type') { setStep('config'); return; }
    if (step === 'config') {
      const e: Record<string, string> = {};
      if (!name.trim()) e.name = t('knowledgeSources.nameRequired');
      if (type === 'rss' && !config.url) e.url = t('knowledgeSources.urlRequired');
      if (type === 'api' && !config.url) e.url = t('knowledgeSources.urlRequired');
      if (type === 'llm' && !config.systemPrompt) e.systemPrompt = t('knowledgeSources.promptRequired');
      if (Object.keys(e).length) { setErrors(e); return; }
      setErrors({});
      setStep('confirm');
    }
  };

  const goBack = () => {
    if (step === 'config') setStep('type');
    if (step === 'confirm') setStep('config');
  };

  const handleCreate = () => {
    createSource.mutate(
      { type, name, config },
      { onSuccess: () => navigate('/knowledge-sources') },
    );
  };

  return (
    <>
      <Breadcrumbs items={[
        { label: t('knowledgeSources.title'), to: '/knowledge-sources' },
        { label: t('knowledgeSources.createTitle') },
      ]} />
      <PageHeader title={t('knowledgeSources.createTitle')} />

      <div className="mb-6">
        <Stepper steps={STEPS} currentId={step} />
      </div>

      {step === 'type' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TYPES.map(t2 => (
            <button
              key={t2}
              onClick={() => { setType(t2); setConfig({}); }}
              className={`rounded-lg border-2 p-4 text-center text-sm font-medium transition-colors ${
                type === t2 ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:border-primary/50'
              }`}
            >
              <span className="block text-2xl mb-1">
                {t2 === 'rss' ? '📰' : t2 === 'api' ? '🔌' : t2 === 'file' ? '📄' : t2 === 'manual' ? '✏️' : '🤖'}
              </span>
              {t2.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {step === 'config' && (
        <div className="max-w-lg space-y-4">
          <FormField label={t('knowledgeSources.nameLabel')} required error={errors.name}>
            {(props) => (
              <input {...props} type="text" value={name} onChange={e => setName(e.target.value)}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm" maxLength={120} />
            )}
          </FormField>

          {(type === 'rss' || type === 'api') && (
            <FormField label={t('knowledgeSources.urlLabel')} required error={errors.url}>
              {(props) => (
                <input {...props} type="url" value={(config.url as string) ?? ''} onChange={e => updateConfig('url', e.target.value)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
              )}
            </FormField>
          )}

          {(type === 'rss' || type === 'api') && (
            <FormField label={t('knowledgeSources.pollingLabel')} description={t('knowledgeSources.pollingDesc')}>
              {(props) => (
                <input {...props} type="number" min={15} max={10080} value={(config.pollingMinutes as number) ?? 60}
                  onChange={e => updateConfig('pollingMinutes', Number(e.target.value))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
              )}
            </FormField>
          )}

          {type === 'manual' && (
            <FormField label={t('knowledgeSources.manualTextLabel')}>
              {(props) => (
                <textarea {...props} value={(config.manualText as string) ?? ''} onChange={e => updateConfig('manualText', e.target.value)}
                  rows={6} maxLength={20000} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
              )}
            </FormField>
          )}

          {type === 'file' && (
            <FormField label={t('knowledgeSources.fileRefLabel')}>
              {(props) => (
                <input {...props} type="text" value={(config.fileRef as string) ?? ''} onChange={e => updateConfig('fileRef', e.target.value)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
              )}
            </FormField>
          )}

          {type === 'llm' && (
            <>
              <FormField label={t('knowledgeSources.systemPromptLabel')} required error={errors.systemPrompt}
                description={t('knowledgeSources.systemPromptDesc')}>
                {(props) => (
                  <textarea {...props} value={(config.systemPrompt as string) ?? ''} onChange={e => updateConfig('systemPrompt', e.target.value)}
                    rows={5} maxLength={5000} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
                )}
              </FormField>
              <FormField label={t('knowledgeSources.topicsLabel')} description={t('knowledgeSources.topicsDesc')}>
                {(props) => (
                  <textarea {...props} value={((config.topics as string[]) ?? []).join('\n')}
                    onChange={e => updateConfig('topics', e.target.value.split('\n').filter(Boolean))}
                    rows={4} className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                    placeholder={t('knowledgeSources.topicsPlaceholder')} />
                )}
              </FormField>
              <FormField label={t('knowledgeSources.itemsPerRunLabel')} description={t('knowledgeSources.itemsPerRunDesc')}>
                {(props) => (
                  <input {...props} type="number" min={1} max={20} value={(config.itemsPerRun as number) ?? 5}
                    onChange={e => updateConfig('itemsPerRun', Number(e.target.value))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
                )}
              </FormField>
            </>
          )}
        </div>
      )}

      {step === 'confirm' && (
        <div className="max-w-lg rounded-lg border border-border p-6">
          <h3 className="mb-4 text-sm font-semibold">{t('knowledgeSources.confirmSummary')}</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-text-secondary">{t('knowledgeSources.colType')}</dt><dd className="font-medium uppercase">{type}</dd></div>
            <div className="flex justify-between"><dt className="text-text-secondary">{t('knowledgeSources.colName')}</dt><dd className="font-medium">{name}</dd></div>
            {Boolean(config.url) && <div className="flex justify-between"><dt className="text-text-secondary">{t('knowledgeSources.urlLabel')}</dt><dd className="truncate ml-4 font-mono text-xs">{String(config.url)}</dd></div>}
            {Boolean(config.systemPrompt) && <div><dt className="text-text-secondary">{t('knowledgeSources.systemPromptLabel')}</dt><dd className="mt-1 text-xs text-text-secondary whitespace-pre-wrap">{String(config.systemPrompt).slice(0, 200)}...</dd></div>}
          </dl>
        </div>
      )}

      <div className="mt-6 flex gap-3">
        {step !== 'type' && (
          <button onClick={goBack} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface">
            {t('wizard.previous')}
          </button>
        )}
        {step !== 'confirm' ? (
          <button onClick={goNext} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            {t('wizard.next')}
          </button>
        ) : (
          <button onClick={handleCreate} disabled={createSource.isPending}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50">
            {createSource.isPending ? t('common.loading') : t('knowledgeSources.createAndSync')}
          </button>
        )}
      </div>
    </>
  );
}
