import { useTranslation } from 'react-i18next';

interface SkeletonProps {
  variant?: 'card' | 'chart' | 'table';
  className?: string;
}

export function Skeleton({ variant = 'card', className = '' }: SkeletonProps) {
  const { t } = useTranslation();
  const heights: Record<string, string> = {
    card: 'h-24',
    chart: 'h-64',
    table: 'h-40',
  };

  return (
    <div
      className={`skeleton-shimmer rounded-xl border border-border ${heights[variant]} ${className}`}
      role="status"
      aria-label={t('common.loading')}
    >
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
}
