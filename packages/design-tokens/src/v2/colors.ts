/**
 * Design tokens v2 — semantic colour layer.
 *
 * v1 (chronoDesignTokens) was a flat set of "name → hex" pairs. v2 is
 * intentionally semantic: each token names *what it means* rather than
 * *what it looks like*. Two themes (light, dark) supply concrete values
 * for the same set of semantic keys; consumers reference the keys, never
 * raw hex.
 *
 * Mapping to CSS custom properties: each token surfaces as
 * `--chrono-color-<dotted-path>` (lowercase + dots → hyphens). The
 * accompanying `themes/*.css` file in chrono-synth-web emits these as
 * :root and [data-theme="dark"] selectors.
 */

interface SemanticColors {
  /** Page-level surfaces, ordered light → elevated. */
  surface: {
    canvas: string;          // page background
    elevated: string;        // cards, modals
    overlay: string;         // dialog backdrop tint
    inverse: string;         // for inverted surfaces (toasts, dark menus)
  };
  /** Foreground text, ordered primary → tertiary. */
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    inverse: string;
    link: string;
  };
  /** Borders, ordered low → high contrast. */
  border: {
    subtle: string;
    default: string;
    strong: string;
    focus: string;
  };
  /** Brand */
  brand: {
    primary: string;
    primaryHover: string;
    primaryActive: string;
    accent: string;
  };
  /** Status — semantic intent, not raw colour names. */
  status: {
    success: string;
    warning: string;
    danger: string;
    info: string;
  };
  /** Chart palette — 6 hues with predictable order. */
  chart: [string, string, string, string, string, string];
}

export const colorTokensLight: SemanticColors = {
  surface: {
    canvas: '#F8FAFC',
    elevated: '#FFFFFF',
    overlay: 'rgba(15, 23, 42, 0.4)',
    inverse: '#0F172A',
  },
  text: {
    primary: '#0F172A',
    secondary: '#475569',
    tertiary: '#94A3B8',
    inverse: '#F8FAFC',
    link: '#1E3A8A',
  },
  border: {
    subtle: '#E2E8F0',
    default: '#CBD5E1',
    strong: '#94A3B8',
    focus: '#1E3A8A',
  },
  brand: {
    primary: '#1E3A8A',
    primaryHover: '#1E40AF',
    primaryActive: '#1E3A8A',
    accent: '#B45309',
  },
  status: {
    success: '#15803D',
    warning: '#B45309',
    danger: '#B91C1C',
    info: '#0369A1',
  },
  chart: ['#1E3A8A', '#0F766E', '#B45309', '#6D28D9', '#B91C1C', '#15803D'],
};

export const colorTokensDark: SemanticColors = {
  surface: {
    canvas: '#0F172A',
    elevated: '#1E293B',
    overlay: 'rgba(0, 0, 0, 0.6)',
    inverse: '#F8FAFC',
  },
  text: {
    primary: '#F8FAFC',
    secondary: '#CBD5E1',
    tertiary: '#64748B',
    inverse: '#0F172A',
    link: '#93C5FD',
  },
  border: {
    subtle: '#334155',
    default: '#475569',
    strong: '#64748B',
    focus: '#93C5FD',
  },
  brand: {
    primary: '#3B82F6',
    primaryHover: '#60A5FA',
    primaryActive: '#2563EB',
    accent: '#FBBF24',
  },
  status: {
    success: '#22C55E',
    warning: '#FBBF24',
    danger: '#EF4444',
    info: '#38BDF8',
  },
  chart: ['#60A5FA', '#2DD4BF', '#FBBF24', '#A78BFA', '#F87171', '#34D399'],
};

/**
 * High-contrast variant — meets WCAG AAA for body text on the canvas
 * surface (≥7:1 contrast). Use as a tertiary theme behind a user
 * preference toggle.
 */
export const colorTokensHighContrast: SemanticColors = {
  surface: {
    canvas: '#FFFFFF',
    elevated: '#FFFFFF',
    overlay: 'rgba(0, 0, 0, 0.7)',
    inverse: '#000000',
  },
  text: {
    primary: '#000000',
    secondary: '#1F2937',
    tertiary: '#374151',
    inverse: '#FFFFFF',
    link: '#1E3A8A',
  },
  border: {
    subtle: '#1F2937',
    default: '#000000',
    strong: '#000000',
    focus: '#000000',
  },
  brand: {
    primary: '#1E3A8A',
    primaryHover: '#1E40AF',
    primaryActive: '#1E3A8A',
    accent: '#7F1D1D',
  },
  status: {
    success: '#14532D',
    warning: '#7F1D1D',
    danger: '#7F1D1D',
    info: '#1E3A8A',
  },
  chart: ['#1E3A8A', '#14532D', '#7F1D1D', '#581C87', '#0F172A', '#000000'],
};

export type { SemanticColors };
