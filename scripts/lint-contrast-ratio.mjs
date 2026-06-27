#!/usr/bin/env node
/**
 * WCAG 2.x relative-luminance contrast lint for design tokens.
 *
 * Checks every (foreground, background) pair declared as "must meet
 * WCAG AA" (4.5:1 for normal text, 3:1 for large text and non-text
 * UI) across the three themes (light, dark, high-contrast). The
 * high-contrast theme must additionally meet WCAG AAA (≥7:1 for
 * normal text).
 *
 * Why this matters: a token tweak that drops `--color-text-secondary`
 * by 5% lightness is invisible to the human reviewer but can silently
 * push a (text-secondary on surface-canvas) pair below 4.5:1 — a
 * WCAG AA failure. Catching it at lint time means we can't ship a
 * regression unless a token edit is explicit about lowering contrast.
 *
 * Formula references:
 *   https://www.w3.org/TR/WCAG20/#contrast-ratiodef
 *   https://www.w3.org/TR/WCAG20/#relativeluminancedef
 *
 * Exit 0 = all pairs pass; exit 1 = at least one pair below threshold.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OS_ROOT = resolve(__dirname, '..');

const tokensModule = resolve(OS_ROOT, 'packages/design-tokens/dist/v2/colors.js');
if (!existsSync(tokensModule)) {
  console.error('✖ design-tokens dist not found; run `npm run build` first');
  process.exit(2);
}
const { colorTokensLight, colorTokensDark, colorTokensHighContrast } =
  await import(tokensModule);

/* ── WCAG math ────────────────────────────────────────────────────── */

/** Strip 'rgba(...)' or hex into [r, g, b] each in 0..1.
 *  We ignore alpha — contrast on a semi-transparent fill is undefined
 *  without knowing what's behind it. Pairs that include translucent
 *  colours are excluded from this lint (with an explicit note in the
 *  PAIRS list). */
function parseColor(raw) {
  raw = raw.trim();
  if (raw.startsWith('#')) {
    let hex = raw.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6) throw new Error(`bad hex: ${raw}`);
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  }
  const m = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map(s => Number(s.trim()));
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
  }
  throw new Error(`unrecognized color: ${raw}`);
}

/** WCAG 2.x relative luminance — see spec link in header. */
function relativeLuminance([r, g, b]) {
  const channel = c =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(Array.isArray(c1) ? c1 : parseColor(c1));
  const l2 = relativeLuminance(Array.isArray(c2) ? c2 : parseColor(c2));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Standard "source-over" alpha compositing of `fg` (with `alpha`)
 *  painted on top of opaque `bg`. Returns linear-RGB triples in 0..1.
 *
 *  Why we need this: bg-*\/10 utilities render the status color at
 *  10% opacity over the surface canvas. The effective background
 *  the text is reading against is therefore not the canvas — it's a
 *  blend that has shifted toward the text colour, *reducing* contrast.
 *  Checking text-vs-canvas (no compositing) is the OPTIMISTIC case,
 *  not the conservative one. */
function compositeOver(fg, bg, alpha) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  return f.map((channel, i) => channel * alpha + b[i] * (1 - alpha));
}

/* ── Pair declarations ────────────────────────────────────────────── */

/**
 * Each entry: { fg, bg, label, minAA, minAAA?, bgAlpha?, fgLiteral?, skipForTheme? }
 *   fg / bg     dotted paths into the theme object
 *   fgLiteral   if present, use this literal hex as the foreground instead
 *               of resolving `fg` per theme. Models components that hardcode
 *               a colour (e.g. solid-fill buttons render `text-white` across
 *               ALL themes — they do NOT swap to the theme's `text.inverse`,
 *               which flips to near-black in dark mode). `fg` is still given
 *               for the failure message / documentation of intent.
 *   label       human-readable; appears in failure output
 *   minAA       contrast ratio required by AA (default 4.5)
 *   minAAA      additional ratio enforced for the high-contrast
 *               theme (default 7.0). Set to 0 to skip AAA gate.
 *   bgAlpha     if present, treat `bg` as `fg`-coloured paint at this
 *               alpha composited onto canvas — models bg-*\/10 utilities
 *   skipForTheme  array of theme names where this pair doesn't apply
 *                 (e.g. "tertiary text on canvas" is purely decorative
 *                 in high-contrast theme and never used)
 *
 * Pairs that include `surface.overlay` (semi-transparent) are not
 * checked — their effective contrast depends on what's underneath.
 */
