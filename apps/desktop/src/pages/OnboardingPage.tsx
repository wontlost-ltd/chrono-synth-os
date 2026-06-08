/**
 * EP-2.4 PR C — desktop first-launch onboarding.
 *
 * Three-step wizard shown the first time the desktop app opens. After
 * completion the user sees PersonaListPage like before; the gate in
 * App.tsx checks `app_settings.onboarding.first_run_completed` and
 * skips this page on every subsequent launch.
 *
 * Step contract:
 *   1. welcome     — explain what ChronoSynth desktop does
 *   2. mode-select — local-first vs sync-with-cloud (writes
 *                    chrono.api.baseUrl to localStorage if cloud)
 *   3. done        — confirm; mark first_run_completed
 *
 * Why English-only literals (no i18n harness on this repo yet):
 * The desktop repo doesn't ship an i18n setup. Adding react-i18next
 * here is a separate piece of work — see "Out of scope" in the PR
 * description. The phrase shown is the same English the rest of this
 * SPA uses (TitleBar, Sidebar). When desktop gets i18n, this file
 * gets the same `t()` migration the web pages did in P0.4.
 */

import { useState } from 'react';
import { markFirstRunCompleted } from '../bridge/tauri-commands';
import { setApiBaseUrl } from '../bridge/http-client';

type Step = 'welcome' | 'mode-select' | 'done';
const STEPS: Step[] = ['welcome', 'mode-select', 'done'];

type Mode = 'local' | 'cloud';

export interface OnboardingPageProps {
  /** onboarding 完成回调。App 用它 bump boot nonce 重跑启动序列（探测 plan → ready）。 */
  readonly onComplete?: () => void;
}

export function OnboardingPage({ onComplete }: OnboardingPageProps = {}) {
  const [step, setStep] = useState<Step>('welcome');
  const [mode, setMode] = useState<Mode | null>(null);
  const [cloudUrl, setCloudUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  function selectMode(m: Mode) {
    setMode(m);
    setError(null);
  }

  async function handleModeNext() {
    if (mode === 'cloud') {
      const trimmed = cloudUrl.trim();
      if (!trimmed) {
        setError('Please enter a chrono-synth-os URL');
        return;
      }
      try {
        // sanity: must parse as URL with http/https
        const u = new URL(trimmed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          setError('URL must use http or https');
          return;
        }
        setApiBaseUrl(trimmed);
      } catch {
        setError('That doesn\'t look like a valid URL');
        return;
      }
    }
    setError(null);
    setStep('done');
  }

  async function handleFinish() {
    setBusy(true);
    setError(null);
    try {
      await markFirstRunCompleted();
      /* 通知 App 重跑 boot 序列进入主应用（按 plan 渲染企业版/companion）。 */
      onComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-chrono-surface px-4">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-chrono-text-primary">ChronoSynth</h1>
          <p className="mt-1 text-xs text-chrono-text-secondary">Desktop Edition</p>
        </div>

        <div
          className="mb-6 flex gap-1"
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-label={`Step ${stepIndex + 1} of ${STEPS.length}`}
        >
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? 'bg-chrono-primary' : 'bg-chrono-border'}`}
            />
          ))}
        </div>

        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-6">
          {step === 'welcome' && (
            <>
              <h2 className="mb-2 text-lg font-medium text-chrono-text-primary">Welcome</h2>
              <p className="mb-6 text-sm text-chrono-text-secondary">
                ChronoSynth Desktop runs your persona locally with end-to-end encrypted
                storage. You can keep everything on this device, or sync with a
                ChronoSynth OS server you (or your team) operate.
              </p>
              <button
                onClick={() => setStep('mode-select')}
                className="w-full rounded-lg bg-chrono-primary px-4 py-2 text-sm text-white hover:opacity-90"
              >
                Get started
              </button>
            </>
          )}

          {step === 'mode-select' && (
            <>
              <h2 className="mb-2 text-lg font-medium text-chrono-text-primary">Pick a mode</h2>
              <p className="mb-4 text-sm text-chrono-text-secondary">
                You can change this later in Settings.
              </p>
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => selectMode('local')}
                  className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                    mode === 'local'
                      ? 'border-chrono-primary bg-chrono-primary/5'
                      : 'border-chrono-border hover:border-chrono-primary/50'
                  }`}
                >
                  <p className="font-medium text-chrono-text-primary">Local-only</p>
                  <p className="mt-0.5 text-xs text-chrono-text-secondary">
                    Everything stays on this device. No network calls, no
                    server dependency.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => selectMode('cloud')}
                  className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                    mode === 'cloud'
                      ? 'border-chrono-primary bg-chrono-primary/5'
                      : 'border-chrono-border hover:border-chrono-primary/50'
                  }`}
                >
                  <p className="font-medium text-chrono-text-primary">Sync with ChronoSynth OS</p>
                  <p className="mt-0.5 text-xs text-chrono-text-secondary">
                    Connect to a ChronoSynth OS server you run. Personas + memory
                    sync; conflicts surface in the Conflicts page.
                  </p>
                </button>
              </div>
              {mode === 'cloud' && (
                <div className="mt-4 space-y-1">
                  <label htmlFor="cloud-url" className="text-xs font-medium text-chrono-text-secondary">
                    Server URL
                  </label>
                  <input
                    id="cloud-url"
                    type="url"
                    value={cloudUrl}
                    onChange={(e) => setCloudUrl(e.target.value)}
                    placeholder="https://chrono.example.com"
                    className="w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-1.5 text-sm text-chrono-text-primary"
                  />
                </div>
              )}
              {error && <p className="mt-3 text-sm text-amber-400" role="alert">{error}</p>}
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => setStep('welcome')}
                  className="flex-1 rounded-lg border border-chrono-border px-4 py-2 text-sm text-chrono-text-secondary hover:bg-chrono-surface"
                >
                  Back
                </button>
                <button
                  onClick={handleModeNext}
                  disabled={mode === null}
                  className="flex-1 rounded-lg bg-chrono-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <h2 className="mb-2 text-lg font-medium text-chrono-text-primary">You're set</h2>
              <p className="mb-6 text-sm text-chrono-text-secondary">
                {mode === 'cloud'
                  ? 'On launch the app will sync with your server in the background. The Sync badge in the title bar shows live status.'
                  : 'The app starts in local-only mode. You can connect a server later in Settings.'}
              </p>
              {error && <p className="mb-3 text-sm text-amber-400" role="alert">{error}</p>}
              <button
                onClick={handleFinish}
                disabled={busy}
                className="w-full rounded-lg bg-chrono-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Open ChronoSynth'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
