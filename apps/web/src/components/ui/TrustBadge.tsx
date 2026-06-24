/**
 * 信任徽章 — 区分 AI 发起 vs 用户发起的操作
 */
import { useTranslation } from 'react-i18next';

export type InitiatorType = 'ai' | 'user' | 'system';

interface TrustBadgeProps {
  initiator: InitiatorType;
  compact?: boolean;
}

const BADGE_CONFIG: Record<InitiatorType, { bg: string; text: string; key: string }> = {
  ai: { bg: 'bg-accent/10 border-accent/30', text: 'text-accent', key: 'trustBadge.ai' },
  user: { bg: 'bg-primary/10 border-primary/30', text: 'text-primary', key: 'trustBadge.user' },
  system: { bg: 'bg-text-secondary/10 border-border', text: 'text-text-secondary', key: 'trustBadge.system' },
};

export function TrustBadge({ initiator, compact = false }: TrustBadgeProps) {
  const { t } = useTranslation();
  const config = BADGE_CONFIG[initiator];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${config.bg} ${config.text} ${compact ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-0.5 text-xs'} font-medium`}
      role="status"
    >
      {initiator === 'ai' && <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />}
      {t(config.key)}
    </span>
  );
}
