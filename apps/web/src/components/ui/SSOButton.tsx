import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config';

/**
 * OIDC 登录按钮
 * 通过 tenant-aware OIDC login 入口跳转到后端授权端点
 */
export function buildOidcLoginUrl(tenantId: string, redirectPath = '/sso/callback'): string {
  const params = new URLSearchParams({
    redirect_uri: redirectPath,
    tenant_id: tenantId.trim(),
  });
  return `${API_BASE_URL}/api/v1/auth/oidc/login?${params.toString()}`;
}

export function SSOButton({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const normalizedTenantId = tenantId.trim();

  function handleClick() {
    if (!normalizedTenantId) return;
    try { localStorage.setItem('chrono-sso-tenant-id', normalizedTenantId); } catch { /* ignore */ }
    window.location.href = buildOidcLoginUrl(normalizedTenantId);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!normalizedTenantId}
      className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-elevated"
    >
      {normalizedTenantId ? t('sso.signInWithSSO') : t('sso.enterTenantFirst')}
    </button>
  );
}
