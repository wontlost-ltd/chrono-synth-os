/**
 * SetupChecklist — floating bottom-right progress companion.
 *
 * Five canonical first-run steps (create persona, add knowledge, grant tools,
 * have first conversation, invite team). Steps with a `to` field navigate
 * via react-router; the parent app provides completion data via the
 * `steps` prop so the checklist stays a pure presentational component.
 *
 * Visibility rules:
 *  - Hidden completely once `dismissed=true` is persisted in localStorage,
 *    or once every step is completed. The user can re-open from a future
 *    settings page; this component doesn't manage that surface.
 *  - On the auth pages (/login, /register) the parent should not render
 *    this component at all — we don't add path filtering here to keep
 *    composition explicit.
 *
 * Accessibility:
 *  - The collapsed state is a button with aria-expanded; the expanded panel
 *    is rendered as a region with aria-labelledby pointing at the header.
 *  - Each step is a list item; completed ones use aria-label="completed"
 *    so screen readers announce progress.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { track } from '../../lib/analytics';

export interface SetupChecklistStep {
  id: string;
  /** Translation key under the `setupChecklist.steps` namespace */
  labelKey: string;
  /** Internal route to take the user to when they click an unfinished step */
  to: string;
  completed: boolean;
}

interface SetupChecklistProps {
  steps: SetupChecklistStep[];
  /** Allow the host app to override the storage key per-tenant if needed */
  storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'chrono.setup-checklist.v1';

interface PersistedState {
  dismissed: boolean;
  collapsed: boolean;
}

function readState(key: string): PersistedState {
  if (typeof window === 'undefined') return { dismissed: false, collapsed: true };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { dismissed: false, collapsed: true };
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      dismissed: !!parsed.dismissed,
      collapsed: !!parsed.collapsed,
    };
  } catch {
    return { dismissed: false, collapsed: true };
  }
}

function writeState(key: string, state: PersistedState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* private mode / quota — ignore */
  }
}

export function SetupChecklist({ steps, storageKey = DEFAULT_STORAGE_KEY }: SetupChecklistProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const [state, setState] = useState<PersistedState>(() => readState(storageKey));

  const completedCount = useMemo(() => steps.filter((s) => s.completed).length, [steps]);
  const total = steps.length;
  const allDone = total > 0 && completedCount === total;

  useEffect(() => {
    if (allDone) track('onboarding.checklist.completed', { total });
  }, [allDone, total]);

  if (state.dismissed || allDone || total === 0) return null;

  const updateState = (patch: Partial<PersistedState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeState(storageKey, next);
      return next;
    });
  };

  const progress = Math.round((completedCount / total) * 100);

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[min(92vw,320px)]">
      {state.collapsed ? (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-surface-elevated px-4 py-3 text-left text-sm shadow-lg hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          aria-expanded={false}
          aria-controls={headingId}
          onClick={() => {
            updateState({ collapsed: false });
            track('onboarding.checklist.expanded');
          }}
        >
          <span className="font-medium text-text-primary">{t('setupChecklist.title')}</span>
          <span className="text-xs text-text-secondary">
            {completedCount}/{total}
          </span>
        </button>
      ) : (
        <section
          aria-labelledby={headingId}
          className="rounded-xl border border-border bg-surface-elevated shadow-xl"
        >
          <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
            <div className="min-w-0">
              <h2 id={headingId} className="text-sm font-semibold text-text-primary">
                {t('setupChecklist.title')}
              </h2>
              <p className="mt-0.5 text-xs text-text-secondary">
                {t('setupChecklist.subtitle', { completed: completedCount, total })}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded p-1 text-text-secondary hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                aria-label={t('setupChecklist.collapse')}
                onClick={() => {
                  updateState({ collapsed: true });
                  track('onboarding.checklist.collapsed');
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <button
                type="button"
                className="rounded p-1 text-text-secondary hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                aria-label={t('setupChecklist.dismiss')}
                onClick={() => {
                  updateState({ dismissed: true });
                  track('onboarding.checklist.dismissed', { completed: completedCount, total });
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </header>

          <div
            className="h-1 bg-border overflow-hidden"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('setupChecklist.progressLabel', { progress })}
          >
            <div
              className="h-full w-full origin-left bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
              style={{ transform: `scaleX(${progress / 100})` }}
            />
          </div>

          <ul className="px-2 py-2">
            {steps.map((step) => (
              <li key={step.id}>
                <Link
                  to={step.to}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  onClick={() => {
                    if (!step.completed) {
                      track('onboarding.step.clicked', { step_id: step.id });
                    }
                  }}
                >
                  <StepIcon completed={step.completed} />
                  <span
                    className={
                      step.completed
                        ? 'text-text-secondary line-through'
                        : 'text-text-primary'
                    }
                    aria-label={step.completed ? t('setupChecklist.completed') : undefined}
                  >
                    {t(step.labelKey)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StepIcon({ completed }: { completed: boolean }) {
  if (completed) {
    return (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full bg-success text-white"
        aria-hidden
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12l5 5L20 7" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface"
      aria-hidden
    />
  );
}

/** Default 5-step set described in the P1.7.2 plan. The host page passes
 *  a `completed` boolean per step computed from the user's actual state. */
export const DEFAULT_SETUP_STEPS: ReadonlyArray<Omit<SetupChecklistStep, 'completed'>> = [
  { id: 'create_persona', labelKey: 'setupChecklist.steps.createPersona', to: '/personas' },
  { id: 'add_knowledge', labelKey: 'setupChecklist.steps.addKnowledge', to: '/knowledge-sources' },
  { id: 'grant_tools', labelKey: 'setupChecklist.steps.grantTools', to: '/admin/tool-permissions' },
  { id: 'first_conversation', labelKey: 'setupChecklist.steps.firstConversation', to: '/dashboard' },
  { id: 'invite_team', labelKey: 'setupChecklist.steps.inviteTeam', to: '/settings' },
];
