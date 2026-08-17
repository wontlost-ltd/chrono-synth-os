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
    /**
     * 品牌色**作为文本**落在 surface 上时专用（链接、小标签、强调标题）。
     * 与 primary 解耦的原因：primary 承担实色按钮填充，需保证**白字**压在其上
     * ≥4.5；而同一个值作为文本压在深色 surface 上时对比度恰好相反——两者不可能
     * 由一个值同时满足（dark 主题下 #2563EB 白字 5.17 达标、作文本仅 2.83 不达标）。
     * 与 status.successFill / dangerFill 是同一套拆分手法。
     */
    primaryText: string;
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
    /** 实色按钮填充专用：需保证白字对比度 ≥3.0；与作为文本/徽章的 success 解耦。 */
    successFill: string;
    warning: string;
    danger: string;
    /** 实色按钮填充专用：需保证白字对比度 ≥3.0；与作为文本/徽章的 danger 解耦。 */
    dangerFill: string;
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
    /* light 主题下 primary 本就够深，作文本落在 canvas(#F8FAFC) 9.90 / elevated(#FFFFFF) 10.36，
     * 已过 AAA，故与 primary 同值——拆 token 是为了语义清晰与 dark 主题的实际需要。 */
    primaryText: '#1E3A8A',
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
    successFill: '#166534',
    warning: '#92400E',
    danger: '#991B1B',
    dangerFill: '#991B1B',
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
    /* dark 主题下 primary(#2563EB) 作文本压在 surface 上仅 2.83，达不到 AA——但它不能改深，
     * 否则白字按钮（上方注释所述 75 处）会跌破 4.5。故文本另用亮一档的 #60A5FA：
     * canvas(#0F172A) 7.02 过 AAA、elevated(#1E293B) 5.75 过 AA。
     * 该值与 primaryHover 相同属巧合（hover 是背景语义），两者不可合并。 */
    primaryText: '#60A5FA',
    primaryHover: '#60A5FA',
    primaryActive: '#1D4ED8',
    secondary: '#14B8A6',
    secondaryHover: '#2DD4BF',
    accent: '#FBBF24',
    accentHover: '#FCD34D',
  },
  status: {
    /* dark 的 success/danger 故意保持亮色给 StatusBadge 文本（落在自身 10% tint 上仍需 ≥4.5）；
     * 实色按钮填充另用更深的 *Fill token 承载白字（≥3.0），避免一个 token 承担对立语义。 */
    success: '#22C55E',
    successFill: '#16A34A',
    warning: '#FBBF24',
    /* red-400; red-500 (#EF4444) was 4.36:1 against the bg-danger\/10
     * tinted background. red-400 is 5.69:1. */
    danger: '#F87171',
    dangerFill: '#DC2626',
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
 * apps/web 专用的暗色变体——比 colorTokensDark 更深的三层景深。
 *
 * 存在的理由（不是重复定义，是消除一处真实脱节）：
 * apps/web 的 globals.css 长期在 codegen 标记**之外**手写了一组 dark 覆盖，
 * 于是「token 值」与「浏览器实际渲染值」分成两套——contrast lint 读前者，
 * 用户看后者，门测出的数字并非线上真相（当前方向有利：lint 测 primaryText
 * 5.75，实际渲染 6.75，但方向随时可能反过来）。
 *
 * 这里把那组手写值收编为一等公民，themes.css 由它生成、lint 也检查它，
 * 二者重新同源。
 *
 * 为什么不直接改 colorTokensDark：desktop 的 --color-chrono-* 有 6 个变量
 * 派生自 colorTokensDark（见 codegen 的 desktopVars），直接改会连带把桌面端
 * 外观调暗。两套值实测均过 WCAG，故属纯视觉取舍而非对错问题——保持 desktop
 * 现状，只让 web 用自己的值。
 *
 * 只覆盖与 colorTokensDark 真正不同的 6 个值，其余（含 brand/status/chart）
 * 一律继承，避免第二处需要同步维护的清单。
 */
export const colorTokensDarkWeb: SemanticColors = {
  ...colorTokensDark,
  surface: {
    ...colorTokensDark.surface,
    canvas: '#050914',    // 最深——页面背景
    elevated: '#131B2E',  // 中层——卡片 / 侧边栏
  },
  text: {
    ...colorTokensDark.text,
    secondary: '#A8B3CC',
    tertiary: '#6B7691',
  },
  border: {
    ...colorTokensDark.border,
    subtle: '#2A3753',   // 略亮，让卡片边缘可见
    default: '#3A4870',
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
    /* high-contrast 的 canvas 是纯白，#1E3A8A 作文本 10.36 过 AAA。 */
    primaryText: '#1E3A8A',
    primaryHover: '#1E40AF',
    primaryActive: '#1E3A8A',
    secondary: '#1E3A8A',
    secondaryHover: '#1E40AF',
    accent: '#7F1D1D',
    accentHover: '#7F1D1D',
  },
  status: {
    success: '#14532D',
    successFill: '#14532D',
    warning: '#7F1D1D',
    danger: '#7F1D1D',
    dangerFill: '#7F1D1D',
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
    /* brand 暖琥珀作文本压在 elevated(#1a2030) 仅 4.12，差一点到 AA；沿用已有的亮调
     * 链接色 #e8924a（canvas 7.57 / elevated 6.68），与 text.link 同值即同语义。 */
    primaryText: '#e8924a',
    primaryHover: '#a85518',
    primaryActive: '#a85518',  // --c-brand-strong 深琥珀（白字按钮 5.28 过 AA）
    secondary: '#4fc08d',
    secondaryHover: '#4fc08d',
    accent: '#4fc08d',
    accentHover: '#4fc08d',
  },
  status: {
    success: '#4fc08d',    // --c-pos
    successFill: '#4fc08d',
    warning: '#e7796b',    // companion 无独立 warning，复用 neg 暖红（P1b 可分化）
    danger: '#e7796b',     // --c-neg（作徽章/文本用，落在暗底上 5.68 过 AA）
    /* 实色按钮填充另用更深一档：#e7796b 压白字仅 2.86 不达 AA(3.0)，而
     * .perceive__mic--on（听写中的实心红麦克风）正是 background: --c-neg
     * + color: #fff。加深到 #d95a49 后白字 3.81 达标，色相基本不变。
     * 与 dark 主题「danger 亮给徽章、dangerFill 深给按钮」的拆分一致。 */
    dangerFill: '#d95a49',
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
