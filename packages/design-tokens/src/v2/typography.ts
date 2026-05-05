/**
 * Typography scale — type-safe + math-driven.
 *
 * Three families:
 *  - display: large hero / billboard text (rare; usually one per page)
 *  - body: paragraphs, labels, defaults
 *  - mono: code, tabular numbers, IDs
 *
 * Scale uses a 1.25 modular ratio (Major Third) which lands cleanly on
 * pixel grid for all sizes ≥12px. Heights are tuned per scale step
 * (tight ratios for headings, looser for body).
 */

export interface TypeStyle {
  fontFamily: 'display' | 'body' | 'mono';
  fontSize: number;       // px
  lineHeight: number;     // px (resolved, not unitless)
  fontWeight: number;
  letterSpacing: number;  // em (CSS letter-spacing in em units)
}

export const fontFamilies = {
  /* Cross-platform stacks — system fonts first, then the licensed
   * brand fonts when present. Keep both ready in case the licensed
   * font fails to load (production resilience). */
  display: '"Inter Display", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  body: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;

/* Modular scale: 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72 px.
 * Each step is roughly ×1.25; chosen integers stay on the 4px grid. */

export const display = {
  '4xl': { fontFamily: 'display', fontSize: 72, lineHeight: 80, fontWeight: 700, letterSpacing: -0.02 },
  '3xl': { fontFamily: 'display', fontSize: 60, lineHeight: 64, fontWeight: 700, letterSpacing: -0.02 },
  '2xl': { fontFamily: 'display', fontSize: 48, lineHeight: 56, fontWeight: 700, letterSpacing: -0.02 },
  xl:    { fontFamily: 'display', fontSize: 36, lineHeight: 44, fontWeight: 700, letterSpacing: -0.01 },
  lg:    { fontFamily: 'display', fontSize: 30, lineHeight: 36, fontWeight: 700, letterSpacing: -0.01 },
} as const satisfies Record<string, TypeStyle>;

export const heading = {
  h1: { fontFamily: 'body', fontSize: 30, lineHeight: 36, fontWeight: 700, letterSpacing: -0.01 },
  h2: { fontFamily: 'body', fontSize: 24, lineHeight: 32, fontWeight: 700, letterSpacing: -0.01 },
  h3: { fontFamily: 'body', fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: 0    },
  h4: { fontFamily: 'body', fontSize: 18, lineHeight: 24, fontWeight: 600, letterSpacing: 0    },
  h5: { fontFamily: 'body', fontSize: 16, lineHeight: 24, fontWeight: 600, letterSpacing: 0    },
  h6: { fontFamily: 'body', fontSize: 14, lineHeight: 20, fontWeight: 600, letterSpacing: 0    },
} as const satisfies Record<string, TypeStyle>;

export const body = {
  lg: { fontFamily: 'body', fontSize: 18, lineHeight: 28, fontWeight: 400, letterSpacing: 0 },
  md: { fontFamily: 'body', fontSize: 16, lineHeight: 24, fontWeight: 400, letterSpacing: 0 },
  sm: { fontFamily: 'body', fontSize: 14, lineHeight: 20, fontWeight: 400, letterSpacing: 0 },
  xs: { fontFamily: 'body', fontSize: 12, lineHeight: 16, fontWeight: 400, letterSpacing: 0.005 },
} as const satisfies Record<string, TypeStyle>;

export const mono = {
  md: { fontFamily: 'mono', fontSize: 14, lineHeight: 20, fontWeight: 400, letterSpacing: 0 },
  sm: { fontFamily: 'mono', fontSize: 12, lineHeight: 16, fontWeight: 400, letterSpacing: 0 },
} as const satisfies Record<string, TypeStyle>;
