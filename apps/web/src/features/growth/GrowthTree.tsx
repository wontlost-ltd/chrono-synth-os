/**
 * GrowthTree — visual capability ladder showing L1→L4.
 *
 * Renders a vertical chain of nodes with the user's current level
 * highlighted. Locked nodes are dimmed and aria-disabled; the active
 * node pulses (gated on reduced-motion). The "edges" between nodes
 * fill proportionally to the user's progress toward the next level.
 *
 * Pure presentation — pulls state from useUserLevel(), no I/O.
 */

import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { LEVELS, type CapabilityLevel } from './levels';
import { useUserLevel } from './useUserLevel';
import './GrowthTree.css';

const RANK: Record<CapabilityLevel, number> = { L1: 0, L2: 1, L3: 2, L4: 3 };

export function GrowthTree() {
  const { t } = useTranslation();
  const { level, daysOfUse, daysUntilNext } = useUserLevel();
  const reducedMotion = useReducedMotion();

  const currentIdx = RANK[level];
  const nextLevel = LEVELS[currentIdx + 1];

  /* Edge fill ratio: 0 → just reached current level, 1 → about to unlock next.
   * If at max level, all edges full. */
  const edgeFill = useMemo(() => {
    if (!nextLevel) return 1;
    const span = nextLevel.minDaysOfUse - LEVELS[currentIdx]!.minDaysOfUse;
    if (span <= 0) return 1;
    const progressed = daysOfUse - LEVELS[currentIdx]!.minDaysOfUse;
    return Math.max(0, Math.min(1, progressed / span));
  }, [currentIdx, daysOfUse, nextLevel]);

  return (
    <div
      className={`growth-tree ${reducedMotion ? 'reduced-motion' : ''}`}
      role="list"
      aria-label={t('growth.tree.label')}
    >
      {LEVELS.map((lvl, idx) => {
        const state = idx < currentIdx ? 'completed' : idx === currentIdx ? 'current' : 'locked';
        const isLast = idx === LEVELS.length - 1;
        const fill = idx < currentIdx ? 1 : idx === currentIdx ? edgeFill : 0;

        return (
          <div key={lvl.id} className="growth-tree-row" role="listitem">
            <div className="growth-tree-node-col">
              <div
                className={`growth-tree-node growth-tree-node-${state}`}
                aria-current={state === 'current' ? 'step' : undefined}
                aria-disabled={state === 'locked' || undefined}
              >
                <span className="growth-tree-node-id">{lvl.id}</span>
              </div>
              {!isLast && (
                <div className="growth-tree-edge" aria-hidden="true">
                  <div
                    className="growth-tree-edge-fill"
                    style={{ transform: `scaleY(${fill})` }}
                  />
                </div>
              )}
            </div>

            <div className="growth-tree-meta">
              <h3 className="growth-tree-title">{t(lvl.labelKey)}</h3>
              <p className="growth-tree-description">{t(lvl.descriptionKey)}</p>
              <ul className="growth-tree-unlocks">
                {lvl.unlocks.map((feature) => (
                  <li key={feature}>{t(`growth.unlocks.${feature}`, feature)}</li>
                ))}
              </ul>
              {state === 'current' && nextLevel && daysUntilNext != null && (
                <p className="growth-tree-progress">
                  {t('growth.tree.daysUntilNext', { count: daysUntilNext })}
                </p>
              )}
              {state === 'current' && !nextLevel && (
                <p className="growth-tree-progress">{t('growth.tree.maxReached')}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
