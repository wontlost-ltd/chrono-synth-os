/**
 * LevelUpCelebration — modal that fires when the user crosses a capability
 * level boundary. Shows the new level name, a one-line description of what
 * unlocked, and CTA buttons.
 *
 * Confetti is pure CSS — twelve absolutely-positioned spans drift down with
 * staggered animation delays. Respects prefers-reduced-motion: when the
 * user has opted out, we render the content but skip the animation.
 */

import { useTranslation } from 'react-i18next';
import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { LEVELS } from './levels';
import { useLevelUpCelebration } from './useLevelUpCelebration';
import './LevelUpCelebration.css';

const CONFETTI_COUNT = 12;

export function LevelUpCelebration() {
  const { t } = useTranslation();
  const { pending, acknowledge } = useLevelUpCelebration();
  const reducedMotion = useReducedMotion();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pending) closeRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') acknowledge();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, acknowledge]);

  if (!pending) return null;

  const def = LEVELS.find((l) => l.id === pending.to);
  if (!def) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'var(--color-overlay, rgba(0,0,0,0.5))' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="levelup-title"
    >
      {!reducedMotion && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          {Array.from({ length: CONFETTI_COUNT }, (_, i) => (
            <span
              key={i}
              className={`levelup-confetti levelup-confetti-${(i % 4) + 1}`}
              style={{
                left: `${(i / CONFETTI_COUNT) * 100}%`,
                animationDelay: `${i * 80}ms`,
              }}
            />
          ))}
        </div>
      )}

      <div className="relative max-w-md rounded-2xl bg-surface-elevated p-8 shadow-xl">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">
          {t('growth.celebration.eyebrow')}
        </div>
        <h2 id="levelup-title" className="mb-2 text-2xl font-semibold text-text-primary">
          {t('growth.celebration.title', { level: t(def.labelKey) })}
        </h2>
        <p className="mb-6 text-text-secondary">
          {t(def.descriptionKey)}
        </p>

        <ul className="mb-6 space-y-1 text-sm text-text-primary" aria-label={t('growth.celebration.unlocksLabel')}>
          {def.unlocks.map((feature) => (
            <li key={feature} className="flex items-center gap-2">
              <span aria-hidden="true" className="text-primary">●</span>
              {t(`growth.unlocks.${feature}`, feature)}
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            ref={closeRef}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onClick={acknowledge}
          >
            {t('growth.celebration.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
