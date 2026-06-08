import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession, type UserMode } from '../../store/session';

interface FeatureGateProps {
  required: UserMode;
  fallback?: ReactNode;
  children: ReactNode;
}

export function FeatureGate({ required, fallback, children }: FeatureGateProps) {
  const { t } = useTranslation();
  const session = useSession();

  if (required === 'subscriber' && session.mode !== 'subscriber') {
    return fallback ? <>{fallback}</> : (
      <div className="rounded-xl border border-accent/30 bg-accent/5 p-6 text-center" role="status">
        <p className="font-medium text-accent">{t('featureGate.subscriptionRequired')}</p>
        <p className="mt-1 text-sm text-text-secondary">{t('featureGate.upgradePrompt')}</p>
        <Link to="/billing" className="mt-3 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-light">
          {t('featureGate.viewPlans')}
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
