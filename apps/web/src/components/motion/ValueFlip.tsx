/**
 * ValueFlip — animated number transition.
 *
 * When the `value` prop changes, the component eases from the previous
 * value to the new one over `duration` ms (default 400ms). The output
 * is rendered as a number with `format` applied per frame.
 *
 * No CSS animation — uses requestAnimationFrame so the displayed digit
 * is always a real numeric value (screen readers and snapshot tests
 * see the final value, not transient interpolations).
 *
 * Reduced motion: jumps directly to the new value without animation.
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';

interface ValueFlipProps {
  value: number;
  /** Duration in ms; default 400 */
  duration?: number;
  /** Custom formatter (e.g. localized currency). Default: integer. */
  format?: (n: number) => string;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function ValueFlip({ value, duration = 400, format }: ValueFlipProps) {
  const reduced = useReducedMotion();
  const [displayed, setDisplayed] = useState(value);
  const fromRef = useRef(value);
  const startedAtRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced || displayed === value) {
      setDisplayed(value);
      fromRef.current = value;
      return;
    }

    fromRef.current = displayed;
    startedAtRef.current = performance.now();

    const tick = (now: number) => {
      const start = startedAtRef.current ?? now;
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(t);
      const next = fromRef.current + (value - fromRef.current) * eased;
      setDisplayed(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplayed(value);
        fromRef.current = value;
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [value, duration, reduced]);

  const fmt = format ?? ((n: number) => Math.round(n).toString());
  return <span aria-live="polite">{fmt(displayed)}</span>;
}
