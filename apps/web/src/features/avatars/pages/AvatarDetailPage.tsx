import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Breadcrumbs } from '../../../components/ui/Breadcrumbs';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { Tabs } from '../../../components/ui/Tabs';
import { Skeleton } from '../../../components/ui/Skeleton';
import { EmptyState } from '../../../components/ui/EmptyState';
import { useAvatar, useProjectAvatar } from '../../../api/queries/avatars';
import { useAutorunConfig } from '../../../api/queries/autorun';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

export default function AvatarDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { data: avatar, isLoading, error } = useAvatar(id ?? '');
  const autorun = useAutorunConfig(id ?? '');
  const projectAvatar = useProjectAvatar(id ?? '');
  const [activeTab, setActiveTab] = useState('overview');

  useDocumentTitle(avatar?.label ?? t('avatars.detail'));

  if (isLoading) return <Skeleton variant="card" />;
  if (error || !avatar) return <EmptyState variant="error" message={error?.message ?? t('avatars.notFound')} />;

  const statusMap: Record<string, 'active' | 'paused' | 'offline'> = { active: 'active', paused: 'paused' };
  const badgeStatus = statusMap[avatar.status] ?? 'offline';

  const tabItems = [
    { id: 'overview', label: t('avatars.tabs.overview') },
    { id: 'autorun', label: t('avatars.tabs.autorun') },
    { id: 'activity', label: t('avatars.tabs.activity') },
  ];

  return (
    <>
      <Breadcrumbs items={[
        { label: t('avatars.title'), to: '/avatars' },
        { label: avatar.label },
      ]} />

      <PageHeader
        title={avatar.label}
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge status={badgeStatus} size="md" />
            <button
              onClick={() => projectAvatar.mutate()}
              disabled={projectAvatar.isPending}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface"
            >
              {t('avatars.project')}
            </button>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <p className="text-xs font-medium text-text-secondary">{t('avatars.metricKind')}</p>
          <p className="mt-1 text-lg font-bold">{t(`avatars.kind.${avatar.kind}`)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <p className="text-xs font-medium text-text-secondary">{t('avatars.metricAutorun')}</p>
          <p className="mt-1 text-lg font-bold">{autorun.data?.enabled ? t('avatars.autorunOn') : t('avatars.autorunOff')}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <p className="text-xs font-medium text-text-secondary">{t('avatars.metricCreated')}</p>
          <p className="mt-1 text-lg font-bold">{new Date(avatar.createdAt).toLocaleDateString()}</p>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        renderPanel={(tabId) => {
          if (tabId === 'overview') {
            return (
              <div className="space-y-4">
                <div className="rounded-lg border border-border p-4">
                  <h3 className="mb-2 text-sm font-semibold">{t('avatars.behaviorTitle')}</h3>
                  {avatar.behaviorOverrides ? (
                    <pre className="text-xs text-text-secondary whitespace-pre-wrap">{JSON.stringify(avatar.behaviorOverrides, null, 2)}</pre>
                  ) : (
                    <p className="text-sm text-text-secondary">{t('avatars.noOverrides')}</p>
                  )}
                </div>
              </div>
            );
          }
          if (tabId === 'autorun') {
            return (
              <div className="rounded-lg border border-border p-4">
                <p className="text-sm text-text-secondary">
                  {autorun.data?.enabled
                    ? t('avatars.autorunStatus', { interval: autorun.data.intervalMinutes })
                    : t('avatars.autorunDisabled')}
                </p>
                <a href={`/avatars/${id}/autorun`} className="mt-2 inline-block text-sm text-primary hover:underline">
                  {t('avatars.configAutorun')}
                </a>
              </div>
            );
          }
          return <p className="py-8 text-center text-sm text-text-secondary">{t('avatars.noActivity')}</p>;
        }}
      />
    </>
  );
}
