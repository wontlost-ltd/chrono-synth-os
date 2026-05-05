/**
 * Motion tokens — durations, easings, spring presets.
 *
 * Mirror of `chrono-synth-web/src/components/motion/motion.css` so the
 * native (Tauri) and React Native paths can reuse the same values
 * without parsing CSS at runtime.
 *
 * Reduced-motion: consumers must check `prefers-reduced-motion` (web)
 * or the platform equivalent before applying these durations. This
 * file does not encode that policy — it's the values, not the gate.
 */

export const duration = {
  /** Hover / focus / button-state transitions. */
  fast: 120,
  /** Page transitions, panel slides, default for most UI. */
  base: 200,
  /** Drawer open, complex composed entrances. */
  slow: 320,
} as const;

export const easing = {
  /** ease-in-out feel; default for most transitions. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** ease-out; for "thing arriving / settling". */
  decel: 'cubic-bezier(0, 0, 0, 1)',
  /** ease-in; for "thing leaving the viewport". */
  accel: 'cubic-bezier(0.4, 0, 1, 1)',
  /** Linear — only for progress bars, never for entrances. */
  linear: 'linear',
} as const;

/**
 * Spring presets — for runtimes that support spring animations
 * (Framer Motion, react-native-reanimated, SwiftUI, Compose).
 * These are the {stiffness, damping, mass} tuples; consumers
 * translate to the native API.
 */
export const spring = {
  /** Snappy: window minimize/maximize, drag-release. */
  snappy: { stiffness: 380, damping: 30, mass: 1 },
  /** Soft: panel reveal, content slide. */
  soft: { stiffness: 220, damping: 26, mass: 1 },
  /** Bouncy: success acknowledgement, only when delight is intentional. */
  bouncy: { stiffness: 300, damping: 14, mass: 1 },
} as const;
