/**
 * useReducedMotion — respects `prefers-reduced-motion: reduce`.
 *
 * Returns `true` when the user has opted out of motion at the OS level.
 * Components should default to `false` (motion enabled) and disable or
 * shorten animations when this returns `true`.
 *
 * Re-evaluates if the media query changes during the session (rare but
 * possible — desktop accessibility settings can flip without reload).
 */

import { useEffect, useState } from 'react';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    /* addEventListener is the modern API; older Safari fell back to
     * addListener, but we target evergreen browsers. */
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return reduced;
}
