/**
 * Design tokens v2 — semantic, theme-aware, math-driven.
 *
 * v1 (chronoDesignTokens in ../index.ts) remains exported for backward
 * compatibility; new code should import from this v2 entry. v1 will
 * be deprecated once all consumers migrate.
 */

export * from './colors.js';
export * from './typography.js';
export * from './spacing.js';
export * from './motion.js';

import { colorTokensLight, colorTokensDark, colorTokensHighContrast, colorTokensCompanion } from './colors.js';
import { duration, easing, spring } from './motion.js';
import { space, radius, shadow, baseUnit, size } from './spacing.js';
import { display, heading, body, mono, fontFamilies } from './typography.js';

/**
 * The full v2 token set, indexed by theme. Consumers typically pick a
 * theme at app bootstrap and pass `tokensV2.themes[theme]` into a
 * provider; the rest of the constants (typography, spacing, motion) are
 * theme-independent.
 */
export const tokensV2 = {
  themes: {
    light: { color: colorTokensLight },
    dark: { color: colorTokensDark },
    'high-contrast': { color: colorTokensHighContrast },
    /* ChronoCompanion C 端暖调主题（ADR-0046 D3 统一底座；单暗色主题）。 */
    companion: { color: colorTokensCompanion },
  },
  typography: {
    families: fontFamilies,
    display,
    heading,
    body,
    mono,
  },
  spacing: { baseUnit, space, radius, shadow, size },
  motion: { duration, easing, spring },
} as const;

export type DesignTokenTheme = keyof typeof tokensV2.themes;
