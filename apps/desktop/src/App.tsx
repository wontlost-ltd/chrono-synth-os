import { useEffect, useState } from 'react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './layout/Layout';
import { AgentOauthGooglePage } from './pages/AgentOauthGooglePage';
import { AgentPendingConfirmationsPage } from './pages/AgentPendingConfirmationsPage';
import { ConflictsPage } from './pages/ConflictsPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { PersonaListPage } from './pages/PersonaListPage';
import { SafetyDriftPage } from './pages/SafetyDriftPage';
import { SettingsPage } from './pages/SettingsPage';
import { getFirstRunCompleted, openDatabase } from './bridge/tauri-commands';

/* P0-G Desktop boot sequence (Step 3 of GA remediation):
 *
 * State machine:
 *   - "opening-db"    — calling Rust `open_database` (loads/creates
 *                       SQLCipher key from platform keyring, applies
 *                       PRAGMA key, runs migrations)
 *   - "db-error"      — open_database failed (e.g. Linux without
 *                       Secret Service); render a controlled error
 *                       screen with the actionable Rust-side message
 *   - "checking"      — DB open; query first-run flag
 *   - "first-run"     — onboarding未完成；router seeds /onboarding
 *   - "ready"         — router seeds /
 *
 * Key change vs prior version: we NO LONGER treat "first-run" as the
 * fallback when the DB call fails. A DB failure is a hard error — the
 * encrypted DB is required for SOC2 CC6.1 data-at-rest, so falling back
 * to onboarding would silently bypass the encryption boundary.
 */
type GateState = 'opening-db' | 'db-error' | 'checking' | 'first-run' | 'ready';

export function App() {
  const [gate, setGate] = useState<GateState>('opening-db');
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await openDatabase();
      } catch (err) {
        if (cancelled) return;
        setDbError(err instanceof Error ? err.message : String(err));
        setGate('db-error');
        return;
      }
      if (cancelled) return;
      setGate('checking');

      try {
        const done = await getFirstRunCompleted();
        if (cancelled) return;
        setGate(done ? 'ready' : 'first-run');
      } catch (err) {
        /* DB is open but the app_settings query failed unexpectedly.
         * Surface the error rather than silently falling back; an
         * unreadable settings table is a real bug, not a fresh install. */
        if (!cancelled) {
          setDbError(err instanceof Error ? err.message : String(err));
          setGate('db-error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (gate === 'db-error') {
    return (
      <div
        className="flex h-screen flex-col items-center justify-center gap-3 bg-chrono-surface px-6 text-center"
        role="alert"
        aria-live="assertive"
      >
        <h1 className="text-lg font-semibold text-chrono-text-primary">
          Couldn't open the encrypted database
        </h1>
        <p className="max-w-md text-sm text-chrono-text-secondary">
          {dbError ?? 'Unknown error'}
        </p>
        <p className="max-w-md text-xs text-chrono-text-tertiary">
          ChronoSynth requires platform secure-storage to read its
          encrypted local database. On Linux, ensure a Secret Service
          implementation (gnome-keyring, kwallet) is running.
        </p>
      </div>
    );
  }

  if (gate === 'opening-db' || gate === 'checking') {
    return (
      <div
        className="flex h-screen items-center justify-center bg-chrono-surface text-sm text-chrono-text-secondary"
        role="status"
        aria-live="polite"
      >
        {gate === 'opening-db' ? 'Opening secure database…' : 'Loading…'}
      </div>
    );
  }

  return (
    <MemoryRouter initialEntries={[gate === 'first-run' ? '/onboarding' : '/']}>
      <Routes>
        {/* Onboarding renders without the Layout (no Sidebar/TitleBar). */}
        <Route path="/onboarding" element={<OnboardingPage />} />
        {/* Everything else inside Layout. */}
        <Route
          path="/*"
          element={
            <Layout>
              <Routes>
                <Route path="/" element={<PersonaListPage />} />
                <Route path="/conflicts" element={<ConflictsPage />} />
                <Route path="/safety/drift" element={<SafetyDriftPage />} />
                <Route path="/agent/oauth/google" element={<AgentOauthGooglePage />} />
                <Route path="/agent/confirmations" element={<AgentPendingConfirmationsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}
