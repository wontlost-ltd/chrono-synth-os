/**
 * Theme controller — light / dark / high-contrast.
 *
 * Persists choice to localStorage. When no choice is set, the page uses
 * the @media(prefers-color-scheme) fallback in themes.css. Switching
 * applies the data-theme attribute on <html> synchronously so there's
 * no flash-of-unstyled-content during the transition.
 */

import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'high-contrast' | 'system';

const STORAGE_KEY = 'chrono.theme';
const DOM_ATTRIBUTE = 'data-theme';

/** v2 brand default — dark mode showcases the cyan-violet AI palette best.
 *  Users who explicitly chose 'system' still get OS-driven, only first-time
 *  visits flip to dark instead of following the OS. */
const DEFAULT_CHOICE: ThemeChoice = 'dark';

const VALID: ReadonlySet<ThemeChoice> = new Set(['light', 'dark', 'high-contrast', 'system']);

function readStored(): ThemeChoice {
  if (typeof window === 'undefined') return DEFAULT_CHOICE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && VALID.has(raw as ThemeChoice)) return raw as ThemeChoice;
  } catch {
    /* ignore */
  }
  return DEFAULT_CHOICE;
}

function applyToDom(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute(DOM_ATTRIBUTE);
  } else {
    root.setAttribute(DOM_ATTRIBUTE, choice);
  }
}

/** Apply the stored theme. Call once at app bootstrap (main.tsx) so the
 *  attribute is set before the first paint, avoiding FOUC. */
export function bootstrapTheme(): void {
  applyToDom(readStored());
}

/** Set the theme persistently. Synchronous DOM update; subscribers via
 *  useThemeChoice get notified via the storage event listener. */
export function setTheme(choice: ThemeChoice): void {
  if (typeof window === 'undefined') return;
  try {
    if (choice === 'system') {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    /* private mode — DOM still applied */
  }
  applyToDom(choice);
  /* Manually fire a storage event so cross-tab subscribers update too —
   * the browser only fires storage events to *other* tabs, not the one
   * that wrote it. */
  window.dispatchEvent(new StorageEvent('storage', {
    key: STORAGE_KEY,
    newValue: choice === 'system' ? null : choice,
  }));
}

export function useThemeChoice(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStored());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setChoice(readStored());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return [choice, setTheme];
}
