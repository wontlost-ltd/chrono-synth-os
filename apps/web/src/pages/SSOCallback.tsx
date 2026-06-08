import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { setSession } from '../store/session';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function decodeJwtPayload(token: string): { sub: string; tenantId?: string; role?: string } | null {
  const rawB64 = token.split('.')[1];
  if (!rawB64) return null;
  const payloadB64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = payloadB64.padEnd(payloadB64.length + (4 - (payloadB64.length % 4)) % 4, '=');
  try {
    return JSON.parse(atob(padded)) as { sub: string; tenantId?: string; role?: string };
  } catch {
    return null;
  }
}

function clearSensitive(): void {
  window.history.replaceState(null, '', window.location.pathname);
}

/**
 * SSO 回调页面
 * Auth0 授权完成后重定向回此页面，从 URL fragment 中提取 token
 */
export function SSOCallback() {
  const { t } = useTranslation();
  useDocumentTitle(t('sso.processing'));
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');

    /* refreshToken 由后端通过 HttpOnly cookie 设置，不再从 URL 提取 */
    if (!accessToken) {
      clearSensitive();
      setError(t('sso.missingTokens'));
      return;
    }

    const payload = decodeJwtPayload(accessToken);
    if (!payload?.sub) {
      clearSensitive();
      setError(t('sso.parseError'));
      return;
    }

    setSession({
      accessToken,
      tenantId: payload.tenantId ?? 'default',
      mode: 'subscriber',
      user: {
        userId: payload.sub,
        email: payload.sub,
        role: payload.role ?? 'member',
      },
    });

    clearSensitive();
    navigate('/dashboard', { replace: true });
  }, [navigate, t]);

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-surface-elevated p-8 text-center shadow-sm">
          <p className="text-sm text-warning">{error}</p>
          <button
            type="button"
            onClick={() => navigate('/login', { replace: true })}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
          >
            {t('sso.backToLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-elevated p-8 text-center shadow-sm">
        <p className="text-sm text-text-secondary">{t('sso.processing')}</p>
      </div>
    </div>
  );
}
