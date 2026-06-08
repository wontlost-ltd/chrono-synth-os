/**
 * Hotkey registry — global keyboard shortcuts.
 *
 * Two shapes are supported:
 *   - Single-press combos: 'cmd+k', 'ctrl+/', 'esc'
 *   - Sequences: 'g p' (press g, then within 1s press p) — vim-style
 *
 * Conflict policy: registering the same key twice from different
 * components is a runtime warning in dev. The latest registration wins,
 * which is consistent with how component focus + event bubbling normally
 * resolve handler precedence.
 *
 * Why hand-rolled instead of `react-hotkeys-hook`:
 *  - We don't need a dep for ~80 LOC of behaviour.
 *  - Avoiding the dep keeps the bundle thin and the type surface obvious.
 *  - `g p` sequences are not in the popular libraries' default API.
 */

import { useEffect } from 'react';

type KeyHandler = (event: KeyboardEvent) => void;

interface RegisteredHandler {
  combo: string;
  handler: KeyHandler;
  /** True if combo contains a space — requires sequence accumulator. */
  isSequence: boolean;
}

const handlers: RegisteredHandler[] = [];
const SEQUENCE_TIMEOUT_MS = 1000;
let sequenceBuffer: string[] = [];
let sequenceTimer: ReturnType<typeof setTimeout> | null = null;
let listenerAttached = false;

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Normalize a combo string to a stable internal key:
 *   'Cmd+K' / 'cmd+k' / 'meta+k' → 'meta+k' (or 'control+k' on non-mac if intent was modifier-K).
 *   Single chars stay lowercase: 'A' → 'a'. */
function normalizeCombo(combo: string): string {
  return combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .map((p) => (p === 'cmd' ? 'meta' : p === 'ctrl' ? 'control' : p))
    .map((p) => (p === 'option' || p === 'opt' ? 'alt' : p))
    .map((p) => (p === 'esc' ? 'escape' : p))
    .map((p) => (p === 'space' ? ' ' : p))
    .join('+');
}

function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push('meta');
  if (e.ctrlKey) parts.push('control');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && e.key.length > 1) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    /* Allow Esc + Cmd-K through even when an input is focused — they're
     * navigation, not text. */
    return true;
  }
  return false;
}

function clearSequence(): void {
  sequenceBuffer = [];
  if (sequenceTimer) {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const combo = eventToCombo(e);
  const target = e.target;

  /* Modifier combos always run, even from inside inputs (Cmd+K, Esc, etc.). */
  for (const h of handlers) {
    if (!h.isSequence && h.combo === combo) {
      /* Skip plain-letter combos when the user is typing in a field. */
      if (!combo.includes('+') && combo !== 'escape' && isEditableTarget(target)) continue;
      h.handler(e);
    }
  }

  /* Sequence accumulation only for unmodified plain letters. */
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1) return;
  if (isEditableTarget(target)) return;

  sequenceBuffer.push(e.key.toLowerCase());
  if (sequenceTimer) clearTimeout(sequenceTimer);
  sequenceTimer = setTimeout(clearSequence, SEQUENCE_TIMEOUT_MS);

  const candidate = sequenceBuffer.join(' ');
  for (const h of handlers) {
    if (h.isSequence && h.combo === candidate) {
      e.preventDefault();
      h.handler(e);
      clearSequence();
      return;
    }
  }
  /* Sequence buffer trimming: if no handler is a prefix match, reset. */
  const hasPrefix = handlers.some(
    (h) => h.isSequence && h.combo.startsWith(candidate + ' '),
  );
  if (!hasPrefix) clearSequence();
}

function ensureListener(): void {
  if (listenerAttached || typeof document === 'undefined') return;
  listenerAttached = true;
  document.addEventListener('keydown', onKeyDown);
}

/** Register a hotkey. Returns an unregister function. */
export function registerHotkey(combo: string, handler: KeyHandler): () => void {
  const normalized = normalizeCombo(combo);
  const isSequence = normalized.includes(' ');
  const entry: RegisteredHandler = { combo: normalized, handler, isSequence };

  if (import.meta.env.DEV) {
    const conflict = handlers.find((h) => h.combo === normalized);
    if (conflict) {
      /* eslint-disable-next-line no-console */
      console.warn(`[hotkeys] duplicate registration for "${combo}"; latest wins.`);
    }
  }

  handlers.push(entry);
  ensureListener();
  return () => {
    const idx = handlers.indexOf(entry);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/** React hook for component-scoped hotkey registration. */
export function useHotkey(combo: string, handler: KeyHandler, deps: ReadonlyArray<unknown> = []): void {
  useEffect(() => {
    return registerHotkey(combo, handler);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, deps);
}

/** Format a combo for display, e.g. 'meta+k' → '⌘K' on mac, 'Ctrl+K' on other. */
export function formatCombo(combo: string): string {
  const mac = isMac();
  return normalizeCombo(combo)
    .split('+')
    .map((p) => {
      if (p === 'meta') return mac ? '⌘' : 'Ctrl';
      if (p === 'control') return mac ? '⌃' : 'Ctrl';
      if (p === 'alt') return mac ? '⌥' : 'Alt';
      if (p === 'shift') return mac ? '⇧' : 'Shift';
      if (p === 'escape') return 'Esc';
      if (p === ' ') return 'Space';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(mac ? '' : '+');
}

/* Test hook — clears all registrations and the sequence buffer. */
export function _resetHotkeysForTest(): void {
  handlers.length = 0;
  clearSequence();
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', onKeyDown);
  }
  listenerAttached = false;
}
