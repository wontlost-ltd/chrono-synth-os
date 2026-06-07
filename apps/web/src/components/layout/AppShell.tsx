import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './Sidebar';
import { SetupChecklistContainer } from '../onboarding/SetupChecklistContainer';
import { ChangelogDrawer } from '../changelog/ChangelogDrawer';
import { CommandPalette } from '../cmdk/CommandPalette';
import { DEFAULT_COMMANDS } from '../cmdk/defaultCommands';
import { useHotkey } from '../../lib/hotkeys';
import { useFeatureFlag } from '../../lib/featureFlags';
import { PageTransition } from '../motion/PageTransition';
import { ThemeSwitcher } from '../ThemeSwitcher';
import { LevelUpCelebration } from '../../features/growth/LevelUpCelebration';
import { WelcomeIntro } from '../../features/growth/WelcomeIntro';
import { useAuth } from '../../hooks/useAuth';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  /* Feature flags gate the surface. Default ON; flip via localStorage
   * key 'chrono.flag.<id>' = 'false' or via remote provider. */
  const cmdkEnabled = useFeatureFlag('cmdk.enabled', true);
  const checklistEnabled = useFeatureFlag('onboarding.checklist.enabled', true);
  const changelogEnabled = useFeatureFlag('changelog.drawer.enabled', true);

  /* Vim-style g+key navigation. Each command in DEFAULT_COMMANDS already
   * declares its own hotkey; we register them once at the shell level so
   * they work from anywhere inside the authenticated surface. */
  useHotkey('g d', () => navigate('/dashboard'));
  useHotkey('g p', () => navigate('/personas'));
  useHotkey('g s', () => navigate('/simulations'));
  useHotkey('g v', () => navigate('/values'));
  useHotkey('g k', () => navigate('/knowledge-sources'));
  useHotkey('g a', () => navigate('/admin/config'));

  const closeMobile = useCallback(() => {
    setMobileOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    const focusable = drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { closeMobile(); return; }
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }

    drawer.addEventListener('keydown', handleKeyDown);
    return () => drawer.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen, closeMobile]);

  return (
    <div className="flex min-h-dvh overflow-hidden">
      <a href="#main-content" className="skip-link">
        {t('appShell.skipToMain')}
      </a>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 lg:hidden"
          style={{ backgroundColor: 'var(--color-overlay, rgba(0,0,0,0.4))' }}
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-20 rounded-lg bg-surface-elevated p-2 shadow-sm lg:hidden"
        aria-label={t('appShell.openNav')}
        aria-expanded={mobileOpen}
        aria-controls="nav-drawer"
      >
        ☰
      </button>

      <div
        ref={drawerRef}
        id="nav-drawer"
        role="dialog"
        aria-modal={mobileOpen || undefined}
        aria-label={t('appShell.navMenu')}
        className={`fixed inset-y-0 left-0 z-40 transition-transform lg:static lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(v => !v)} onClose={closeMobile} />
      </div>

      <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto p-6 pt-14 lg:pt-6 outline-none" aria-hidden={mobileOpen || undefined} inert={mobileOpen || undefined}>
        <div className="flex justify-end mb-2">
          <ThemeSwitcher />
        </div>
        <PageTransition>{children}</PageTransition>
      </main>

      {/* P1.7.2 onboarding companion. Hides itself once dismissed or all
        * five steps complete; sits on top of main content with z-40. */}
      {checklistEnabled && <SetupChecklistContainer />}
      {/* P1.7.2 changelog drawer (bottom-left); auto-opens once after each
        * release, then user controls via the trigger button. */}
      {changelogEnabled && <ChangelogDrawer />}
      {/* P2.6 global command palette (Cmd/Ctrl+K). Self-renders only when
        * open; safe to mount unconditionally. */}
      {cmdkEnabled && <CommandPalette commands={DEFAULT_COMMANDS} />}

      {/* P3.7 narrative onboarding: 3-segment intro on first auth visit, plus
        * level-up celebrations whenever the user crosses a capability boundary.
        * Both gate themselves on auth so unauthenticated /sso/callback etc.
        * don't trigger them. */}
      {isAuthenticated && <WelcomeIntro />}
      {isAuthenticated && <LevelUpCelebration />}
    </div>
  );
}
