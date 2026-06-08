import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-chrono-surface text-chrono-text-primary">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto bg-chrono-surface">
          <div className="mx-auto w-full max-w-7xl p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
