import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api/client';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/**
 * GitHub App 安装完成回调页（前端落地页）。
 *
 * **为什么需要这一页**：后端回调端点要求已登录（无 HMAC 可验，必须靠会话身份定租户）。
 * 但本应用的 access token 存在 JS 内存里、只有 refresh token 是 HttpOnly cookie——
 * GitHub 安装完成后**直接跳浏览器**到 setup_url 时，请求不带 Authorization 头，
 * 用户会撞上一个裸 JSON 401，流程断在这里。
 *
 * 故 setup_url 指向本前端路由：本页读 URL 里的 installation_id，用**当前会话**
 * （apiFetch 会自动带 token，401 时还会走 refresh 重试）调后端回调端点完成绑定。
 * 后端的鉴权要求丝毫不放松——只是把「谁来发这个请求」从浏览器裸跳转换成已认证的前端调用。
 */
export function GithubSetupCallback() {
  const { t } = useTranslation();
  useDocumentTitle(t('githubSetup.title'));
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const installationId = params.get('installation_id');

  const [state, setState] = useState<'pending' | 'done' | 'error'>('pending');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /* StrictMode 下 effect 会跑两次——用 ref 防重复提交（upsert 幂等，但没必要多发一次）。 */
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;

    if (!installationId) {
      setState('error');
      setErrorMsg(t('githubSetup.missingParam'));
      return;
    }
    const qs = new URLSearchParams({ installation_id: installationId });
    const setupAction = params.get('setup_action');
    if (setupAction) qs.set('setup_action', setupAction);

    apiFetch<unknown>(`/api/v1/integrations/github/setup?${qs.toString()}`)
      .then(() => setState('done'))
      .catch((err: Error) => {
        setState('error');
        setErrorMsg(err.message);
      });
  }, [installationId, params, t]);

  if (state === 'pending') {
    return (
      <div className="space-y-6">
        <PageHeader title={t('githubSetup.title')} />
        <Skeleton variant="card" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-6">
        <PageHeader title={t('githubSetup.title')} />
        <EmptyState variant="error" message={errorMsg ?? t('githubSetup.failed')} />
        <Button variant="secondary" onClick={() => navigate('/admin/github')} data-testid="github-setup-back">
          {t('githubSetup.backToSettings')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('githubSetup.title')} />
      <div
        role="status"
        data-testid="github-setup-success"
        className="rounded-xl border border-success/40 bg-success/10 p-4 text-sm text-success"
      >
        {t('githubSetup.success', { installationId })}
      </div>
      <Button onClick={() => navigate('/admin/github')} data-testid="github-setup-continue">
        {t('githubSetup.backToSettings')}
      </Button>
    </div>
  );
}
