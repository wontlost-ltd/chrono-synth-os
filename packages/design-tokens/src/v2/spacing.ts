/**
 * Spacing scale — 4px base unit, 8px primary grid.
 *
 * Use the named tokens in components rather than raw pixel values.
 * Designers can adjust the scale globally without touching the code.
 *
 * The numeric suffix is the multiplier of the base unit (4px).
 *   space.2 = 8px   (the primary grid step)
 *   space.4 = 16px  (default gap between sibling elements)
 *   space.8 = 32px  (section break)
 */

export const baseUnit = 4 as const;

/**
 * Interactive target sizes. The 44px touch target is the WCAG 2.5.5
 * (AAA) recommendation and matches both Apple HIG (44pt) and Material
 * Design (48dp ≈ 44px on standard density). Below this size, fingers
 * on touch devices miss the target frequently enough to count as an
 * accessibility regression — including for users with motor
 * impairments using mouse pointers.
 *
 * Apply via `min-height: var(--size-touch-target)` (or `min-h-touch`
 * once the Tailwind plugin is wired). Padding alone is not enough;
 * the hit-test rectangle must be ≥44×44.
 */
export const size = {
  touchTarget: '44px',
  /* Reduced target for dense control rows (data tables) where space
   * is at a premium AND the row itself is the hit target. Components
   * using this MUST verify the parent row is ≥44px tall. */
  touchTargetDense: '36px',
} as const;

export const space = {
  0:  0,
  '0.5': 2,  // micro adjustments only
  1:  4,
  '1.5': 6,
  2:  8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export type SpaceKey = keyof typeof space;

/** Border radius scale. */
export const radius = {
  none: 0,
  sm: 2,
  md: 4,
  lg: 8,
  xl: 12,
  '2xl': 16,
  full: 9999,
} as const;

/** Shadow scale — soft to hard, increasing depth. */
export const shadow = {
  none: 'none',
  sm: '0 1px 2px 0 rgba(15, 23, 42, 0.05)',
  md: '0 4px 6px -1px rgba(15, 23, 42, 0.10), 0 2px 4px -2px rgba(15, 23, 42, 0.05)',
  lg: '0 10px 15px -3px rgba(15, 23, 42, 0.10), 0 4px 6px -4px rgba(15, 23, 42, 0.05)',
  xl: '0 20px 25px -5px rgba(15, 23, 42, 0.15), 0 8px 10px -6px rgba(15, 23, 42, 0.10)',
  /* Elastic shadow for floating UI; intentionally tighter + tinted brand-blue. */
  elastic: '0 8px 24px -8px rgba(30, 58, 138, 0.30)',
} as const;
