/**
 * 跨运行时设计令牌
 * 纯值常量，零运行时依赖
 * typography 使用平台无关数值描述符，font family 分平台提供
 */

export const chronoDesignTokens = {
  color: {
    canvas: '#f7f2e8',
    ink: '#1f1a17',
    accent: '#9e4c28',
    accentMuted: '#d9a57f',
    borderSubtle: '#d8cbb8',
    focusRing: '#7a3419',
    success: '#2f6b3b',
    danger: '#9f2621',
    /** 同步状态色 — 映射 RuntimeSyncStateV1 的每个状态 */
    status: {
      idle: '#2f6b3b',
      pulling: '#0369A1',
      merging: '#0369A1',
      pushing: '#0369A1',
      paused: '#6B7280',
      offline: '#6B7280',
      conflicted: '#C2410C',
      error: '#9f2621',
      unconfigured: '#6B7280',
      disabled: '#6B7280',
    },
    surface: {
      default: '#FFFDF8',
      subdued: '#F7F7F2',
      critical: '#FEF2F2',
    },
  },
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 20,
    xl: 32,
  },
  radius: {
    sm: 4,
    md: 10,
    lg: 18,
  },
  size: {
    touchMin: 44,
  },
  borderWidth: {
    sm: 1,
    md: 2,
  },
  border: {
    focusRing: {
      width: 2,
      offset: 2,
      color: '#7a3419',
    },
  },
  motion: {
    fast: 120,
    normal: 180,
    slow: 280,
    reduced: 0,
    syncPulseMs: 1200,
    conflictAttentionMs: 300,
  },
  icon: {
    syncSpinner: 'sync-spinner',
    offlineCloud: 'cloud-offline',
    conflictWarning: 'alert-triangle',
    errorAlert: 'alert-circle',
    pausedClock: 'clock-pause',
    checkCircle: 'check-circle',
    settingsGear: 'settings',
    disabledSlash: 'slash',
  },
  typography: {
    family: {
      display: {
        web: ['Iowan Old Style', 'Palatino Linotype', 'serif'],
        native: 'Iowan Old Style',
      },
      body: {
        web: ['Avenir Next', 'Segoe UI', 'sans-serif'],
        native: 'Avenir Next',
      },
    },
    size: {
      sm: 14,
      md: 16,
      lg: 20,
      xl: 32,
    },
    lineHeight: {
      sm: 20,
      md: 24,
      lg: 28,
      xl: 40,
    },
    weight: {
      regular: 400,
      medium: 500,
      bold: 700,
    },
  },
} as const;
