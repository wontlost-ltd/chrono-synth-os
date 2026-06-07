import { useState, useSyncExternalStore } from 'react';
import { HomeView } from './views/HomeView.js';
import { GrowthView } from './views/GrowthView.js';
import { MemoriesView } from './views/MemoriesView.js';
import { LoginView } from './views/LoginView.js';
import { subscribeAuth, isAuthenticated, logout } from './auth.js';

type Tab = 'home' | 'growth' | 'memories';

/** 订阅外部 auth store，登录/登出时驱动整壳重渲染。 */
function useAuthed(): boolean {
  return useSyncExternalStore(subscribeAuth, isAuthenticated, isAuthenticated);
}

/**
 * Companion 最小外壳（roadmap Phase 2.2 alpha）：未登录显示登录页；登录后两个 tab —
 *「我的数字人」+「成长」。鉴权用 Bearer access token（auth.ts），401 自动刷新一次。
 */
export function App(): JSX.Element {
  const authed = useAuthed();
  const [tab, setTab] = useState<Tab>('home');

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__brand">ChronoCompanion</h1>
        <p className="app__tagline">你的自学习数字人</p>
        {authed && (
          <button className="app__logout" type="button" onClick={() => void logout()}>
            登出
          </button>
        )}
      </header>

      {!authed ? (
        <main className="app__main"><LoginView /></main>
      ) : (
        <>
          <nav className="tabs" role="tablist" aria-label="主导航">
            <button
              role="tab" id="tab-home" aria-controls="panel-home"
              aria-selected={tab === 'home'}
              className={tab === 'home' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
              onClick={() => setTab('home')}
            >
              我的数字人
            </button>
            <button
              role="tab" id="tab-growth" aria-controls="panel-growth"
              aria-selected={tab === 'growth'}
              className={tab === 'growth' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
              onClick={() => setTab('growth')}
            >
              成长
            </button>
            <button
              role="tab" id="tab-memories" aria-controls="panel-memories"
              aria-selected={tab === 'memories'}
              className={tab === 'memories' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
              onClick={() => setTab('memories')}
            >
              记忆
            </button>
          </nav>

          <main className="app__main">
            {tab === 'home' && (
              <div role="tabpanel" id="panel-home" aria-labelledby="tab-home"><HomeView /></div>
            )}
            {tab === 'growth' && (
              <div role="tabpanel" id="panel-growth" aria-labelledby="tab-growth"><GrowthView /></div>
            )}
            {tab === 'memories' && (
              <div role="tabpanel" id="panel-memories" aria-labelledby="tab-memories"><MemoriesView /></div>
            )}
          </main>
        </>
      )}
    </div>
  );
}
