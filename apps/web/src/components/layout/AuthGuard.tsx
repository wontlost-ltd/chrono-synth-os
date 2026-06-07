import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { refreshAccessToken } from '../../api/client';

interface AuthGuardProps {
  children: ReactNode;
}

/** 路由守卫：先尝试 cookie 刷新恢复会话，未认证用户重定向到登录页 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();
  const [checking, setChecking] = useState(!isAuthenticated);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      if (isAuthenticated) {
        setChecking(false);
        return;
      }
      await refreshAccessToken();
      if (!cancelled) setChecking(false);
    }
    bootstrap();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  if (checking) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-text-secondary" role="status" aria-live="polite">
        {t('common.loading')}
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
