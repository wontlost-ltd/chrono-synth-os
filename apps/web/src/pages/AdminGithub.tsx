import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useGithubAppStatus, useConnectGithubApp, useDisconnectGithubApp,
} from '../api/queries/admin-github';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../hooks/useAuth';

/**
 * GitHub App 连接管理页（安装入口产品化的前端）。
 *
 * 此前把 App 装进系统只能 SSH 登服务器跑 scripts/connect-github.ts。本页把它变成两步：
 *   ① 在此录一次凭据（appId + 私钥 PEM + webhook secret）；
 *   ② 到 GitHub 安装 App，安装完成后的 setup_url 回调自动记 installation → 租户映射。
 *
 * **私钥只上行不下行**：录入后服务端加密落库，状态接口绝不回显私钥——故本页
 * 在「已连接」状态下不显示也无法显示私钥，只显示 appId 与 installation 列表。
 */
export function AdminGithub() {
  const { t } = useTranslation();
  useDocumentTitle(t('adminGithub.title'));
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const status = useGithubAppStatus(isAdmin);
  const connect = useConnectGithubApp();
  const disconnect = useDisconnectGithubApp();

  const [appId, setAppId] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isAdmin) {
    return <EmptyState variant="error" message={t('adminGithub.noPermission')} />;
  }
  if (status.isLoading) return <Skeleton variant="card" />;
  if (status.error) {
    return <EmptyState variant="error" message={t('adminGithub.loadError', { message: status.error.message })} />;
  }

  const data = status.data;
  const configured = data?.configured === true;

  function submitConnect(e: React.FormEvent): void {
    e.preventDefault();
    setFormError(null);
    setSuccessMsg(null);
    /* 前端预校验：私钥须含 PEM 头——挡住粘错内容（如粘了公钥或 App ID），
     * 与服务端 zod refine 同款判据，让用户不必等一次往返才知道粘错了。 */
    if (!privateKeyPem.includes('PRIVATE KEY')) {
      setFormError(t('adminGithub.errors.pemFormat'));
      return;
    }
    connect.mutate(
      { appId: appId.trim(), privateKeyPem, webhookSecret: webhookSecret.trim() },
      {
        onSuccess: () => {
          setSuccessMsg(t('adminGithub.connectSuccess'));
          /* 成功即清空表单——私钥不在前端多留一刻。 */
          setAppId('');
          setPrivateKeyPem('');
          setWebhookSecret('');
        },
        onError: (err: Error) => setFormError(err.message),
      },
    );
  }

  function submitDisconnect(): void {
    setFormError(null);
    setSuccessMsg(null);
    disconnect.mutate(undefined, {
      onSuccess: () => setSuccessMsg(t('adminGithub.disconnectSuccess')),
      onError: (err: Error) => setFormError(err.message),
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('adminGithub.title')} subtitle={t('adminGithub.description')} />

      {successMsg && (
        <div role="status" className="rounded-lg border border-success/40 bg-success/10 px-4 py-2 text-sm text-success">
          {successMsg}
        </div>
      )}
      {formError && (
        <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {formError}
        </div>
      )}

      {/* 连接状态 */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('adminGithub.status.heading')}</h2>
        {configured ? (
          <div className="space-y-3">
            <p data-testid="github-status" className="text-sm text-success">
              {t('adminGithub.status.connected', { appId: data?.appId ?? '' })}
            </p>

            <div>
              <h3 className="mb-2 text-xs font-medium text-text-secondary">
                {t('adminGithub.installations.heading')}
              </h3>
              {(data?.installations.length ?? 0) === 0 ? (
                <p data-testid="github-no-installations" className="text-xs text-text-secondary">
                  {t('adminGithub.installations.empty')}
                </p>
              ) : (
                <ul data-testid="github-installations" className="space-y-1.5">
                  {data?.installations.map((inst) => (
                    <li key={inst.installationId} className="rounded-lg bg-bg px-3 py-2 text-xs">
                      <span className="font-mono text-text-primary">#{inst.installationId}</span>
                      {inst.account && <span className="ml-2 text-text-secondary">{inst.account}</span>}
                      {inst.suspendedAt !== null && (
                        <span className="ml-2 rounded bg-warning/20 px-1.5 py-0.5 text-warning">
                          {t('adminGithub.installations.suspended')}
                        </span>
                      )}
                      {inst.repos && (
                        <div className="mt-1 text-text-secondary">
                          {t('adminGithub.installations.repos', { repos: inst.repos })}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button
              variant="danger"
              size="sm"
              onClick={submitDisconnect}
              disabled={disconnect.isPending}
              data-testid="github-disconnect"
            >
              {t('adminGithub.disconnect')}
            </Button>
          </div>
        ) : (
          <p data-testid="github-status" className="text-sm text-text-secondary">
            {t('adminGithub.status.notConnected')}
          </p>
        )}
      </section>

      {/* 录凭据表单（未连接时显示） */}
      {!configured && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold text-text-primary">{t('adminGithub.connect.heading')}</h2>
          <p className="mb-4 text-xs text-text-secondary">{t('adminGithub.connect.hint')}</p>

          <form onSubmit={submitConnect} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="gh-app-id" className="block text-xs font-medium text-text-primary">
                {t('adminGithub.fields.appId')}
              </label>
              <input
                id="gh-app-id"
                data-testid="github-app-id"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                required
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="gh-pem" className="block text-xs font-medium text-text-primary">
                {t('adminGithub.fields.privateKey')}
              </label>
              <textarea
                id="gh-pem"
                data-testid="github-private-key"
                value={privateKeyPem}
                onChange={(e) => setPrivateKeyPem(e.target.value)}
                required
                rows={6}
                placeholder="-----BEGIN RSA PRIVATE KEY-----"
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-text-primary"
              />
              <p className="text-xs text-text-secondary">{t('adminGithub.fields.privateKeyHint')}</p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="gh-webhook-secret" className="block text-xs font-medium text-text-primary">
                {t('adminGithub.fields.webhookSecret')}
              </label>
              <input
                id="gh-webhook-secret"
                data-testid="github-webhook-secret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                required
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
              />
            </div>

            <Button type="submit" disabled={connect.isPending} data-testid="github-connect-submit">
              {connect.isPending ? t('adminGithub.connecting') : t('adminGithub.connect.submit')}
            </Button>
          </form>
        </section>
      )}
    </div>
  );
}
