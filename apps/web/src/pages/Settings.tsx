import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useProfile, useChangePassword } from '../api/queries/user';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export function Settings() {
  const { t } = useTranslation();
  useDocumentTitle(t('settings.title'));
  const isOnline = useOnlineStatus();
  const { data: profile, isLoading, error } = useProfile();
  const changePassword = useChangePassword();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState(false);

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) { setPwdError(t('settings.passwordTooShort')); return; }
    if (newPassword !== confirmPassword) { setPwdError(t('settings.passwordMismatch')); return; }
    setPwdError(null);
    setPwdSuccess(false);
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      setPwdSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : t('settings.passwordChangeError'));
    }
  }

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      {error ? (
        <EmptyState variant="error" message={t('settings.loadError', { message: error.message })} />
      ) : isLoading ? (
        <div className="space-y-4">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : profile ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-surface-elevated p-4">
            <h3 className="mb-3 text-sm font-medium text-text-secondary">{t('settings.profileTitle')}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <span className="text-xs text-text-secondary">{t('settings.emailLabel')}</span>
                <p className="text-sm font-medium">{profile.email}</p>
              </div>
              <div>
                <span className="text-xs text-text-secondary">{t('settings.roleLabel')}</span>
                <p className="text-sm font-medium">{profile.role}</p>
              </div>
              <div>
                <span className="text-xs text-text-secondary">{t('settings.tenantLabel')}</span>
                <p className="text-sm font-medium">{profile.tenantId}</p>
              </div>
              <div>
                <span className="text-xs text-text-secondary">{t('settings.createdAtLabel')}</span>
                <p className="text-sm font-medium">{new Date(profile.createdAt).toLocaleDateString()}</p>
              </div>
            </div>
          </div>

          <form onSubmit={handlePasswordChange} className="rounded-xl border border-border bg-surface-elevated p-4">
            <h3 className="mb-3 text-sm font-medium text-text-secondary">{t('settings.changePasswordTitle')}</h3>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-text-secondary">{t('settings.currentPasswordLabel')}</span>
                <input
                  type="password"
                  className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
                  value={currentPassword}
                  onChange={e => { setCurrentPassword(e.target.value); setPwdError(null); }}
                  required
                />
              </label>
              <label className="block">
                <span className="text-xs text-text-secondary">{t('settings.newPasswordLabel')}</span>
                <input
                  type="password"
                  className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
                  value={newPassword}
                  onChange={e => { setNewPassword(e.target.value); setPwdError(null); }}
                  minLength={8}
                  required
                />
              </label>
              <label className="block">
                <span className="text-xs text-text-secondary">{t('settings.confirmPasswordLabel')}</span>
                <input
                  type="password"
                  className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
                  value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); setPwdError(null); }}
                  minLength={8}
                  required
                />
              </label>
            </div>
            {pwdError && (
              <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-2 text-sm text-warning" role="alert">
                {pwdError}
              </div>
            )}
            {pwdSuccess && (
              <div className="mt-3 rounded-lg border border-success/30 bg-success/5 p-2 text-sm text-success" role="status">
                {t('settings.passwordChanged')}
              </div>
            )}
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={changePassword.isPending || !isOnline}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
                aria-describedby={!isOnline ? 'settings-offline-hint' : undefined}
              >
                {changePassword.isPending ? t('common.loading') : t('settings.changePasswordButton')}
              </button>
              {!isOnline && <span id="settings-offline-hint" className="text-xs text-warning">{t('common.offline')}</span>}
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