const PAIRS = [
  /* Primary text on canvas — the single most load-bearing pair. */
  { fg: 'text.primary', bg: 'surface.canvas', label: 'body text on page', minAA: 4.5, minAAA: 7.0 },
  /* Primary text on elevated surfaces (cards / modals). */
  { fg: 'text.primary', bg: 'surface.elevated', label: 'body text on card', minAA: 4.5, minAAA: 7.0 },
  /* Secondary text on canvas. */
  { fg: 'text.secondary', bg: 'surface.canvas', label: 'secondary text on page', minAA: 4.5, minAAA: 7.0 },
  /* Secondary text on elevated. */
  { fg: 'text.secondary', bg: 'surface.elevated', label: 'secondary text on card', minAA: 4.5, minAAA: 7.0 },
  /* Tertiary text — typically small labels; AA = 3:1 (non-text-equivalent). */
  { fg: 'text.tertiary', bg: 'surface.canvas', label: 'tertiary text on page', minAA: 3.0, minAAA: 4.5 },
  /* Links / interactive text — must stand out from body. */
  { fg: 'text.link', bg: 'surface.canvas', label: 'link on page', minAA: 4.5, minAAA: 7.0 },
  /* Inverse text on inverse surface — for toasts, popovers in dark. */
  { fg: 'text.inverse', bg: 'surface.inverse', label: 'inverse text on inverse surface', minAA: 4.5, minAAA: 7.0 },
  /* Solid-fill buttons (Button.tsx primary/danger/success) render literal `text-white`
   * across ALL themes — they do NOT use the theme's `text.inverse` (which is near-black
   * in dark mode). So the gate must measure white-on-fill, not inverse-on-fill, or it
   * would flag the dark primary button (#FFFFFF on #2563EB = 5.17 AA) as a false 3.45 fail. */
  { fg: 'text.inverse', fgLiteral: '#FFFFFF', bg: 'brand.primary', label: 'white text on brand-primary button', minAA: 4.5, minAAA: 7.0 },
  { fg: 'text.inverse', fgLiteral: '#FFFFFF', bg: 'status.successFill', label: 'white text on success-fill button', minAA: 3.0, minAAA: 4.5 },
  { fg: 'text.inverse', fgLiteral: '#FFFFFF', bg: 'status.dangerFill', label: 'white text on danger-fill button', minAA: 3.0, minAAA: 4.5 },
  /* Status colours as USED IN StatusBadge: status-coloured text on a
   * 10% tint of the SAME status colour over canvas. The tint moves the
   * effective background TOWARD the text colour, so the contrast is
   * worse than text-vs-canvas. bgAlpha=0.10 tells the lint to alpha-
   * composite the status colour at 10% onto the canvas before measuring
   * — this matches what bg-*\/10 renders in the DOM. */
  { fg: 'status.active', bg: 'surface.canvas', bgAlpha: 0.10, label: 'badge text: active on tinted page', minAA: 4.5, minAAA: 7.0 },
  { fg: 'status.paused', bg: 'surface.canvas', bgAlpha: 0.10, label: 'badge text: paused on tinted page', minAA: 4.5, minAAA: 7.0 },
  { fg: 'status.syncing', bg: 'surface.canvas', bgAlpha: 0.10, label: 'badge text: syncing on tinted page', minAA: 4.5, minAAA: 7.0 },
  { fg: 'status.danger', bg: 'surface.canvas', bgAlpha: 0.10, label: 'badge text: danger on tinted page', minAA: 4.5, minAAA: 7.0 },
  { fg: 'status.offline', bg: 'surface.canvas', bgAlpha: 0.10, label: 'badge text: offline on tinted page', minAA: 4.5, minAAA: 7.0 },
  { fg: 'status.completed', bg: 'surface.canvas', bgAlpha: 0.10, label: 'badge text: completed on tinted page', minAA: 4.5, minAAA: 7.0 },
  /* Focus ring vs canvas — must be visible. AA non-text 3:1. */
  { fg: 'border.focus', bg: 'surface.canvas', label: 'focus ring on page', minAA: 3.0, minAAA: 4.5 },
];

/* ── Lookup ───────────────────────────────────────────────────────── */

function lookup(theme, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return acc;
    return acc[key];
  }, theme);
}

/* ── Run ──────────────────────────────────────────────────────────── */

const themes = {
  light: { tokens: colorTokensLight, aaa: false },
  dark: { tokens: colorTokensDark, aaa: false },
  'high-contrast': { tokens: colorTokensHighContrast, aaa: true },
};

let failures = 0;
let totalChecks = 0;

for (const [themeName, themeMeta] of Object.entries(themes)) {
  console.log(`\n=== theme: ${themeName} ===`);
  for (const pair of PAIRS) {
    if (pair.skipForTheme?.includes(themeName)) continue;
    /* fgLiteral overrides the per-theme token: models components that hardcode a colour. */
    const fg = pair.fgLiteral ?? lookup(themeMeta.tokens, pair.fg);
    const bg = lookup(themeMeta.tokens, pair.bg);
    if (fg == null || bg == null) {
      console.error(`  ✖ ${pair.label}: missing token (fg=${pair.fg} → ${fg}, bg=${pair.bg} → ${bg})`);
      failures += 1;
      continue;
    }
    let ratio;
    try {
      const effectiveBg = pair.bgAlpha == null ? bg : compositeOver(fg, bg, pair.bgAlpha);
      ratio = contrastRatio(fg, effectiveBg);
    } catch (err) {
      console.error(`  ✖ ${pair.label}: ${err.message}`);
      failures += 1;
      continue;
    }
    const required = themeMeta.aaa ? (pair.minAAA ?? pair.minAA) : pair.minAA;
    const requirementName = themeMeta.aaa ? 'AAA' : 'AA';
    totalChecks += 1;
    if (ratio + 1e-3 < required) {
      console.error(`  ✖ ${pair.label}: ${ratio.toFixed(2)}:1 (needs ≥${required.toFixed(1)}:1 ${requirementName})`);
      console.error(`       fg ${pair.fg}=${fg}  bg ${pair.bg}=${bg}`);
      failures += 1;
    } else {
      console.log(`  ✓ ${pair.label}: ${ratio.toFixed(2)}:1 (${requirementName} threshold ${required.toFixed(1)}:1)`);
    }
  }
}

console.log('');
console.log(`contrast lint: ${totalChecks} checks, ${failures} failure(s)`);

if (failures > 0) {
  console.error('');
  console.error('Resolution: tweak the offending token (fg or bg) in');
  console.error('  packages/design-tokens/src/v2/colors.ts');
  console.error('to restore the contrast ratio, then re-run codegen.');
  process.exit(1);
}
process.exit(0);
