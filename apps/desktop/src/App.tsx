import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OnboardingPage } from './pages/OnboardingPage';
import { EnterpriseRoutes } from './routers/EnterpriseRoutes';
import { CompanionRoutes } from './routers/CompanionRoutes';
import { getFirstRunCompleted, openDatabase } from './bridge/tauri-commands';
import { resolveAccountPlan } from './plan/account-plan-runtime';
import type { AccountPlan } from './plan/account-plan';

/* P0-G Desktop boot sequence (Step 3 of GA remediation) + ADR-0046 Phase 2.4a plan 切换：
 *
 * State machine:
 *   - "opening-db"     — calling Rust `open_database` (loads/creates
 *                        SQLCipher key from platform keyring, applies
 *                        PRAGMA key, runs migrations)
 *   - "db-error"       — open_database failed (e.g. Linux without
 *                        Secret Service); render a controlled error
 *                        screen with the actionable Rust-side message
 *   - "checking"       — DB open; query first-run flag
 *   - "first-run"      — onboarding未完成；router seeds /onboarding
 *   - "resolving-plan" — DB open + onboarded；探测账号 plan（服务端权威 + 本地缓存）
 *   - "ready"          — plan 已定；按 plan 渲染 enterprise / companion router
 *
 * Key invariants:
 *   - DB failure 是硬错误（SOC2 CC6.1 data-at-rest），绝不回退 onboarding 静默绕过加密边界。
 *   - plan 探测失败不阻断启动：resolveAccountPlan 内部已回退本地缓存 / unconfigured，
 *     desktop 始终能进入（离线优先）。unconfigured 默认走企业版路由（= 今日本地行为）。
 */
type GateState = 'opening-db' | 'db-error' | 'checking' | 'first-run' | 'resolving-plan' | 'ready';

export function App() {
  const [gate, setGate] = useState<GateState>('opening-db');
  const [dbError, setDbError] = useState<string | null>(null);
  const [plan, setPlan] = useState<AccountPlan>('unconfigured');
  /* onboarding 完成后递增以重跑 boot 序列：此时 first_run_completed 已为真，
   * 序列会跳过 onboarding → 探测 plan → ready。避免「完成 onboarding 却卡在 onboarding」
   * （Codex PR-A Critical：旧实现靠单 MemoryRouter 的 navigate('/')，新状态机需显式重查）。 */
  const [bootNonce, setBootNonce] = useState(0);

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

      let onboarded: boolean;
      try {
        onboarded = await getFirstRunCompleted();
      } catch (err) {
        /* DB is open but the app_settings query failed unexpectedly.
         * Surface the error rather than silently falling back; an
         * unreadable settings table is a real bug, not a fresh install. */
        if (!cancelled) {
          setDbError(err instanceof Error ? err.message : String(err));
          setGate('db-error');
        }
        return;
      }
      if (cancelled) return;
      if (!onboarded) {
        setGate('first-run');
        return;
      }

      /* 已 onboard：探测 plan 决定渲染哪套外壳。resolveAccountPlan 设计为不抛（失败回退缓存/
       * unconfigured）；这里再包一层 try 兜底——即便未来它意外抛出，也降级 unconfigured（→ 企业版），
       * 绝不把 App 卡在 resolving-plan（Codex PR-A Critical：防启动死锁）。 */
      setGate('resolving-plan');
      let resolved: AccountPlan;
      try {
        resolved = await resolveAccountPlan();
      } catch {
        resolved = 'unconfigured';
      }
      if (cancelled) return;
      setPlan(resolved);
      setGate('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [bootNonce]);

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
        <p className="max-w-md text-sm text-chrono-text-secondary">{dbError ?? 'Unknown error'}</p>
        <p className="max-w-md text-xs text-chrono-text-tertiary">
          ChronoSynth requires platform secure-storage to read its encrypted local database. On
          Linux, ensure a Secret Service implementation (gnome-keyring, kwallet) is running.
        </p>
      </div>
    );
  }

  if (gate === 'opening-db' || gate === 'checking' || gate === 'resolving-plan') {
    const message =
      gate === 'opening-db'
        ? 'Opening secure database…'
        : gate === 'resolving-plan'
          ? '正在加载你的账号…'
          : 'Loading…';
    return (
      <div
        className="flex h-screen items-center justify-center bg-chrono-surface text-sm text-chrono-text-secondary"
        role="status"
        aria-live="polite"
      >
        {message}
      </div>
    );
  }

  if (gate === 'first-run') {
    /* onboarding 完成后 bump nonce 重跑 boot（此时 first_run_completed=真 → 直接探测 plan → ready），
     * 而不是靠路由内部 navigate——后者在新状态机下 gate 仍是 first-run，会把用户带回 onboarding。 */
    return <OnboardingPage onComplete={() => setBootNonce((n) => n + 1)} />;
  }

  /* ready：按 plan 渲染。companion = 个人版精简外壳；enterprise / unconfigured = 企业版（本地优先默认）。 */
  return (
    <MemoryRouter initialEntries={['/']}>
      {plan === 'companion' ? <CompanionRoutes plan={plan} /> : <EnterpriseRoutes />}
    </MemoryRouter>
  );
}
