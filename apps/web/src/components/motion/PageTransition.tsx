/**
 * PageTransition — fade + 4px lift on route change.
 *
 * CSS-only (no Framer Motion). Wraps the route element; restarts the
 * animation by toggling a key on `location.pathname`. Respects
 * `prefers-reduced-motion`: when reduced, the wrapper renders without
 * animation classes at all.
 *
 * Animation: 200ms fade-in from opacity 0 + translateY 4px → 0. The
 * keyframes live in `motion.css` so other motion primitives can share
 * easings without duplicating.
 */

import { useLocation } from 'react-router-dom';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import './motion.css';

interface PageTransitionProps {
  children: React.ReactNode;
}

export function PageTransition({ children }: PageTransitionProps) {
  const location = useLocation();
  const reduced = useReducedMotion();

  if (reduced) {
    return <>{children}</>;
  }

  return (
    <div key={location.pathname} className="motion-page-enter">
      {children}
    </div>
  );
}
