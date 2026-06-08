import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Modal } from '../../../components/ui/Modal';
import { useAvatars, useCreateAvatar, useDeleteAvatar, type Avatar } from '../../../api/queries/avatars';
import { AvatarForm } from '../components/AvatarForm';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

export default function AvatarListPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('avatars.title'));
  const { data: avatars, isLoading, error } = useAvatars();
  const createAvatar = useCreateAvatar();
  const deleteAvatar = useDeleteAvatar();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  const columns: Column<Avatar>[] = [
    { id: 'label', header: t('avatars.colLabel'), cell: row => <span className="font-medium">{row.label}</span> },
    { id: 'kind', header: t('avatars.colKind'), cell: row => t(`avatars.kind.${row.kind}`) },
    { id: 'status', header: t('avatars.colStatus'), cell: row => {
      const s = row.status === 'active' ? 'active' : row.status === 'paused' ? 'paused' : 'offline';
      return <StatusBadge status={s} />;
    }},
    { id: 'createdAt', header: t('avatars.colCreated'), cell: row => new Date(row.createdAt).toLocaleDateString() },
  ];

  return (
    <>
      <PageHeader
        title={t('avatars.title')}
        subtitle={t('avatars.subtitle')}
        actions={
          <button onClick={() => setShowCreate(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            {t('avatars.create')}
          </button>
        }
      />

      {error ? (
        <EmptyState variant="error" message={t('avatars.loadError', { message: error.message })} />
      ) : (
        <DataTable
          rows={avatars ?? []}
          columns={columns}
          getRowId={r => r.id}
          loading={isLoading}
          emptyState={
            <EmptyState
              illustration="personas"
              title={t('avatars.emptyTitle')}
              message={t('avatars.emptyDescription')}
              primaryAction={{
                label: t('avatars.emptyAction'),
                onClick: () => setShowCreate(true),
              }}
            />
          }
          rowActions={row => (
            <div className="flex gap-2">
              <button onClick={() => navigate(`/avatars/${row.id}`)} className="text-sm text-primary hover:underline">
                {t('avatars.view')}
              </button>
              <button
                onClick={() => { if (confirm(t('avatars.confirmDelete'))) deleteAvatar.mutate(row.id); }}
                className="text-sm text-warning hover:underline"
              >
                {t('avatars.delete')}
              </button>
            </div>
          )}
        />
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t('avatars.createTitle')}>
        <AvatarForm
          onSubmit={data => createAvatar.mutate(data, { onSuccess: () => setShowCreate(false) })}
          loading={createAvatar.isPending}
        />
      </Modal>
    </>
  );
}
