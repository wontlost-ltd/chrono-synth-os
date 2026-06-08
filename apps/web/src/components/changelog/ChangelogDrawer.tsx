/**
 * ChangelogDrawer — surfaces "what's new since you were last here".
 *
 * Behaviour:
 *  - On first render after a release bumps the latest entry's `version`,
 *    the drawer opens automatically. The user's last-seen version is
 *    stored in localStorage; until they explicitly close the drawer it
 *    will reopen on every page load.
 *  - Closing the drawer writes the current latest version back so it
 *    stays closed across sessions until the next release.
 *  - The drawer is also accessible via a fixed-position toggle button
 *    bottom-left of the viewport (matching the SetupChecklist on the
 *    bottom-right).
 *
 * Accessibility: the drawer is a focus-trapping dialog while open;
 * Esc closes; the trigger button shows a pulsing dot when there are
 * unread entries.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '../../lib/analytics';

const STORAGE_KEY = 'chrono.changelog.last-seen.v1';

export interface ChangelogEntry {
  version: string;
  /** Human-readable date (ISO yyyy-mm-dd) */
  date: string;
  titleKey: string;
  bodyKey: string;
}

/** Hardcoded for now; bump these on each release. The order matters —
 *  latest first. Move to JSON / API fetch in a future iteration. */
export const CHANGELOG: ReadonlyArray<ChangelogEntry> = [
  {
    version: '2026.05.0',
    date: '2026-05-05',
    titleKey: 'changelog.entries.0.title',
    bodyKey: 'changelog.entries.0.body',
  },
  {
    version: '2026.04.0',
    date: '2026-04-12',
    titleKey: 'changelog.entries.1.title',
    bodyKey: 'changelog.entries.1.body',
  },
];

function readLastSeen(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(version: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, version);
  } catch {
    /* private mode — no-op */
  }
}

export function ChangelogDrawer() {
  const { t } = useTranslation();
  const dialogId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  const latest = CHANGELOG[0];
  const hasUnread = !!latest && lastSeen !== latest.version;

  useEffect(() => {
    const seen = readLastSeen();
    setLastSeen(seen);
    if (latest && seen !== latest.version) {
      /* First visit since a release — auto-open once.
       * We don't auto-open if the user already saw and closed (lastSeen
       * stays at latest.version after close). */
      setOpen(true);
      track('changelog.auto_opened', { version: latest.version });
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable[0]?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeDrawer();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [open]);

  function closeDrawer() {
    setOpen(false);
    if (latest) {
      writeLastSeen(latest.version);
      setLastSeen(latest.version);
    }
    triggerRef.current?.focus();
    track('changelog.closed', { version: latest?.version ?? 'none' });
  }

  function openDrawer() {
    setOpen(true);
    track('changelog.opened_manually', { version: latest?.version ?? 'none' });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openDrawer}
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-border bg-surface-elevated px-3 py-2 text-xs shadow-lg hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-label={t('changelog.openLabel')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 8v4l3 3M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z" />
        </svg>
        <span className="text-text-primary">{t('changelog.label')}</span>
        {hasUnread && (
          <span
            className="h-2 w-2 rounded-full bg-warning"
            aria-label={t('changelog.unread')}
          />
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDrawer();
          }}
          aria-hidden={false}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogId}
            className="h-full w-[min(92vw,420px)] overflow-y-auto bg-surface-elevated p-6 shadow-xl"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <h2 id={dialogId} className="text-lg font-semibold text-text-primary">
                {t('changelog.title')}
              </h2>
              <button
                type="button"
                onClick={closeDrawer}
                className="rounded p-1 text-text-secondary hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                aria-label={t('changelog.close')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <ol className="space-y-6">
              {CHANGELOG.map((entry) => (
                <li key={entry.version} className="border-l-2 border-primary/40 pl-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold text-text-primary">
                      {t(entry.titleKey)}
                    </h3>
                    <span className="text-xs text-text-secondary">
                      {entry.version} · {entry.date}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-line text-sm text-text-secondary">
                    {t(entry.bodyKey)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </>
  );
}
