/**
 * LockedFeature — gate a feature behind a capability level.
 *
 * When the user's level is below the requirement, renders a friendly
 * "still locked" surface that tells them how many days until unlock.
 * When unlocked, renders children.
 *
 * Use sparingly — most features should be discoverable, not gated.
 * This is for power-user surfaces (admin, multi-persona, governance)
 * that overwhelm new users when they're surfaced too early.
 */

import { useTranslation } from 'react-i18next';
import { useUserLevel } from './useUserLevel';
import type { CapabilityLevel } from './levels';

interface LockedFeatureProps {
  /** Required level. Children render only when user's level ≥ this. */
  requires: CapabilityLevel;
  children: React.ReactNode;
  /** Optional override — render nothing instead of the locked surface. */
  hideWhenLocked?: boolean;
}

const LEVEL_ORDER: ReadonlyArray<CapabilityLevel> = ['L1', 'L2', 'L3', 'L4'];

function levelMeets(actual: CapabilityLevel, required: CapabilityLevel): boolean {
  return LEVEL_ORDER.indexOf(actual) >= LEVEL_ORDER.indexOf(required);
}

export function LockedFeature({ requires, children, hideWhenLocked }: LockedFeatureProps) {
  const { t } = useTranslation();
  const { level, daysUntilNext } = useUserLevel();

  if (levelMeets(level, requires)) {
    return <>{children}</>;
  }

  if (hideWhenLocked) return null;

  return (
    <div
      role="status"
      className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center"
    >
      <div aria-hidden className="mx-auto mb-3 h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-text-primary">
        {t('growth.locked.title', { level: requires })}
      </h2>
      <p className="mt-1 max-w-md mx-auto text-sm text-text-secondary">
        {daysUntilNext !== null
          ? t('growth.locked.daysRemaining', { count: daysUntilNext })
          : t('growth.locked.body')}
      </p>
    </div>
  );
}
