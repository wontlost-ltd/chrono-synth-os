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
    secondary: string;
    secondaryHover: string;
    accent: string;
    accentHover: string;
  };
  /** Status — semantic intent, not raw colour names. */
  status: {
    success: string;
    warning: string;
    danger: string;
    info: string;
    /** Sync / lifecycle states; used by web + desktop status badges. */
    active: string;
    paused: string;
    syncing: string;
    offline: string;
    completed: string;
  };
  /** Chart palette — 6 hues with predictable order, plus grid + diff cues. */
  chart: {
    series: [string, string, string, string, string, string];
    grid: string;
    positive: string;
    negative: string;
  };
  /** Neutral grey scale, light → mid → dark. */
  neutral: {
    1: string;
    2: string;
    3: string;
  };
}

export const colorTokensLight: SemanticColors = {
  surface: {
    canvas: '#F8FAFC',
    elevated: '#FFFFFF',
    overlay: 'rgba(0, 0, 0, 0.4)',
    inverse: '#0F172A',
  },
  text: {
    primary: '#0F172A',
    secondary: '#475569',
    /* slate-500 — slate-400 (#94A3B8) was 2.45:1 on canvas, failing
     * WCAG AA 3:1 non-text threshold. Bumped to slate-500 for 4.6:1. */
    tertiary: '#64748B',
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
    primaryHover: '#3B82F6',
    primaryActive: '#1E3A8A',
    secondary: '#0F766E',
    secondaryHover: '#14B8A6',
    accent: '#B45309',
    accentHover: '#F59E0B',
  },
  status: {
    /* Status colours are also used as text on top of a 10% tint of
     * the same colour (StatusBadge). bg-*\/10 compositing brings the
     * effective background TOWARD the text colour, so the text needs
     * to be darker than the AA 4.5:1 threshold on plain canvas would
     * suggest. Values below clear 4.5:1 against the COMPOSITED bg —
     * see scripts/lint-contrast-ratio.mjs. */
    success: '#166534',
    warning: '#92400E',
    danger: '#991B1B',
    info: '#1D4ED8',
    active: '#166534',
    paused: '#92400E',
    syncing: '#1D4ED8',
    offline: '#4B5563',
    completed: '#166534',
  },
  chart: {
    series: ['#1E3A8A', '#0F766E', '#B45309', '#6D28D9', '#B91C1C', '#15803D'],
    grid: '#E2E8F0',
    positive: '#15803D',
    negative: '#B91C1C',
  },
  neutral: {
    1: '#F1F5F9',
    2: '#CBD5E1',
    3: '#94A3B8',
  },
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
    /* a11y：web + desktop 共享此 colorTokensDark，白字按钮（bg-primary text-white，web 全站 75 处）
     * 需对比度≥4.5。#3B82F6 仅 3.68 不达标，加深到 #2563EB（5.17:1 过 WCAG AA）；
     * active 再深一档 #1D4ED8（6.70:1 AAA，保留按压区分）。desktop --color-chrono-primary 同源同步受益。
     * （此前该 a11y 值只手改在 themes.css 生成区，未回写源——codegen 会还原，故在此源头落实。） */
    primary: '#2563EB',
    primaryHover: '#60A5FA',
    primaryActive: '#1D4ED8',
    secondary: '#14B8A6',
    secondaryHover: '#2DD4BF',
    accent: '#FBBF24',
    accentHover: '#FCD34D',
  },
  status: {
    success: '#22C55E',
    warning: '#FBBF24',
    /* red-400; red-500 (#EF4444) was 4.36:1 against the bg-danger\/10
     * tinted background. red-400 is 5.69:1. */
    danger: '#F87171',
    info: '#38BDF8',
    active: '#22C55E',
    paused: '#FBBF24',
    syncing: '#38BDF8',
    /* slate-400; slate-500 (#6B7280) was 3.69:1 on dark canvas, below
     * the WCAG AA 4.5:1 text threshold. slate-400 is 6.96:1. */
    offline: '#94A3B8',
    completed: '#22C55E',
  },
  chart: {
    series: ['#60A5FA', '#2DD4BF', '#FBBF24', '#A78BFA', '#F87171', '#34D399'],
    grid: '#334155',
    positive: '#22C55E',
    negative: '#EF4444',
  },
  neutral: {
    1: '#1E293B',
    2: '#475569',
    3: '#64748B',
  },
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
    secondary: '#1E3A8A',
    secondaryHover: '#1E40AF',
    accent: '#7F1D1D',
    accentHover: '#7F1D1D',
  },
  status: {
    success: '#14532D',
    warning: '#7F1D1D',
    danger: '#7F1D1D',
    info: '#1E3A8A',
    active: '#14532D',
    paused: '#7F1D1D',
    syncing: '#1E3A8A',
    offline: '#374151',
    completed: '#14532D',
  },
  chart: {
    series: ['#1E3A8A', '#14532D', '#7F1D1D', '#581C87', '#0F172A', '#000000'],
    grid: '#000000',
    positive: '#14532D',
    negative: '#7F1D1D',
  },
  neutral: {
    1: '#F3F4F6',
    2: '#6B7280',
    3: '#4B5563',
  },
};

