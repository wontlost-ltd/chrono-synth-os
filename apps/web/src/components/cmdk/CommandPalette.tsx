/**
 * CommandPalette — global ⌘K / Ctrl+K palette.
 *
 * Pure React + Tailwind, no cmdk dep. Search is a fuzzy substring match
 * with a small score: contiguous matches > scattered, prefix matches >
 * mid-string. Recently-used commands surface first when the query is
 * empty.
 *
 * Usage:
 *   <CommandPalette commands={...} />
 * The palette opens on cmd+k / ctrl+k; consumers don't have to wire a
 * trigger button (they can if they want).
 *
 * Accessibility:
 *   - Dialog with role="dialog" + aria-modal="true".
 *   - Search input is autofocused when the palette opens.
 *   - Up/Down arrows move highlight; Enter activates; Esc closes.
 *   - Each result has aria-selected reflecting the highlight.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useHotkey, formatCombo } from '../../lib/hotkeys';
import { track } from '../../lib/analytics';

export interface PaletteCommand {
  id: string;
  /** Translation key for the visible label */
  labelKey: string;
  /** Optional translation key for a one-line hint */
  hintKey?: string;
  /** Internal route */
  to?: string;
  /** Imperative action */
  onSelect?: () => void;
  /** Bucket label for grouping; e.g. 'navigation', 'actions' */
  group?: string;
  /** Optional hotkey combo for the right-aligned chip */
  hotkey?: string;
  /** Searchable keywords beyond the label (untranslated, lowercase) */
  keywords?: string[];
}

interface CommandPaletteProps {
  commands: ReadonlyArray<PaletteCommand>;
}

const RECENT_KEY = 'chrono.cmdk.recent.v1';
const RECENT_LIMIT = 5;

function readRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_LIMIT)));
  } catch {
    /* storage unavailable */
  }
}

function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) {
    /* Prefix match scores highest, then earlier-position substring. */
    const idx = t.indexOf(q);
    return 1000 - idx;
  }
  /* Scattered character match — every query char must appear in order. */
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    score += 50 - (found - ti);
    ti = found + 1;
  }
  return Math.max(score, 1);
}

export function CommandPalette({ commands }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dialogId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);

  useHotkey('cmd+k', (e) => {
    e.preventDefault();
    setOpen((v) => !v);
    track('cmdk.toggled', { via: 'hotkey' });
  });
  useHotkey('ctrl+k', (e) => {
    e.preventDefault();
    setOpen((v) => !v);
    track('cmdk.toggled', { via: 'hotkey' });
  });
  useHotkey('escape', () => {
    if (open) setOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    setQuery('');
    setHighlight(0);
    /* Autofocus after the input is in the tree */
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) {
      const recentSet = new Set(recent);
      const recentCmds = recent
        .map((id) => commands.find((c) => c.id === id))
        .filter((c): c is PaletteCommand => !!c);
      const rest = commands.filter((c) => !recentSet.has(c.id));
      return [...recentCmds, ...rest];
    }
    const scored = commands
      .map((c) => {
        const haystack = [t(c.labelKey), c.hintKey ? t(c.hintKey) : '', ...(c.keywords ?? [])]
          .join(' ')
          .toLowerCase();
        return { cmd: c, score: fuzzyScore(query, haystack) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [query, commands, recent, t]);

  function activate(cmd: PaletteCommand) {
    track('cmdk.command.selected', { command_id: cmd.id });
    /* Update recents — most recent first, dedupe. */
    const next = [cmd.id, ...recent.filter((id) => id !== cmd.id)].slice(0, RECENT_LIMIT);
    writeRecent(next);
    setRecent(next);
    setOpen(false);
    if (cmd.onSelect) cmd.onSelect();
    if (cmd.to) navigate(cmd.to);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[highlight];
      if (target) activate(target);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogId}
        data-testid="cmdk-palette"
        className="w-[min(92vw,560px)] overflow-hidden rounded-xl border border-border bg-surface-elevated shadow-2xl"
      >
        <div className="border-b border-border px-4 py-3">
          <label htmlFor={`${dialogId}-input`} className="sr-only" id={dialogId}>
            {t('cmdk.searchLabel')}
          </label>
          <input
            ref={inputRef}
            id={`${dialogId}-input`}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t('cmdk.placeholder')}
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <ul
          role="listbox"
          aria-label={t('cmdk.resultsLabel')}
          className="max-h-[60vh] overflow-y-auto py-2"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-text-secondary">
              {t('cmdk.empty')}
            </li>
          ) : (
            filtered.map((cmd, i) => (
              <li
                key={cmd.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => activate(cmd)}
                onMouseEnter={() => setHighlight(i)}
                className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm ${
                  i === highlight ? 'bg-primary/10 text-text-primary' : 'text-text-primary hover:bg-surface'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{t(cmd.labelKey)}</div>
                  {cmd.hintKey && (
                    <div className="truncate text-xs text-text-secondary">{t(cmd.hintKey)}</div>
                  )}
                </div>
                {cmd.hotkey && (
                  <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-text-secondary">
                    {formatCombo(cmd.hotkey)}
                  </kbd>
                )}
              </li>
            ))
          )}
        </ul>

        <footer className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-text-secondary">
          <div className="flex items-center gap-3">
            <span><kbd className="rounded border border-border bg-surface px-1.5 py-0.5">↑↓</kbd> {t('cmdk.help.move')}</span>
            <span><kbd className="rounded border border-border bg-surface px-1.5 py-0.5">↵</kbd> {t('cmdk.help.select')}</span>
            <span><kbd className="rounded border border-border bg-surface px-1.5 py-0.5">Esc</kbd> {t('cmdk.help.close')}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
