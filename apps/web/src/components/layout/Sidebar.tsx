import { useState, useCallback, type SVGProps } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { useLogout } from '../../api/queries/auth';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';

type IconKey =
  | 'dashboard' | 'list' | 'plus' | 'avatar' | 'brain' | 'gem' | 'book'
  | 'cart' | 'gauge' | 'card' | 'building' | 'wrench' | 'sliders' | 'logout';

interface NavItem {
  to: string;
  labelKey: string;
  icon: IconKey;
  adminOnly?: boolean;
}

interface NavGroup {
  id: string;
  labelKey?: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'top',
    items: [
      { to: '/dashboard', labelKey: 'sidebar.dashboard', icon: 'dashboard' },
      { to: '/simulations', labelKey: 'sidebar.simulations', icon: 'list' },
      { to: '/simulations/new', labelKey: 'sidebar.newSimulation', icon: 'plus' },
    ],
  },
  {
    id: 'agents',
    labelKey: 'sidebar.groups.agents',
    items: [
      { to: '/avatars', labelKey: 'sidebar.avatars', icon: 'avatar' },
      { to: '/persona-core', labelKey: 'sidebar.personaCore', icon: 'brain' },
      { to: '/values', labelKey: 'sidebar.values', icon: 'gem' },
      { to: '/knowledge-sources', labelKey: 'sidebar.knowledgeSources', icon: 'book' },
      { to: '/marketplace', labelKey: 'sidebar.marketplace', icon: 'cart' },
    ],
  },
  {
    id: 'ops',
    labelKey: 'sidebar.groups.ops',
    items: [
      { to: '/system', labelKey: 'sidebar.systemStatus', icon: 'gauge' },
      { to: '/billing', labelKey: 'sidebar.billing', icon: 'card' },
      { to: '/enterprise', labelKey: 'sidebar.enterprise', icon: 'building', adminOnly: true },
      { to: '/settings', labelKey: 'sidebar.settings', icon: 'sliders' },
      { to: '/admin/config', labelKey: 'sidebar.adminConfig', icon: 'wrench', adminOnly: true },
    ],
  },
];

function Icon({ name, className = '' }: { name: IconKey; className?: string }) {
  const common: SVGProps<SVGSVGElement> = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className,
  };
  switch (name) {
    case 'dashboard': return <svg {...common}><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>;
    case 'list':      return <svg {...common}><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h12"/></svg>;
    case 'plus':      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>;
    case 'avatar':    return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>;
    case 'brain':     return <svg {...common}><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 3 3 3 0 0 0 2 3v1a3 3 0 0 0 3 3 3 3 0 0 0 3-3V4z"/><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 3 3 3 0 0 1-2 3v1a3 3 0 0 1-3 3 3 3 0 0 1-3-3V4z"/></svg>;
    case 'gem':       return <svg {...common}><path d="M5 5h14l3 5-10 11L2 10z"/><path d="M5 5l5 5-5 0M19 5l-5 5 5 0M12 21l-2-11h4z"/></svg>;
    case 'book':      return <svg {...common}><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>;
    case 'cart':      return <svg {...common}><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M3 4h2l2.5 12h12l2-9H6"/></svg>;
    case 'gauge':     return <svg {...common}><path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/></svg>;
    case 'card':      return <svg {...common}><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>;
    case 'building':  return <svg {...common}><path d="M4 21V5a2 2 0 0 1 2-2h7v18"/><path d="M13 9h5a2 2 0 0 1 2 2v10H13"/><path d="M7 7h3M7 11h3M7 15h3M16 13h0M16 17h0"/></svg>;
    case 'wrench':    return <svg {...common}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z"/></svg>;
    case 'sliders':   return <svg {...common}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0"/><circle cx="16" cy="6" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="18" cy="18" r="1.5"/></svg>;
    case 'logout':    return <svg {...common}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>;
  }
}

function getInitialCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem('sidebar-groups');
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch { /* 忽略 */ }
  return {};
}

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
  onClose?: () => void;
}