/**
 * ChronoCompanion（C 端数字人）暖调主题。
 *
 * 落地 ADR-0046 D3「复用同一 design system」——把 companion-web 原本手写的 29 个
 * `--c-*` token 收编进共享 SemanticColors 契约，使两个产品共用一套 token 单一事实源。
 *
 * P1b（暖色拟人化）：品牌主色由 P0 的冷蓝 #5b8def 转**暖琥珀**——强化「温暖伙伴」气质，
 * 与企业版冷静蓝灰拉开识别度。brand 决定 active-tab/进度条/用户气泡/按钮等的暖调。
 * 对比度：--c-brand #c2691e 白字 3.94（>原 3.23，加粗活态文本可读）；--c-brand-strong #a85518
 * 白字 5.28 过 WCAG AA（>原 4.81，用于登录按钮等白字背景）。其余 surface/text/status 暖中性不变。
 * companion 是单一暗色主题（无 light/hc 变体）。
 *
 * 映射依据（--c-* → SemanticColors）：
 *   --c-bg #0f1420 → surface.canvas    --c-surface #1a2030 → surface.elevated
 *   --c-surface-2 #232a3d → border/neutral   --c-text #e8ecf4 → text.primary
 *   --c-muted #8a94ab → text.secondary/tertiary   --c-brand 暖琥珀 → brand.primary
 *   --c-brand-strong 深琥珀 → brand.primaryActive（白字按钮 AA）
 *   --c-pos #4fc08d → status.success/positive   --c-neg #e7796b → status.danger/negative
 */
export const colorTokensCompanion: SemanticColors = {
  surface: {
    canvas: '#0f1420',     // --c-bg
    elevated: '#1a2030',   // --c-surface
    overlay: 'rgba(0, 0, 0, 0.6)',
    inverse: '#e8ecf4',
  },
  text: {
    primary: '#e8ecf4',    // --c-text
    secondary: '#8a94ab',  // --c-muted
    tertiary: '#8a94ab',   // companion 仅一档 muted；tertiary 暂同 secondary
    inverse: '#0f1420',
    link: '#e8924a',       // 暖琥珀亮调（链接需在暗底可读，用亮于 brand 的一档）
  },
  border: {
    subtle: '#232a3d',     // --c-surface-2（companion 用 surface-2 作描边/分隔）
    default: '#232a3d',
    strong: '#3a4870',
    focus: '#c2691e',      // 暖琥珀焦点环（与 brand 一致）
  },
  brand: {
    primary: '#c2691e',        // --c-brand 暖琥珀（active-tab/进度/气泡/bar；白字 3.94）
    primaryHover: '#a85518',
    primaryActive: '#a85518',  // --c-brand-strong 深琥珀（白字按钮 5.28 过 AA）
    secondary: '#4fc08d',
    secondaryHover: '#4fc08d',
    accent: '#4fc08d',
    accentHover: '#4fc08d',
  },
  status: {
    success: '#4fc08d',    // --c-pos
    warning: '#e7796b',    // companion 无独立 warning，复用 neg 暖红（P1b 可分化）
    danger: '#e7796b',     // --c-neg
    info: '#5b8def',
    active: '#4fc08d',
    paused: '#e7796b',
    syncing: '#5b8def',
    offline: '#8a94ab',
    completed: '#4fc08d',
  },
  chart: {
    series: ['#5b8def', '#4fc08d', '#e7796b', '#8a94ab', '#3a6fd0', '#232a3d'],
    grid: '#232a3d',
    positive: '#4fc08d',
    negative: '#e7796b',
  },
  neutral: {
    1: '#1a2030',
    2: '#232a3d',
    3: '#8a94ab',
  },
};

export type { SemanticColors };
