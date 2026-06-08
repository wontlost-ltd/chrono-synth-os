import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminConfig, useAdminConfigAudit, useApplyConfigPatch } from '../api/queries/admin-config';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../hooks/useAuth';

const SECRET_KEY_PATTERN = /(secret|token|password|api[_-]?key|private)/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function AdminConfig() {
  const { t } = useTranslation();
  useDocumentTitle(t('adminConfig.title'));
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const config = useAdminConfig(isAdmin);
  const audit = useAdminConfigAudit(isAdmin);
  const patchMutation = useApplyConfigPatch();
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editIsSecret, setEditIsSecret] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isAdmin) {
    return <EmptyState variant="error" message={t('adminConfig.noPermission')} />;
  }

  if (config.isLoading) return <Skeleton variant="card" />;
  if (config.error) return <EmptyState variant="error" message={t('adminConfig.loadError', { message: config.error.message })} />;

  const grouped = new Map<string, typeof config.data>();
  for (const item of config.data ?? []) {
    const group = grouped.get(item.groupKey) ?? [];
    group.push(item);
    grouped.set(item.groupKey, group);
  }

  function startEdit(key: string, currentValue: unknown, secret: boolean) {
    setEditKey(key);
    setEditIsSecret(secret);
    if (secret) {
      setEditValue('');
    } else {
      setEditValue(typeof currentValue === 'string' ? currentValue : JSON.stringify(currentValue));
    }
    setSuccessMsg(null);
  }

  function cancelEdit() {
    setEditKey(null);
    setEditValue('');
    setEditIsSecret(false);
  }

  async function saveEdit() {
    if (!editKey) return;
    if (editIsSecret && !editValue.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(editValue); } catch { parsed = editValue; }
    try {
      const result = await patchMutation.mutateAsync({ [editKey]: parsed });
      cancelEdit();
      if (result.requiresRestart.length > 0) {
        setSuccessMsg(t('adminConfig.savedNeedsRestart', { keys: result.requiresRestart.join(', ') }));
      } else {
        setSuccessMsg(t('adminConfig.saved'));
      }
    } catch { /* mutation error displayed via patchMutation.error */ }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('adminConfig.title')} subtitle={t('adminConfig.subtitle')} />

      {successMsg && (
        <div className="rounded-lg bg-success/10 px-4 py-2 text-sm text-success" role="status">{successMsg}</div>
      )}

      {[...grouped.entries()].map(([group, items]) => (
        <div key={group} className="rounded-xl border border-border bg-surface-elevated p-6">
          <h2 className="mb-4 text-lg font-semibold text-text-primary capitalize">{group}</h2>
          <div className="divide-y divide-border">
            {items?.map(item => {
              const secret = isSecretKey(item.key);
              const displayValue = secret ? t('adminConfig.maskedValue') : String(item.value);
              return (
                <div key={item.key} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">{item.key}</p>
                    <p className="text-xs text-text-secondary">
                      {item.category}
                      {item.requiresRestart && <span className="ml-2 text-warning">{t('adminConfig.requiresRestart')}</span>}
                    </p>
                  </div>
                  {editKey === item.key ? (
                    <div className="flex items-center gap-2">
                      <input
                        type={editIsSecret ? 'password' : 'text'}
                        className="w-48 rounded border border-border px-2 py-1 text-sm"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        aria-label={t('adminConfig.editValueAria', { key: item.key })}
                        placeholder={editIsSecret ? t('adminConfig.secretPlaceholder') : undefined}
                      />
                      <button
                        onClick={saveEdit}
                        disabled={patchMutation.isPending || (editIsSecret && !editValue.trim())}
                        className="rounded bg-primary px-3 py-1 text-xs text-white hover:bg-primary-light disabled:opacity-50"
                      >
                        {t('adminConfig.save')}
                      </button>
                      <button onClick={cancelEdit} className="rounded px-3 py-1 text-xs text-text-secondary hover:bg-surface">
                        {t('adminConfig.cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <code className="max-w-xs truncate rounded bg-surface px-2 py-0.5 text-xs text-text-secondary" title={displayValue}>
                        {displayValue}
                      </code>
                      <button onClick={() => startEdit(item.key, item.value, secret)} className="text-xs text-primary hover:underline">
                        {t('adminConfig.edit')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {patchMutation.error && (
        <p className="text-sm text-warning" role="alert">{patchMutation.error.message}</p>
      )}

      <div className="rounded-xl border border-border bg-surface-elevated p-6">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">{t('adminConfig.auditTitle')}</h2>
        {audit.isLoading && <Skeleton variant="card" />}
        {audit.error && (
          <p className="text-sm text-warning" role="alert">{t('adminConfig.auditError', { message: audit.error.message })}</p>
        )}
        {!audit.error && audit.data && audit.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className="pb-2">{t('adminConfig.auditKey')}</th>
                  <th className="pb-2">{t('adminConfig.auditOldValue')}</th>
                  <th className="pb-2">{t('adminConfig.auditNewValue')}</th>
                  <th className="pb-2">{t('adminConfig.auditChangedBy')}</th>
                  <th className="pb-2">{t('adminConfig.auditChangedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((entry, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-2 font-mono text-xs">{entry.key}</td>
                    <td className="py-2 text-xs text-text-secondary">{entry.old_value_json}</td>
                    <td className="py-2 text-xs">{entry.new_value_json}</td>
                    <td className="py-2 text-xs text-text-secondary">{entry.changed_by}</td>
                    <td className="py-2 text-xs text-text-secondary">{new Date(entry.changed_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !audit.error && <p className="text-sm text-text-secondary">{t('adminConfig.noAudit')}</p>
        )}
      </div>
    </div>
  );
}
