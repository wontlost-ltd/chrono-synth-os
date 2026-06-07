import { useState } from 'react';
import { HomeView } from './views/HomeView.js';
import { GrowthView } from './views/GrowthView.js';

type Tab = 'home' | 'growth';

/**
 * Companion 最小外壳（roadmap Phase 2.2 alpha）：两个 tab —「我的数字人」+「成长」。
 * 鉴权沿用既有会话；本切片不含登录页（后端 plan 门控 + ApiAuthError 提示已足够证明闭环）。
 */
export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('home');
  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__brand">ChronoCompanion</h1>
        <p className="app__tagline">你的自学习数字人</p>
      </header>

      <nav className="tabs" role="tablist" aria-label="主导航">
        <button
          role="tab"
          aria-selected={tab === 'home'}
          className={tab === 'home' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
          onClick={() => setTab('home')}
        >
          我的数字人
        </button>
        <button
          role="tab"
          aria-selected={tab === 'growth'}
          className={tab === 'growth' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
          onClick={() => setTab('growth')}
        >
          成长
        </button>
      </nav>

      <main className="app__main">
        {tab === 'home' ? <HomeView /> : <GrowthView />}
      </main>
    </div>
  );
}
