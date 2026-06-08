/**
 * ChronoCompanion 外壳布局 (ADR-0046 Phase 2.4a)。
 *
 * 与企业版 Layout/Sidebar 刻意区分：个人版导航只有「我的数字人 / 成长 / 设置」三项，
 * 没有 Conflicts/Approvals/Google Auth 等治理入口。复用 TitleBar（窗口控制与企业版一致）。
 */

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { NavLink } from 'react-router-dom';
import { TitleBar } from './TitleBar';

interface CompanionNavItem {
  to: string;
  icon: string;
  label: string;
}

const navItems: CompanionNavItem[] = [
  { to: '/', icon: '🪞', label: '我的数字人' },
  { to: '/growth', icon: '🌱', label: '成长' },
  { to: '/settings', icon: '⚙', label: '设置' },
];

export function CompanionLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-chrono-surface text-chrono-text-primary">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Companion navigation"
          className="flex w-56 shrink-0 flex-col border-r border-chrono-border bg-chrono-surface"
        >
          <div className="flex h-16 items-center gap-3 border-b border-chrono-border px-4">
            <div
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-chrono-primary text-base text-white shadow-sm shadow-chrono-primary/30"
            >
              🪞
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-chrono-text-primary">ChronoCompanion</div>
              <div className="truncate text-xs text-chrono-text-secondary">你的数字人</div>
            </div>
          </div>

          <nav className="flex-1 space-y-1 px-3 py-4">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                aria-label={item.label}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                    isActive
                      ? 'bg-chrono-primary text-white shadow-sm shadow-chrono-primary/20'
                      : 'text-chrono-text-secondary hover:bg-chrono-elevated hover:text-chrono-text-primary',
                  )
                }
              >
                <span aria-hidden="true" className="w-5 text-center text-base">
                  {item.icon}
                </span>
                <span className="flex-1">{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto bg-chrono-surface">
          <div className="mx-auto w-full max-w-4xl p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