export function Sidebar({ collapsed, onToggle, onClose }: SidebarProps) {
  const { t } = useTranslation();
  const { isAuthenticated, user } = useAuth();
  const logout = useLogout();
  const [groupCollapsed, setGroupCollapsed] = useState(getInitialCollapsed);

  const toggleGroup = useCallback((groupId: string) => {
    setGroupCollapsed(prev => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      localStorage.setItem('sidebar-groups', JSON.stringify(next));
      return next;
    });
  }, []);

  const renderItem = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      aria-label={collapsed ? t(item.labelKey) : undefined}
      className={({ isActive }) =>
        `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150 ${
          isActive
            ? 'nav-active-rail bg-[rgba(99,102,241,0.08)] font-medium text-text-primary'
            : 'text-text-secondary hover:bg-[rgba(99,102,241,0.04)] hover:text-text-primary'
        }`
      }
    >
      <Icon name={item.icon} className="shrink-0 opacity-90" />
      {!collapsed && <span>{t(item.labelKey)}</span>}
    </NavLink>
  );

  const isAdmin = user?.role === 'admin';

  return (
    <aside className={`flex h-full flex-col border-r border-border bg-surface-elevated transition-[width] duration-200 ease-out motion-reduce:transition-none ${collapsed ? 'w-16' : 'w-60'}`}>
      <div className="flex h-14 items-center justify-between border-b border-border px-4" style={{ background: 'linear-gradient(180deg, rgba(99, 102, 241, 0.04) 0%, transparent 100%)' }}>
        {!collapsed && (
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: 'var(--gradient-brand)', boxShadow: '0 0 16px rgba(99, 102, 241, 0.5)' }} aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h14v3l-8 8 8 8v3H5v-3l8-8L5 6z"/></svg>
            </span>
            <span className="text-[15px] font-bold tracking-tight text-gradient-brand">ChronoSynth</span>
          </div>
        )}
        <div className="flex gap-1">
          {onClose && (
            <button
              onClick={onClose}
              className="rounded p-1 text-text-tertiary hover:bg-[rgba(99,102,241,0.08)] hover:text-text-primary lg:hidden"
              aria-label={t('sidebar.closeNav')}
            >
              ✕
            </button>
          )}
          <button
            onClick={onToggle}
            className="hidden rounded p-1 text-text-tertiary hover:bg-[rgba(99,102,241,0.08)] hover:text-text-primary lg:block"
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          >
            {collapsed ? '▶' : '◀'}
          </button>
        </div>
      </div>

      {!collapsed && user && (
        <div className="mx-3 mt-3 mb-1 rounded-lg border border-border px-3 py-2 text-[11px]" style={{ background: 'var(--gradient-brand-soft)' }}>
          <div className="text-text-tertiary uppercase tracking-wider">Tenant</div>
          <div className="font-mono text-text-primary truncate" title={user.email}>{user.email}</div>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto p-2" aria-label={t('sidebar.mainNav')}>
        {NAV_GROUPS.map((group, idx) => {
          const visibleItems = group.items.filter(item => !item.adminOnly || isAdmin);
          if (!visibleItems.length) return null;

          const isCollapsedGroup = !!groupCollapsed[group.id];

          return (
            <div key={group.id} className={idx > 0 ? 'mt-3 border-t border-border pt-2' : 'mb-1'}>
              {group.labelKey && !collapsed && (
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-tertiary hover:text-text-primary"
                >
                  <span>{t(group.labelKey)}</span>
                  <span aria-hidden="true" className="text-[10px]">{isCollapsedGroup ? '▸' : '▾'}</span>
                </button>
              )}
              {(!group.labelKey || !isCollapsedGroup || collapsed) && visibleItems.map(renderItem)}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        {!collapsed && <div className="mb-2"><LanguageSwitcher /></div>}
        {isAuthenticated && (
          <button
            onClick={() => logout.mutate()}
            aria-label={t('sidebar.logout')}
            title={collapsed ? t('sidebar.logout') : undefined}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-[rgba(99,102,241,0.06)] hover:text-text-primary"
          >
            <Icon name="logout" className="shrink-0" />
            {!collapsed && <span>{t('sidebar.logout')}</span>}
          </button>
        )}
      </div>
    </aside>
  );
}
