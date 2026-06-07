/**
 * SuccessCheck — animated checkmark for confirmation moments.
 *
 * Renders an SVG circle + check path; the path uses CSS dash-stroke
 * animation for a draw-in effect. ~320ms, respects reduced-motion.
 *
 * Use cases: post-submit confirmation, "saved" toast, completion of
 * an onboarding step. Don't sprinkle on every click; the point is to
 * mark *significant* completions.
 */

import { useReducedMotion } from '../../hooks/useReducedMotion';
import './motion.css';

interface SuccessCheckProps {
  size?: number;
  /** Color for the check + ring. Defaults to brand success token. */
  color?: string;
  /** Aria-label on the wrapping span; falls back to a generic one. */
  label?: string;
}

export function SuccessCheck({ size = 24, color, label = 'Success' }: SuccessCheckProps) {
  const reduced = useReducedMotion();
  return (
    <span aria-label={label} role="img" className="inline-flex">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color ?? 'var(--color-success, #15803D)'}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="10" />
        <path
          d="M7 12l3.5 3.5L17 9"
          className={reduced ? undefined : 'motion-check-path'}
        />
      </svg>
    </span>
  );
}
