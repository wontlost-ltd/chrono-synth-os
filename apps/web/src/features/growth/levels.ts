/**
 * Capability levels (P3.7).
 *
 * Users progressively unlock features as they accumulate days of use.
 * The mapping below is the source-of-truth for which feature lights up
 * at which level. Components gate themselves via `useUserLevel()` +
 * `<LockedFeature requires="L3" />`.
 *
 * Level boundaries are deliberately conservative — features unlock when
 * the user actually needs them, not when they merely *could* see them.
 * Tightens the discovery gradient so dashboards don't drown new users
 * in admin surface.
 */

export type CapabilityLevel = 'L1' | 'L2' | 'L3' | 'L4';

export interface LevelDefinition {
  id: CapabilityLevel;
  /** Translation key for the level name */
  labelKey: string;
  /** Translation key for what unlocked at this level */
  descriptionKey: string;
  /** Days of use required to reach this level */
  minDaysOfUse: number;
  /** Capabilities unlocked AT this level (not cumulative — for display) */
  unlocks: ReadonlyArray<string>;
}

export const LEVELS: ReadonlyArray<LevelDefinition> = [
  {
    id: 'L1',
    labelKey: 'growth.levels.L1.label',
    descriptionKey: 'growth.levels.L1.description',
    minDaysOfUse: 0,
    unlocks: ['personas', 'conversation'],
  },
  {
    id: 'L2',
    labelKey: 'growth.levels.L2.label',
    descriptionKey: 'growth.levels.L2.description',
    minDaysOfUse: 3,
    unlocks: ['simulations', 'memory_graph'],
  },
  {
    id: 'L3',
    labelKey: 'growth.levels.L3.label',
    descriptionKey: 'growth.levels.L3.description',
    minDaysOfUse: 7,
    unlocks: ['agent_tools', 'oauth_authorizations'],
  },
  {
    id: 'L4',
    labelKey: 'growth.levels.L4.label',
    descriptionKey: 'growth.levels.L4.description',
    minDaysOfUse: 30,
    unlocks: ['multi_persona', 'governance', 'admin_console'],
  },
];

/** Compute the user's current level from days-of-use. Pure for testability. */
export function computeLevel(daysOfUse: number): CapabilityLevel {
  let current: CapabilityLevel = 'L1';
  for (const lvl of LEVELS) {
    if (daysOfUse >= lvl.minDaysOfUse) {
      current = lvl.id;
    }
  }
  return current;
}

/** Is `feature` unlocked at the given level? */
export function isUnlocked(level: CapabilityLevel, feature: string): boolean {
  const targetIdx = LEVELS.findIndex((l) => l.id === level);
  if (targetIdx < 0) return false;
  for (let i = 0; i <= targetIdx; i++) {
    const def = LEVELS[i];
    if (!def) continue;
    if (def.unlocks.includes(feature)) return true;
  }
  return false;
}

/** Days until the next level unlocks, or null if at max. */
export function daysUntilNextLevel(daysOfUse: number): number | null {
  for (const lvl of LEVELS) {
    if (lvl.minDaysOfUse > daysOfUse) {
      return lvl.minDaysOfUse - daysOfUse;
    }
  }
  return null;
}
