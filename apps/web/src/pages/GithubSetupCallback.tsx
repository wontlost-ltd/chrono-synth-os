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
  /* ⚠️ 审计 #416：此前是**布尔** ref，置 true 后永不重置。
   *
   * 但依赖列表 `[installationId, ...]` 表明设计意图是随新 installation 重跑 ——
   * 查询串变化而组件未 remount 时（用户给 org A 装完紧接着装 org B），
   * effect 重跑却撞守卫 `return`，**后端只记录了 A**；而下方成功横幅用的是
   * **新的** installationId ⇒ 页面显示「installation #B 已绑定」，
   * 实际 org B 的仓库**永远不同步，全程无任何报错**。
   * 守卫和渲染读的是两个不同的事实源。
   *
   * 改为**按值记**：只有「同一个 installationId 已提交过」才跳过。
   * StrictMode 双跑仍被挡住（同值），换了 id 则正常重跑。 */
  const submittedId = useRef<string | null>(null);

  useEffect(() => {
    if (!installationId) {
      setState('error');
      setErrorMsg(t('githubSetup.missingParam'));
      return;
    }
    if (submittedId.current === installationId) return;
    submittedId.current = installationId;
    /* 换了新 installation ⇒ 回到 pending，别让上一次的 done/error 残留在界面上。 */
    setState('pending');
    setErrorMsg(null);

    const qs = new URLSearchParams({ installation_id: installationId });
    const setupAction = params.get('setup_action');
    if (setupAction) qs.set('setup_action', setupAction);

    /* 卸载/换 id 后到达的响应不得再 setState（此前无条件 setState，卸载后会告警）。 */
    let cancelled = false;
    apiFetch<unknown>(`/api/v1/integrations/github/setup?${qs.toString()}`)
      .then(() => { if (!cancelled) setState('done'); })
      .catch((err: Error) => {
        if (cancelled) return;
        setState('error');
        setErrorMsg(err.message);
      });
    return () => { cancelled = true; };
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
