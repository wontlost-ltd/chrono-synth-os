/**
 * WelcomeIntro — 3-segment narrative shown once on first authenticated visit.
 *
 * Slides:
 *   1. "Hello" — anchors the product story.
 *   2. "Your persona" — explains the unit of value.
 *   3. "Grow with use" — primes the user for the leveling system.
 *
 * Persists a localStorage flag on completion or skip; never re-fires.
 * Auth gating happens at the mount site (AppShell).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './WelcomeIntro.css';

const STORAGE_KEY = 'chrono.user.welcome-seen';
const SEGMENTS = ['hello', 'persona', 'growth'] as const;
type SegmentKey = (typeof SEGMENTS)[number];

/* Per-segment SVG. Three deliberate motifs that map to product story:
 *  hello   — single node + halo (the user arrives)
 *  persona — node cluster connected by lines (memories + values cohere)
 *  growth  — concentric rings (capability surface expands with use)
 *
 * No gradients, no filters — flat strokes only. The earlier blob-gradient
 * version was a generic AI-onboarding tell. */
function WelcomeArt({ segment }: { segment: SegmentKey }) {
  const stroke = 'var(--color-primary, #3b82f6)';
  const accent = 'var(--color-chart-2, #10b981)';
  if (segment === 'hello') {
    return (
      <svg viewBox="0 0 200 120" className="welcome-intro-svg" role="img">
        <circle cx="100" cy="60" r="44" fill="none" stroke={stroke} strokeOpacity="0.25" strokeWidth="1.5" />
        <circle cx="100" cy="60" r="28" fill="none" stroke={stroke} strokeOpacity="0.5" strokeWidth="1.5" />
        <circle cx="100" cy="60" r="12" fill={stroke} />
      </svg>
    );
  }
  if (segment === 'persona') {
    return (
      <svg viewBox="0 0 200 120" className="welcome-intro-svg" role="img">
        <line x1="100" y1="60" x2="56" y2="32"  stroke={stroke} strokeOpacity="0.4" strokeWidth="1.5" />
        <line x1="100" y1="60" x2="148" y2="38" stroke={stroke} strokeOpacity="0.4" strokeWidth="1.5" />
        <line x1="100" y1="60" x2="64" y2="92"  stroke={stroke} strokeOpacity="0.4" strokeWidth="1.5" />
        <line x1="100" y1="60" x2="142" y2="90" stroke={stroke} strokeOpacity="0.4" strokeWidth="1.5" />
        <circle cx="100" cy="60" r="14" fill={stroke} />
        <circle cx="56"  cy="32" r="6"  fill={accent} />
        <circle cx="148" cy="38" r="6"  fill={accent} />
        <circle cx="64"  cy="92" r="6"  fill={accent} />
        <circle cx="142" cy="90" r="6"  fill={accent} />
      </svg>
    );
  }
  /* growth */
  return (
    <svg viewBox="0 0 200 120" className="welcome-intro-svg" role="img">
      {[18, 32, 46, 60].map((r, i) => (
        <circle
          key={r}
          cx="100"
          cy="60"
          r={r}
          fill="none"
          stroke={stroke}
          strokeOpacity={0.65 - i * 0.13}
          strokeWidth="1.5"
        />
      ))}
      <circle cx="100" cy="60" r="6" fill={stroke} />
    </svg>
  );
}

function readSeen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return true;
  }
}

function writeSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, 'true');
  } catch {
    /* ignore */
  }
}

export function WelcomeIntro() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => !readSeen());
  const [idx, setIdx] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        finish();
      } else if (e.key === 'ArrowRight') {
        setIdx((i) => Math.min(SEGMENTS.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        setIdx((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function finish() {
    writeSeen();
    setOpen(false);
  }

  if (!open) return null;

  const key: SegmentKey = SEGMENTS[idx]!;
  const isLast = idx === SEGMENTS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'var(--color-overlay, rgba(0,0,0,0.5))' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="welcome-intro outline-none"
      >
        <div className="welcome-intro-illustration" aria-hidden="true">
          <WelcomeArt segment={key} />
        </div>

        <div className="welcome-intro-content">
          <h2 id="welcome-title" className="welcome-intro-title">
            {t(`growth.welcome.${key}.title`)}
          </h2>
          <p className="welcome-intro-body">{t(`growth.welcome.${key}.body`)}</p>
        </div>

        <div className="welcome-intro-footer">
          <div className="welcome-intro-dots" aria-hidden="true">
            {SEGMENTS.map((seg, i) => (
              <span
                key={seg}
                className={`welcome-intro-dot ${i === idx ? 'active' : ''}`}
              />
            ))}
          </div>

          <div className="welcome-intro-actions">
            <button
              type="button"
              className="welcome-intro-skip"
              onClick={finish}
            >
              {t('growth.welcome.skip')}
            </button>
            {!isLast ? (
              <button
                type="button"
                className="welcome-intro-next"
                onClick={() => setIdx((i) => Math.min(SEGMENTS.length - 1, i + 1))}
              >
                {t('growth.welcome.next')}
              </button>
            ) : (
              <button
                type="button"
                className="welcome-intro-next"
                onClick={finish}
              >
                {t('growth.welcome.start')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Test-only reset. */
export function _resetWelcomeForTest(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
