import clsx from 'clsx';
import { NavLink } from 'react-router-dom';
import { SyncBadge } from '@/components/SyncBadge';
import { useSyncState } from '@/hooks/useSyncState';

interface NavItem {
  to: string;
  icon: string;
  label: string;
}

const navItems: NavItem[] = [
  { to: '/', icon: '👥', label: 'Personas' },
  { to: '/conflicts', icon: '⚠', label: 'Conflicts' },
  { to: '/safety/drift', icon: '🛡', label: 'AI Safety' },
  { to: '/agent/confirmations', icon: '✋', label: 'Approvals' },
  { to: '/agent/oauth/google', icon: '🔑', label: 'Google Auth' },
  { to: '/settings', icon: '⚙', label: 'Settings' },
];

export function Sidebar() {
  const { data: syncState } = useSyncState();
  const conflictCount = syncState?.conflict_count ?? 0;

  return (
    <aside
      aria-label="Primary navigation"
      className="flex w-64 shrink-0 flex-col border-r border-chrono-border bg-chrono-surface"
    >
      <div className="flex h-16 items-center gap-3 border-b border-chrono-border px-4">
        <div
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-chrono-primary text-sm font-bold text-white shadow-sm shadow-chrono-primary/30"
        >
          CS
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-chrono-text-primary">ChronoSynth</div>
          <div className="truncate text-xs text-chrono-text-secondary">Desktop Runtime</div>
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
            {/* Emoji icons are decorative; aria-hidden so screen readers say
              * the label once rather than emoji + label. NavLink's
              * aria-current="page" is set automatically when isActive. */}
            <span aria-hidden="true" className="w-5 text-center text-base">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.to === '/conflicts' && conflictCount > 0 ? (
              <span
                aria-label={`${conflictCount} conflicts pending`}
                className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
              >
                {conflictCount}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-chrono-border p-4">
        <SyncBadge state={syncState?.state ?? 'initial_sync'} />
      </div>
    </aside>
  );
}
