import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { FormField } from './FormField';
import { useSimulationShares, useShareSimulation, useRevokeShare, type ShareEntry } from '../../api/queries/sharing';

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  simulationId: string;
}

const PERMISSIONS: ShareEntry['permission'][] = ['view', 'edit', 'admin'];

export function ShareModal({ open, onClose, simulationId }: ShareModalProps) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<ShareEntry['permission']>('view');
  const shares = useSimulationShares(simulationId);
  const share = useShareSimulation(simulationId);
  const revoke = useRevokeShare(simulationId);

  const handleShare = () => {
    if (!userId.trim()) return;
    share.mutate({ userId: userId.trim(), permission }, {
      onSuccess: () => setUserId(''),
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={t('sharing.title')}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <FormField label={t('sharing.userIdLabel')}>
            {(props) => (
              <input
                {...props}
                type="text"
                value={userId}
                onChange={e => setUserId(e.target.value)}
                placeholder={t('sharing.userIdPlaceholder')}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
            )}
          </FormField>
          <FormField label={t('sharing.permissionLabel')}>
            {(props) => (
              <select
                {...props}
                value={permission}
                onChange={e => setPermission(e.target.value as ShareEntry['permission'])}
                className="rounded-lg border border-border px-3 py-2 text-sm"
              >
                {PERMISSIONS.map(p => (
                  <option key={p} value={p}>{t(`sharing.permission.${p}`)}</option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        <button
          type="button"
          onClick={handleShare}
          disabled={!userId.trim() || share.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
        >
          {share.isPending ? t('common.loading') : t('sharing.invite')}
        </button>

        {shares.data && shares.data.length > 0 && (
          <div className="border-t border-border pt-3">
            <h4 className="mb-2 text-sm font-medium text-text-secondary">{t('sharing.currentShares')}</h4>
            <ul className="space-y-2">
              {shares.data.map(entry => (
                <li key={entry.id} className="flex items-center justify-between text-sm">
                  <span>{entry.targetUserName ?? entry.targetUserId}</span>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-neutral-1 px-2 py-0.5 text-xs text-text-secondary">
                      {t(`sharing.permission.${entry.permission}`)}
                    </span>
                    <button
                      type="button"
                      onClick={() => revoke.mutate(entry.id)}
                      disabled={revoke.isPending}
                      className="text-xs text-error hover:underline disabled:opacity-50"
                    >
                      {t('sharing.revoke')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
